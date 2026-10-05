import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiClient } from '../../web/js/api.js';

test('ApiClient 提供 VAPID 公钥、订阅注册和取消接口且统一使用 Bearer', async () => {
  const requests = [];
  const client = new ApiClient({
    token: 'dashboard-secret',
    baseUrl: 'https://maa.example.test',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      const body = init.method === 'GET' ? { publicKey: 'public-key' } : { ok: true, removed: init.method === 'DELETE' };
      return { status: 200, ok: true, text: async () => JSON.stringify(body) };
    },
  });
  const subscription = { endpoint: 'https://push.example.test/sub', keys: { p256dh: 'p', auth: 'a' } };

  assert.deepEqual(await client.getPushVapidPublicKey(), { publicKey: 'public-key' });
  assert.deepEqual(await client.savePushSubscription(subscription), { ok: true, removed: false });
  assert.deepEqual(await client.deletePushSubscription(subscription.endpoint), { ok: true, removed: true });
  assert.deepEqual(requests.map(({ url, init }) => [url, init.method, init.headers.Authorization]), [
    ['https://maa.example.test/api/push/vapid-public-key', 'GET', 'Bearer dashboard-secret'],
    ['https://maa.example.test/api/push/subscriptions', 'POST', 'Bearer dashboard-secret'],
    ['https://maa.example.test/api/push/subscriptions', 'DELETE', 'Bearer dashboard-secret'],
  ]);
  assert.equal(JSON.parse(requests[1].init.body).endpoint, subscription.endpoint);
  assert.deepEqual(JSON.parse(requests[2].init.body), { endpoint: subscription.endpoint });
});
