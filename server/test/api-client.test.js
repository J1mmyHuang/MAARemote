import assert from 'node:assert/strict';
import test from 'node:test';

async function loadApi(t) {
  try {
    return await import('../../web/js/api.js');
  } catch (error) {
    t.assert.fail(`缺少计划中的 web/js/api.js：${error.message}`);
  }
}

test('mapApiError 将鉴权、限流、设备和截图错误映射为中文反馈', async (t) => {
  const { mapApiError } = await loadApi(t);

  assert.equal(mapApiError({ status: 401 }), 'Token 无效或已过期，请重新设置');
  assert.equal(mapApiError({ status: 429, error: 'too_many_requests' }), '操作过于频繁，稍后再试');
  assert.equal(mapApiError({ status: 404, error: 'device_not_found' }), '未找到该设备，请重新选择设备');
  assert.equal(mapApiError({ status: 400, error: 'device_not_approved' }), '该设备尚未批准，请先在设备管理中批准');
  assert.equal(mapApiError({ status: 404, error: 'screenshot_not_found' }), '截图不存在或已被清理');
  assert.equal(mapApiError({ status: 404, error: 'screenshot_file_missing' }), '截图文件已丢失，请重新截图');
});

test('ApiClient 使用默认 fetch 时保留全局对象绑定', async (t) => {
  const { ApiClient } = await loadApi(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function windowBoundFetch() {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return Promise.resolve({
      status: 200,
      ok: true,
      text: async () => '{"devices":[],"events":[]}',
    });
  };

  try {
    const client = new ApiClient('test-token');
    assert.deepEqual(await client.getOverview(), { devices: [], events: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ApiClient 普通 fetch 使用 no-store 与 no-referrer', async (t) => {
  const { ApiClient } = await loadApi(t);
  let request;
  const client = new ApiClient({
    token: 'dashboard-secret',
    baseUrl: 'https://maa.example.test',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { status: 204, ok: true };
    },
  });

  await client.getOverview();

  assert.equal(request.url, 'https://maa.example.test/api/overview');
  assert.equal(request.init.headers.Authorization, 'Bearer dashboard-secret');
  assert.equal(request.init.cache, 'no-store');
  assert.equal(request.init.referrerPolicy, 'no-referrer');
  assert.doesNotMatch(request.url, /(?:[?&])token=/);
});

test('getScreenshotBlob 通过 Bearer fetch 返回 Blob 且请求 URL 不含 token', async (t) => {
  const { ApiClient } = await loadApi(t);
  const expected = new Blob(['png-bytes'], { type: 'image/png' });
  let request;
  const client = new ApiClient({
    token: 'long-lived-dashboard-secret',
    baseUrl: 'https://maa.example.test',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { status: 200, ok: true, blob: async () => expected };
    },
  });

  const actual = await client.getScreenshotBlob('42');

  assert.equal(actual, expected);
  assert.equal(request.url, 'https://maa.example.test/api/screenshots/42');
  assert.equal(request.init.headers.Authorization, 'Bearer long-lived-dashboard-secret');
  assert.equal(request.init.cache, 'no-store');
  assert.equal(request.init.referrerPolicy, 'no-referrer');
  assert.doesNotMatch(request.url, /(?:[?&])token=/);
});

test('getScreenshotBlob 非成功响应仍抛出 ApiClientError', async (t) => {
  const { ApiClient, ApiClientError } = await loadApi(t);
  const client = new ApiClient({
    token: 'dashboard-secret',
    fetchImpl: async () => ({
      status: 404,
      ok: false,
      text: async () => JSON.stringify({ error: 'screenshot_not_found' }),
    }),
  });

  await assert.rejects(
    client.getScreenshotBlob(7),
    (error) => {
      assert.ok(error instanceof ApiClientError);
      assert.equal(error.status, 404);
      assert.equal(error.error, 'screenshot_not_found');
      assert.equal(error.message, '截图不存在或已被清理');
      return true;
    },
  );
});

test('getScreenshotBlob 保留取消错误分类', async (t) => {
  const { ApiClient, ApiClientError } = await loadApi(t);
  const controller = new AbortController();
  const client = new ApiClient({
    token: 'dashboard-secret',
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted by test');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });

  const pending = client.getScreenshotBlob(8, { signal: controller.signal });
  controller.abort();

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof ApiClientError);
    assert.equal(error.kind, 'aborted');
    return true;
  });
});
