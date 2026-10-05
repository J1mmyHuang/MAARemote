import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PUSH_RETRY_LIMIT,
  buildNotificationPayload,
  buildVapidJwt,
  createPushService,
  decryptWebPushPayload,
  encryptWebPushPayload,
  publicKeyToUncompressed,
  validateSubscription,
  verifyVapidJwt,
} from '../src/push.js';

const RFC_VECTOR = {
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  receiverPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  receiverPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  senderPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  encrypted: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

function tmpPath() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'maaremote-push-test-'));
}

function fixedJwk(privateKey, publicKey) {
  const point = Buffer.from(publicKey, 'base64url');
  return {
    kty: 'EC',
    crv: 'P-256',
    x: point.subarray(1, 33).toString('base64url'),
    y: point.subarray(33).toString('base64url'),
    d: privateKey,
  };
}

function createVapidKeys() {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey: pair.privateKey.export({ format: 'jwk' }),
    publicKey: pair.publicKey.export({ format: 'jwk' }),
  };
}

function subscriptionFromVector() {
  return {
    endpoint: 'https://push.example.test/push/test-subscription',
    keys: { p256dh: RFC_VECTOR.receiverPublic, auth: RFC_VECTOR.auth },
  };
}

function event(id, status = 'success', type = 'LinkStart-Base') {
  return {
    id,
    kind: 'task_finished',
    created_at: 1_800_000_000_000,
    detail: JSON.stringify({ task_id: `task-${id}`, type, status, duration_ms: 12_345 }),
  };
}

test('订阅校验只接受 HTTPS endpoint 和正确长度的 base64url keys', () => {
  const valid = subscriptionFromVector();
  assert.deepEqual(validateSubscription(valid), valid);
  assert.throws(() => validateSubscription({ ...valid, endpoint: 'http://push.example.test/x' }), /endpoint/);
  assert.throws(() => validateSubscription({ ...valid, keys: { ...valid.keys, auth: 'short' } }), /auth/);
  assert.throws(() => validateSubscription({ ...valid, keys: { ...valid.keys, p256dh: '%%%%' } }), /p256dh/);
  assert.throws(() => validateSubscription({ ...valid, keys: { ...valid.keys, p256dh: valid.keys.p256dh.slice(0, -2) } }), /p256dh/);
});

test('VAPID JWT 使用 ES256、endpoint origin aud 和不超过 24 小时的 exp', () => {
  const keys = createVapidKeys();
  const result = buildVapidJwt('https://push.example.test/push/a?opaque=1', keys, { now: 1_800_000_000_000 });
  const [headerPart, payloadPart] = result.token.split('.');
  const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  assert.equal(header.alg, 'ES256');
  assert.equal(header.typ, 'JWT');
  assert.equal(payload.aud, 'https://push.example.test');
  assert.ok(payload.exp > 1_800_000_000 && payload.exp <= 1_800_000_000 + 24 * 60 * 60);
  assert.equal(verifyVapidJwt(result.token, keys.publicKey), true);
  assert.equal(result.publicKey, publicKeyToUncompressed(keys.publicKey).toString('base64url'));
});

test('RFC 8291 Appendix A 的 aes128gcm 加密向量完全匹配', () => {
  const subscription = subscriptionFromVector();
  const encrypted = encryptWebPushPayload(
    Buffer.from('When I grow up, I want to be a watermelon', 'utf8'),
    subscription,
    {
      authSecret: Buffer.from(RFC_VECTOR.auth, 'base64url'),
      salt: Buffer.from(RFC_VECTOR.salt, 'base64url'),
      senderPrivateKey: fixedJwk(RFC_VECTOR.senderPrivate, RFC_VECTOR.senderPublic),
    },
  );
  assert.equal(encrypted.body.toString('base64url'), RFC_VECTOR.encrypted);
});

