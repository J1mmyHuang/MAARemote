// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  NOTIFY_SEEN_KEY,
  buildNotification,
  createTaskNotifier,
  deliverNotification,
  finishedCandidate,
  getPermissionState,
  planTaskNotifications,
  requestNotificationPermission,
} from '../../web/js/notify.js';

const NOW = 1_800_000_000_000;
const LABELS = { 'LinkStart-Base': '基建换班', LinkStart: '一键除草' };
const label = (type) => LABELS[type] ?? type;

function finished(id, taskId, { type = 'LinkStart-Base', status = 'success', duration = 65_000, at = NOW - 1000, device = 'secret-device' } = {}) {
  return {
    id,
    device,
    kind: 'task_finished',
    created_at: at,
    detail: JSON.stringify({ task_id: taskId, type, status, duration_ms: duration }),
  };
}

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

function fakeEnv(permission = 'granted') {
  const env = { isSecureContext: true, Notification: function Notification() {} };
  env.Notification.permission = permission;
  env.Notification.requestPermission = async () => env.Notification.permission;
  return env;
}

const knownSeen = (...keys) => ({ v: 1, keys });

test('成功与失败的 task_finished 通知含任务名称、结果和任务级耗时', () => {
  const ok = buildNotification(finishedCandidate(finished(7, 'task-a')), label);
  assert.equal(ok.title, '基建换班：成功');
  assert.equal(ok.body, '耗时 1 分 5 秒');
  const bad = buildNotification(finishedCandidate(finished(8, 'task-b', { status: 'failed', duration: 12_000, type: 'LinkStart' })), label);
  assert.equal(bad.title, '一键除草：失败');
  assert.equal(bad.body, '耗时 12 秒');
  const unknown = buildNotification(finishedCandidate(finished(9, 'task-c', { duration: null })), label);
  assert.equal(unknown.body, '耗时 未知');
});

test('通知内容不含设备名、token 或 URL 参数', () => {
  const event = finished(1, 'task-a', { device: 'dev-SECRET' });
  event.detail = JSON.stringify({ task_id: 'task-a', type: 'LinkStart', status: 'success', duration_ms: 1000, token: 'TOKEN-123', user: 'maa-user' });
  const note = buildNotification(finishedCandidate(event), label);
  const text = JSON.stringify(note);
  for (const secret of ['dev-SECRET', 'TOKEN-123', 'maa-user', 'token=']) assert.ok(!text.includes(secret), secret);
});

test('后台推送已声明送达时，页面重连不应再次显示同一任务', async () => {
  const result = await deliverNotification(
    { key: 'task:already-pushed', title: '基建换班：成功', body: '耗时 1 秒', tag: 'maaremote-task-already-pushed' },
    fakeEnv('granted'),
    async () => false,
  );
  assert.equal(result, 'duplicate');
});

test('只处理 task_finished；中间状态与未知状态不通知', () => {
  const events = ['online', 'offline', 'task_started', 'task_stale', 'screenshot_saved', 'device_approved']
    .map((kind, index) => ({ id: index + 1, kind, created_at: NOW, detail: JSON.stringify({ task_id: 't' + index, type: 'LinkStart', status: 'success' }) }));
  events.push(finished(50, 't-unknown', { status: 'queued' }));
  const plan = planTaskNotifications({ events, seen: knownSeen(), now: NOW, canDeliver: true, label });
  assert.equal(plan.notifications.length, 0);
});

test('同一 task_id 或 event_id 重复事件只通知一次，含同批重复', () => {
  const batch = [finished(5, 'task-a'), finished(5, 'task-a'), finished(6, 'task-a')];
  const first = planTaskNotifications({ events: batch, seen: knownSeen(), now: NOW, canDeliver: true, label });
  assert.equal(first.notifications.length, 1);
  const second = planTaskNotifications({ events: batch, seen: first.nextSeen, now: NOW, canDeliver: true, label });
  assert.equal(second.notifications.length, 0);
  assert.equal(second.stats.duplicate, 3);

  const noTask = { id: 77, kind: 'task_finished', created_at: NOW, detail: JSON.stringify({ type: 'LinkStart', status: 'failed', duration_ms: 5 }) };
  const a = planTaskNotifications({ events: [noTask], seen: knownSeen(), now: NOW, canDeliver: true, label });
  assert.equal(a.notifications.length, 1);
  const b = planTaskNotifications({ events: [noTask], seen: a.nextSeen, now: NOW, canDeliver: true, label });
  assert.equal(b.notifications.length, 0);
});

