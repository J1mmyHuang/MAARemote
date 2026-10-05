// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  base64urlToUint8Array,
  enableBackgroundPush,
  getPushCapability,
  syncExistingPushSubscription,
} from '../../web/js/notify.js';

const swPath = fileURLToPath(new URL('../../cloudflare/p4b-assets/public/sw.js', import.meta.url));
const indexPath = fileURLToPath(new URL('../../web/index.html', import.meta.url));

test('后台推送只在 HTTPS 主屏幕 Web App 且能力齐全时继续', () => {
  let permissionRequests = 0;
  const env = {
    isSecureContext: true,
    location: { protocol: 'https:', hostname: 'maa.example.test' },
    matchMedia: () => ({ matches: false }),
    navigator: { standalone: false },
    Notification: { permission: 'default', requestPermission: async () => { permissionRequests += 1; return 'granted'; } },
  };
  const result = getPushCapability(env);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_standalone');
  assert.equal(permissionRequests, 0);
});

test('点击开启后台推送时请求权限、订阅并同步 API', async () => {
  let permissionRequests = 0;
  let subscribeOptions;
  const stored = new Map();
  const subscription = {
    endpoint: 'https://push.example.test/sub/1',
    toJSON: () => ({ endpoint: 'https://push.example.test/sub/1', keys: { p256dh: 'p256dh', auth: 'auth' } }),
  };
  const registration = {
    pushManager: {
      getSubscription: async () => null,
      subscribe: async (options) => { subscribeOptions = options; return subscription; },
    },
  };
  const env = {
    isSecureContext: true,
    location: { protocol: 'https:', hostname: 'maa.example.test' },
    matchMedia: (query) => ({ matches: query === '(display-mode: standalone)' }),
    navigator: {
      standalone: false,
      serviceWorker: {
        register: async () => registration,
        getRegistration: async () => registration,
      },
      PushManager: function PushManager() {},
    },
    Notification: { permission: 'default', requestPermission: async () => { permissionRequests += 1; env.Notification.permission = 'granted'; return 'granted'; } },
  };
  const api = {
    getPushVapidPublicKey: async () => ({ publicKey: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-Pw' }),
    savePushSubscription: async (value) => { stored.set('subscription', value); return { ok: true }; },
  };
  const result = await enableBackgroundPush({ api, env, storage: stored });
  assert.equal(result.ok, true);
  assert.equal(permissionRequests, 1);
  assert.equal(subscribeOptions.userVisibleOnly, true);
  assert.ok(subscribeOptions.applicationServerKey instanceof Uint8Array);
  assert.equal(stored.get('subscription').endpoint, subscription.endpoint);
  assert.equal(base64urlToUint8Array('AAECAw').length, 4);
});

test('浏览器拒绝后台推送订阅时显示明确原因', async () => {
  const env = {
    isSecureContext: true,
    location: { protocol: 'https:', hostname: 'maa.example.test' },
    matchMedia: () => ({ matches: true }),
    navigator: {
      standalone: false,
      serviceWorker: {
        register: async () => ({ pushManager: {
          getSubscription: async () => null,
          subscribe: async () => { throw Object.assign(new Error('permission denied'), { name: 'AbortError' }); },
        } }),
        getRegistration: async () => ({ pushManager: {
          getSubscription: async () => null,
          subscribe: async () => { throw Object.assign(new Error('permission denied'), { name: 'AbortError' }); },
        } }),
      },
      PushManager: function PushManager() {},
    },
    Notification: { permission: 'granted' },
  };
  const result = await enableBackgroundPush({
    api: { getPushVapidPublicKey: async () => ({ publicKey: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-Pw' }) },
    env,
    storage: new Map(),
  });
  assert.equal(result.code, 'push_permission_denied');
  assert.match(result.message, /拒绝|权限/);
});

test('Service Worker 注册失败时提示失败阶段且不暴露底层错误', async () => {
  const env = {
    isSecureContext: true,
    location: { protocol: 'https:', hostname: 'maa.example.test' },
    matchMedia: () => ({ matches: true }),
    navigator: {
      standalone: false,
      serviceWorker: {
        register: async () => { throw Object.assign(new Error('internal endpoint detail'), { name: 'SecurityError' }); },
        getRegistration: async () => null,
      },
      PushManager: function PushManager() {},
    },
    Notification: { permission: 'granted' },
  };
  const result = await enableBackgroundPush({
    api: { getPushVapidPublicKey: async () => ({ publicKey: 'unused' }) },
    env,
    storage: new Map(),
  });
  assert.equal(result.code, 'subscribe_failed');
  assert.match(result.message, /Service Worker/);
  assert.doesNotMatch(result.message, /internal endpoint detail|SecurityError/);
});

test('页面重新打开发现 VAPID 公钥变化时重建旧订阅', async () => {
  const oldKey = Uint8Array.from([9, 9, 9]);
  const currentKey = 'AAECAw';
  let unsubscribed = false;
  let subscribeOptions;
  const oldSubscription = {
    options: { applicationServerKey: oldKey },
    endpoint: 'https://push.example.test/sub/old',
    unsubscribe: async () => { unsubscribed = true; return true; },
  };
  const replacement = {
    endpoint: 'https://push.example.test/sub/new',
    toJSON: () => ({ endpoint: 'https://push.example.test/sub/new', keys: { p256dh: 'p256dh', auth: 'auth' } }),
  };
  const pushManager = {
    getSubscription: async () => oldSubscription,
    subscribe: async (options) => { subscribeOptions = options; return replacement; },
  };
  const env = {
    isSecureContext: true,
    location: { protocol: 'https:', hostname: 'maa.example.test' },
    matchMedia: () => ({ matches: true }),
    navigator: {
      standalone: false,
      serviceWorker: {
        getRegistration: async () => ({ pushManager }),
      },
    },
    Notification: { permission: 'granted' },
  };
  const stored = new Map();
  const result = await syncExistingPushSubscription({
    api: {
      getPushVapidPublicKey: async () => ({ publicKey: currentKey }),
      savePushSubscription: async (value) => { stored.set('subscription', value); return { ok: true }; },
    },
    env,
    storage: stored,
  });
  assert.equal(result.ok, true);
  assert.equal(unsubscribed, true);
  assert.equal(subscribeOptions.userVisibleOnly, true);
  assert.deepEqual([...subscribeOptions.applicationServerKey], [0, 1, 2, 3]);
  assert.equal(stored.get('subscription').endpoint, replacement.endpoint);
});

test('Service Worker 必须处理 push、pushsubscriptionchange 和 notificationclick', async () => {
  const source = await fs.readFile(swPath, 'utf8');
  assert.match(source, /addEventListener\(['"]push['"]/);
  assert.match(source, /showNotification\(/);
  assert.match(source, /addEventListener\(['"]pushsubscriptionchange['"]/);
  assert.match(source, /addEventListener\(['"]notificationclick['"]/);
  assert.doesNotMatch(source, /localStorage|dashboardToken|Authorization/);
});

test('index.html 声明主屏幕 Web App manifest', async () => {
  const source = await fs.readFile(indexPath, 'utf8');
  assert.match(source, /rel="manifest"/);
  assert.match(source, /manifest\.webmanifest/);
});

test('web/ 与边缘 Worker 目录中的四个公开静态文件内容一致', async () => {
  const names = ['sw.js', 'manifest.webmanifest', 'icons/icon-192.svg', 'icons/icon-512.svg'];
  for (const name of names) {
    const local = await fs.readFile(fileURLToPath(new URL('../../web/' + name, import.meta.url)));
    const edge = await fs.readFile(fileURLToPath(new URL('../../cloudflare/p4b-assets/public/' + name, import.meta.url)));
    assert.ok(local.equals(edge), name + ' 两处副本必须保持一致');
  }
});