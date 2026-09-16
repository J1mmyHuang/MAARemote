import assert from 'node:assert/strict';
import test from 'node:test';

async function loadApi(t) {
  try {
    return await import('../../web/js/api.js');
  } catch (error) {
    t.assert.fail(`缺少计划中的 web/js/api.js：${error.message}`);
  }
}

const encoder = new TextEncoder();

function byteByByteStream(text) {
  const bytes = encoder.encode(text);
  return new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
}

function singleChunkStream(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function responseFromStream(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    body,
  };
}

function waitFor(predicate, timeoutMs = 1500) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('等待流事件超时'));
        return;
      }
      setTimeout(check, 1);
    };
    check();
  });
}

function delay(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

test('openEvents 通过 Bearer fetch 解析分块 UTF8、CRLF、多行 data 与事件类型', async (t) => {
  const { ApiClient } = await loadApi(t);
  const requests = [];
  const received = [];
  let opened = 0;
  const payload = [
    'id: 41\r\n',
    'event: custom\r\n',
    'data: {"id":41,"device":"设备",\r\n',
    'data: "kind":"custom"}\r\n',
    '\r\n',
    ': ping\r\n',
    '\r\n',
  ].join('');
  const client = new ApiClient({
    token: 'long-lived-dashboard-secret',
    baseUrl: 'https://maa.example.test',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return responseFromStream(byteByByteStream(payload));
    },
    reconnectDelayMs: 1000,
  });

  const stream = client.openEvents({
    eventTypes: ['custom'],
    onEvent: (event, type) => received.push({ event, type }),
    onOpen: () => { opened += 1; },
  });
  t.after(() => stream.close());

  await waitFor(() => received.length === 1);

  assert.deepEqual(received, [{
    event: { id: 41, device: '设备', kind: 'custom' },
    type: 'custom',
  }]);
  assert.equal(opened, 1);
  assert.equal(requests[0].url, 'https://maa.example.test/api/events');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer long-lived-dashboard-secret');
  assert.equal(requests[0].init.headers.Accept, 'text/event-stream');
  assert.equal(requests[0].init.cache, 'no-store');
  assert.equal(requests[0].init.referrerPolicy, 'no-referrer');
  assert.doesNotMatch(requests[0].url, /(?:[?&])token=/);
});

test('onEvent close 阻止同一网络分块中的后续事件继续派发', async (t) => {
  const { ApiClient } = await loadApi(t);
  const received = [];
  let stream;
  const client = new ApiClient({
    token: 'dashboard-secret',
    fetchImpl: async () => responseFromStream(singleChunkStream(
      'event: custom\ndata: {"id":1}\n\nevent: custom\ndata: {"id":2}\n\n',
    )),
  });

  stream = client.openEvents({
    eventTypes: ['custom'],
    onEvent: (event) => {
      received.push(event.id);
      stream.close();
    },
    reconnectDelayMs: 0,
  });
  t.after(() => stream.close());

  await waitFor(() => received.length > 0);
  await delay(20);

  assert.deepEqual(received, [1]);
});

test('onOpen close 在安装 reader 前停止连接', async (t) => {
  const { ApiClient } = await loadApi(t);
  let stream;
  let readerCalls = 0;
  let aborted = false;
  const client = new ApiClient({
    token: 'dashboard-secret',
    fetchImpl: async (_url, init) => {
      init.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return responseFromStream({
        getReader() {
          readerCalls += 1;
          return {
            async read() { return { done: true, value: undefined }; },
            async cancel() {},
          };
        },
      });
    },
  });

  stream = client.openEvents({ onOpen: () => stream.close() });
  t.after(() => stream.close());
  await delay(20);

  assert.equal(readerCalls, 0);
  assert.equal(aborted, true);
});

test('openEvents 首推断开后自动重连并在 close 后停止', async (t) => {
  const { ApiClient } = await loadApi(t);
  const requests = [];
  const received = [];
  const errors = [];
  let opened = 0;
  let stream;
  const firstPayload = 'event: custom\ndata: {"id":1}\n\n';
  const secondPayload = 'event: custom\ndata: {"id":2}\n\n';
  const client = new ApiClient({
    token: 'dashboard-secret',
    baseUrl: 'https://maa.example.test',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (requests.length === 1) return responseFromStream(byteByByteStream(firstPayload));
      if (requests.length === 2) return responseFromStream(byteByByteStream(secondPayload));
      throw new Error('不应在 close 后发起第三次请求');
    },
    reconnectDelayMs: 0,
  });

  stream = client.openEvents({
    eventTypes: ['custom'],
    onEvent: (event) => {
      received.push(event.id);
      if (event.id === 2) stream.close();
    },
    onError: (error) => errors.push(error),
    onOpen: () => { opened += 1; },
  });
  t.after(() => stream.close());

  await waitFor(() => received.length === 2);
  await delay(30);

  assert.deepEqual(received, [1, 2]);
  assert.equal(opened, 2);
  assert.ok(errors.length >= 1);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, 'https://maa.example.test/api/events');
    assert.equal(request.init.headers.Authorization, 'Bearer dashboard-secret');
  }
});

test('openEvents 收到 401 时调用 onError 且停止自动重连', async (t) => {
  const { ApiClient, ApiClientError } = await loadApi(t);
  const errors = [];
  let requests = 0;
  const client = new ApiClient({
    token: 'dashboard-secret',
    fetchImpl: async () => {
      requests += 1;
      return {
        status: 401,
        ok: false,
        text: async () => JSON.stringify({ error: 'unauthorized' }),
      };
    },
    reconnectDelayMs: 0,
  });

  const stream = client.openEvents({ onError: (error) => errors.push(error) });
  t.after(() => stream.close());

  await waitFor(() => errors.length === 1);
  await delay(30);

  assert.equal(requests, 1);
  assert.ok(errors[0] instanceof ApiClientError);
  assert.equal(errors[0].status, 401);
  assert.equal(errors[0].error, 'unauthorized');
});

test('openEvents.close 取消正在进行的 fetch 且不触发错误或重连', async (t) => {
  const { ApiClient } = await loadApi(t);
  let started = false;
  let aborted = false;
  const errors = [];
  const client = new ApiClient({
    token: 'dashboard-secret',
    fetchImpl: async (_url, init) => {
      started = true;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          const error = new Error('aborted by close');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
    reconnectDelayMs: 0,
  });

  const stream = client.openEvents({ onError: (error) => errors.push(error) });
  await waitFor(() => started);
  stream.close();
  await waitFor(() => aborted);
  await delay(30);

  assert.equal(errors.length, 0);
  assert.equal(started, true);
});