test('首次同步只建立基线，历史事件不通知，之后只通知新增', () => {
  const history = [finished(1, 'old-1'), finished(2, 'old-2')];
  const first = planTaskNotifications({ events: history, seen: null, now: NOW, canDeliver: true, label });
  assert.equal(first.notifications.length, 0);
  assert.equal(first.stats.baseline, true);
  const next = planTaskNotifications({ events: [...history, finished(3, 'new-1')], seen: first.nextSeen, now: NOW, canDeliver: true, label });
  assert.deepEqual(next.notifications.map((n) => n.tag), ['maaremote-task-new-1']);
});

test('离线补发：窗口外不补发，窗口内最多逐条 3 个，其余合并为 1 条汇总', () => {
  const events = [
    finished(1, 'too-old', { at: NOW - 31 * 60_000 }),
    finished(2, 'a', { at: NOW - 5 * 60_000 }),
    finished(3, 'b', { at: NOW - 4 * 60_000, status: 'failed' }),
    finished(4, 'c', { at: NOW - 3 * 60_000 }),
    finished(5, 'd', { at: NOW - 2 * 60_000, status: 'failed' }),
    finished(6, 'e', { at: NOW - 1 * 60_000 }),
  ];
  const plan = planTaskNotifications({ events, seen: knownSeen(), now: NOW, canDeliver: true, label });
  assert.equal(plan.stats.stale, 1);
  assert.equal(plan.notifications.length, 4);
  assert.equal(plan.notifications[0].tag, 'maaremote-task-summary');
  assert.match(plan.notifications[0].title, /另有 2 个任务已结束/);
  assert.match(plan.notifications[0].body, /成功 1 · 失败 1/);
  assert.deepEqual(plan.notifications.slice(1).map((n) => n.tag), ['maaremote-task-c', 'maaremote-task-d', 'maaremote-task-e']);
  assert.ok(plan.nextSeen.keys.includes('task:too-old'));
});

test('无权限或暂停时只记账，不在之后补发', () => {
  const events = [finished(1, 'a'), finished(2, 'b')];
  const muted = planTaskNotifications({ events, seen: knownSeen(), now: NOW, canDeliver: false, label });
  assert.equal(muted.notifications.length, 0);
  assert.equal(muted.stats.suppressed, 2);
  const later = planTaskNotifications({ events, seen: muted.nextSeen, now: NOW, canDeliver: true, label });
  assert.equal(later.notifications.length, 0);
});

test('已通知键最多保留 200 个', () => {
  const events = Array.from({ length: 260 }, (_, i) => finished(i + 1, 'k' + i, { at: NOW }));
  const plan = planTaskNotifications({ events, seen: knownSeen(), now: NOW, canDeliver: false, label });
  assert.equal(plan.nextSeen.keys.length, 200);
});

test('权限四态：不支持 / 未请求 / 已授权 / 已拒绝，不支持时请求不抛错', async () => {
  assert.equal(getPermissionState({}), 'unsupported');
  assert.equal(getPermissionState({ Notification: fakeEnv().Notification, isSecureContext: false }), 'unsupported');
  for (const permission of ['default', 'granted', 'denied']) assert.equal(getPermissionState(fakeEnv(permission)), permission);
  assert.equal(await requestNotificationPermission({}), 'unsupported');
  const throwing = fakeEnv('default');
  throwing.Notification.requestPermission = async () => { throw new Error('blocked'); };
  assert.equal(await requestNotificationPermission(throwing), 'default');
});