test('Web Push 加密可以用订阅私钥按同一协议解密往返', () => {
  const receiver = crypto.createECDH('prime256v1');
  receiver.generateKeys();
  const subscription = {
    endpoint: 'https://push.example.test/push/roundtrip',
    keys: {
      p256dh: receiver.getPublicKey('base64url', 'uncompressed'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  };
  const encrypted = encryptWebPushPayload(Buffer.from('{"ok":true}', 'utf8'), subscription);
  const plaintext = decryptWebPushPayload(encrypted.body, receiver.getPrivateKey(), subscription.keys.auth);
  assert.equal(plaintext.toString('utf8'), '{"ok":true}');
});

test('服务端只对 success/failed task_finished 发送，载荷字段和任务名称固定', async () => {
  const dir = await tmpPath();
  const sent = [];
  const service = createPushService({
    storagePath: path.join(dir, 'push.json'),
    sendRequest: async (request) => {
      const plaintext = decryptWebPushPayload(
        request.body,
        Buffer.from(RFC_VECTOR.receiverPrivate, 'base64url'),
        Buffer.from(RFC_VECTOR.auth, 'base64url'),
      );
      sent.push({ ...request, decryptedPayload: JSON.parse(plaintext.toString('utf8')) });
      return { status: 201 };
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  await service.addSubscription(subscriptionFromVector());
  await service.handleEvent({ id: 1, kind: 'online', detail: '{}' });
  for (const kind of ['task_queued', 'task_dispatched', 'task_running', 'HeartBeat', 'CaptureImageNow']) {
    await service.handleEvent({ id: 1 + kind.length, kind, detail: '{}' });
  }
  await service.handleEvent({ id: 99, kind: 'task_finished', detail: JSON.stringify({ task_id: 'ignored', type: 'LinkStart', status: 'running', duration_ms: 1 }) });
  await service.handleEvent(event(2, 'success', 'LinkStart-Base'));
  await service.handleEvent(event(3, 'failed', 'LinkStart-Combat'));
  assert.equal(sent.length, 2);
  assert.deepEqual(Object.keys(sent[0].decryptedPayload).sort(), ['body', 'event_id', 'task_id', 'title', 'url']);
  assert.equal(sent[0].decryptedPayload.title, '基建换班：成功');
  assert.equal(sent[0].decryptedPayload.body, '耗时 12 秒');
  assert.equal(sent[1].decryptedPayload.title, '理智作战：失败');
  assert.equal(sent[0].decryptedPayload.url, '/');
  assert.equal(sent[0].headers['content-encoding'], 'aes128gcm');
  assert.equal(sent[0].headers.ttl, '300');
  assert.match(sent[0].headers.topic, /^maaremote-[A-Za-z0-9_-]+$/);
  await service.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('重复事件与重启不重发，日志和载荷不泄露敏感字段', async () => {
  const dir = await tmpPath();
  const logs = [];
  const sent = [];
  const options = {
    storagePath: path.join(dir, 'push.json'),
    sendRequest: async (request) => { sent.push(request); return { status: 201 }; },
    logger: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
  };
  const service = createPushService(options);
  await service.addSubscription({ ...subscriptionFromVector(), endpoint: 'https://push.example.test/secret-endpoint?token=do-not-log' });
  await service.handleEvent(event(10));
  await service.handleEvent(event(10));
  const restarted = createPushService(options);
  await restarted.handleEvent(event(10));
  assert.equal(sent.length, 1);
  const serialized = JSON.stringify({ payload: sent[0].payload, logs });
  for (const secret of ['do-not-log', 'maa-user', 'device-name', 'dashboardToken']) assert.doesNotMatch(serialized, new RegExp(secret));
  await service.close();
  await restarted.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('VAPID 密钥对损坏时安全重建并使旧订阅失效', async () => {
  const dir = await tmpPath();
  const storagePath = path.join(dir, 'push.json');
  const first = createPushService({ storagePath, logger: { info() {}, warn() {}, error() {} } });
  await first.addSubscription(subscriptionFromVector());
  const oldPublicKey = first.getVapidPublicKey();
  await first.close();
  const stored = JSON.parse(await fs.readFile(storagePath, 'utf8'));
  stored.vapid.publicKey = createVapidKeys().publicKey;
  await fs.writeFile(storagePath, JSON.stringify(stored), 'utf8');
  const logs = [];
  const rebuilt = createPushService({
    storagePath,
    logger: { info() {}, warn: (...args) => logs.push(args), error() {} },
  });
  assert.notEqual(rebuilt.getVapidPublicKey(), oldPublicKey);
  assert.equal(rebuilt.listSubscriptions().length, 0);
  assert.match(JSON.stringify(logs), /安全重建/);
  await rebuilt.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('404/410 清理订阅，429/5xx 只按固定上限重试', async () => {
  const dir = await tmpPath();
  let attempts = 0;
  const service = createPushService({
    storagePath: path.join(dir, 'push.json'),
    sleep: async () => {},
    sendRequest: async () => { attempts += 1; return { status: attempts <= PUSH_RETRY_LIMIT ? 503 : 201 }; },
    logger: { info() {}, warn() {}, error() {} },
  });
  await service.addSubscription(subscriptionFromVector());
  await service.handleEvent(event(20));
  assert.equal(attempts, PUSH_RETRY_LIMIT + 1);

  for (const [status, name, eventId] of [[404, 'gone-404.json', 21], [410, 'gone-410.json', 22]]) {
    const gone = createPushService({
      storagePath: path.join(dir, name),
      sendRequest: async () => ({ status }),
      logger: { info() {}, warn() {}, error() {} },
    });
    await gone.addSubscription(subscriptionFromVector());
    await gone.handleEvent(event(eventId));
    assert.equal(gone.listSubscriptions().length, 0);
    await gone.close();
  }
  await service.close();
  await fs.rm(dir, { recursive: true, force: true });
});
