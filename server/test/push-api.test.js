// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

import apiRoutes from '../src/routes/api.js';
import { createPushService } from '../src/push.js';

const subscription = {
  endpoint: 'https://push.example.test/api/subscription',
  keys: {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  },
};

async function buildApp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maaremote-push-api-'));
  const pushService = createPushService({ storagePath: path.join(dir, 'push.json'), logger: { info() {}, warn() {}, error() {} } });
  const app = Fastify();
  await app.register(apiRoutes, {
    prefix: '/api',
    config: { dashboardToken: 'dashboard-secret', offlineAfterSec: 5 },
    db: { prepare() { throw new Error('push API test should not touch SQLite'); } },
    bus: { on() {} },
    pushService,
  });
  t.after(async () => {
    await app.close();
    await pushService.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return app;
}

test('推送 API 未鉴权返回 401，公钥接口返回 base64url P-256 公钥', async (t) => {
  const app = await buildApp(t);
  const denied = await app.inject({ method: 'GET', url: '/api/push/vapid-public-key' });
  assert.equal(denied.statusCode, 401);

  const allowed = await app.inject({
    method: 'GET',
    url: '/api/push/vapid-public-key',
    headers: { authorization: 'Bearer dashboard-secret' },
  });
  assert.equal(allowed.statusCode, 200);
  const body = allowed.json();
  assert.equal(typeof body.publicKey, 'string');
  assert.equal(Buffer.from(body.publicKey, 'base64url').length, 65);
});

test('推送 API 接受、幂等更新、拒绝非法订阅并可取消', async (t) => {
  const app = await buildApp(t);
  const headers = { authorization: 'Bearer dashboard-secret', 'content-type': 'application/json' };
  const invalid = await app.inject({ method: 'POST', url: '/api/push/subscriptions', headers, payload: { endpoint: 'http://bad', keys: {} } });
  assert.equal(invalid.statusCode, 400);

  const first = await app.inject({ method: 'POST', url: '/api/push/subscriptions', headers, payload: subscription });
  assert.equal(first.statusCode, 200);
  const duplicate = await app.inject({ method: 'POST', url: '/api/push/subscriptions', headers, payload: subscription });
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.json().ok, true);

  const removed = await app.inject({ method: 'DELETE', url: '/api/push/subscriptions', headers, payload: { endpoint: subscription.endpoint } });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().removed, true);
});