test('通知器：真实去重、重载后不重复、拒绝与暂停不崩溃', async () => {
  const storage = memoryStorage();
  const shown = [];
  const make = (env, getNow = () => NOW) => createTaskNotifier({ storage, env, getNow, label, deliver: async (note) => { shown.push(note); return 'worker'; } });
  const env = fakeEnv('granted');
  let notifier = make(env);

  const base = await notifier.process([finished(1, 'old')]);
  assert.equal(base.baseline, true);
  assert.equal(shown.length, 0);

  await notifier.process([finished(2, 'new')]);
  await notifier.process([finished(2, 'new'), finished(1, 'old')]);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, '基建换班：成功');

  notifier = make(env); // 页面重载：状态来自 localStorage
  await notifier.process([finished(2, 'new'), finished(1, 'old')]);
  assert.equal(shown.length, 1);

  notifier.setEnabled(false);
  await notifier.process([finished(3, 'paused')]);
  notifier.setEnabled(true);
  await notifier.process([finished(3, 'paused')]);
  assert.equal(shown.length, 1);

  const denied = make(fakeEnv('denied'));
  const result = await denied.process([finished(4, 'denied-task')]);
  assert.equal(result.suppressed, 1);
  const none = make({});
  assert.equal(none.permission(), 'unsupported');
  await none.process([finished(5, 'unsupported-task')]);
  assert.equal(shown.length, 1);

  notifier.reset();
  assert.equal(storage.getItem(NOTIFY_SEEN_KEY), null);
});

test('存储损坏或不可用时安全退回基线，不抛错也不刷屏', async () => {
  const skewShown = [];
  const skewed = createTaskNotifier({ storage: memoryStorage(), env: fakeEnv('granted'), getNow: () => NOW + 3 * 3_600_000, label, deliver: async (n) => { skewShown.push(n); return 'worker'; } });
  await skewed.process([]);
  await skewed.process([finished(1, 'seed')]);
  await skewed.process([finished(2, 'late-clock', { at: NOW - 1000 })]);
  assert.equal(skewShown.length, 0, '本机时钟快 3 小时且未校准时，新通知被误判为过期');
  skewed.syncClock(NOW);
  await skewed.process([finished(3, 'calibrated', { at: NOW - 1000 })]);
  assert.equal(skewShown.length, 1, '用服务端 now 校准后应正常通知');

  const shown = [];
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const notifier = createTaskNotifier({ storage: broken, env: fakeEnv('granted'), getNow: () => NOW, label, deliver: async (n) => { shown.push(n); return 'page'; } });
  await notifier.process([finished(1, 'a')]);
  await notifier.process([finished(1, 'a'), finished(2, 'b')]);
  await notifier.process([finished(2, 'b')]);
  assert.deepEqual(shown.map((n) => n.tag), ['maaremote-task-b']);

  const corrupt = memoryStorage({ [NOTIFY_SEEN_KEY]: '{not json' });
  const again = createTaskNotifier({ storage: corrupt, env: fakeEnv('granted'), getNow: () => NOW, label, deliver: async (n) => { shown.push(n); return 'page'; } });
  const out = await again.process([finished(9, 'c')]);
  assert.equal(out.baseline, true);
  assert.equal(shown.length, 1);
});

test('页面不在加载时请求权限，且 Service Worker 只处理推送与通知点击', async () => {
  const app = await fs.readFile(fileURLToPath(new URL('../../web/js/app.js', import.meta.url)), 'utf8');
  const notify = await fs.readFile(fileURLToPath(new URL('../../web/js/notify.js', import.meta.url)), 'utf8');
  const worker = await fs.readFile(fileURLToPath(new URL('../../cloudflare/p4b-assets/public/sw.js', import.meta.url)), 'utf8');
  const code = (src) => src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.equal((code(app).match(/requestPermission/g) ?? []).length, 0);
  assert.equal((code(notify).match(/requestPermission\(/g) ?? []).length, 1);
  assert.match(app, /notify-enable/);
  assert.doesNotMatch(worker, /addEventListener\('fetch'/);
  assert.match(worker, /addEventListener\('push'/);
  assert.match(worker, /showNotification\(/);
  assert.doesNotMatch(worker, /localStorage|dashboardToken|Authorization/);
  assert.match(notify, /maaremote-notification-delivery/);
  assert.match(worker, /maaremote-notification-delivery/);
  assert.match(worker, /claimNotificationDelivery/);
});
