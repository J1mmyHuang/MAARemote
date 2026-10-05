// 任务完成通知（P4）：只消费既有 task_finished 事件，不新增服务端字段，不改任务状态机。
// 纯函数负责去重 / 首次基线 / 时效 / 补发上限；适配层负责权限状态与 Service Worker / 页面 Notification 投递。
import { formatTaskDuration, parseEventDetail } from './model.js?v=20260923-followup2';

export const NOTIFY_SEEN_KEY = 'maaremote.notify-seen';
export const NOTIFY_PAUSED_KEY = 'maaremote.notify-paused';
export const NOTIFY_BANNER_DISMISSED_KEY = 'maaremote.notify-banner-dismissed';
export const PUSH_ENABLED_KEY = 'maaremote.push-enabled';
// 已通知键最多保留 200 个；服务端每次只回放最近 20 条事件，远小于该上限。
export const NOTIFY_MAX_SEEN = 200;
// 离线补发窗口：只补发 30 分钟内结束的任务，更早的只留在时间线。
export const NOTIFY_MAX_AGE_MS = 30 * 60 * 1000;
// 一次最多逐条通知 3 个任务，其余合并为 1 条汇总，避免旧任务刷屏。
export const NOTIFY_MAX_INDIVIDUAL = 3;

const WORKER_URL = '/sw.js';
const WORKER_READY_TIMEOUT_MS = 3000;
const DELIVERY_DB_NAME = 'maaremote-notification-delivery';
const DELIVERY_STORE_NAME = 'delivered';
const DELIVERY_DB_VERSION = 1;
// 页面补发窗口只有 30 分钟；保留更长时间可覆盖推送与重开之间的延迟，同时避免无限增长。
const DELIVERY_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function openDeliveryDb(env = globalThis) {
  const indexedDB = env?.indexedDB;
  if (!indexedDB || typeof indexedDB.open !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(DELIVERY_DB_NAME, DELIVERY_DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DELIVERY_STORE_NAME)) {
          request.result.createObjectStore(DELIVERY_STORE_NAME, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function pruneDeliveryLedger(db) {
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(DELIVERY_STORE_NAME, 'readwrite');
      const request = transaction.objectStore(DELIVERY_STORE_NAME).openCursor();
      const cutoff = Date.now() - DELIVERY_MAX_AGE_MS;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (!Number.isFinite(cursor.value?.createdAt) || cursor.value.createdAt < cutoff) cursor.delete();
        cursor.continue();
      };
      transaction.oncomplete = resolve;
      transaction.onerror = resolve;
      transaction.onabort = resolve;
    } catch {
      resolve();
    }
  });
}

async function claimNotificationDelivery(key, env = globalThis) {
  if (!key) return true;
  const db = await openDeliveryDb(env);
  if (!db) return true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const transaction = db.transaction(DELIVERY_STORE_NAME, 'readwrite');
      const request = transaction.objectStore(DELIVERY_STORE_NAME).add({ key, createdAt: Date.now() });
      request.onsuccess = () => finish(true);
      request.onerror = () => finish(request.error?.name === 'ConstraintError' ? false : true);
      transaction.onerror = () => finish(true);
      transaction.onabort = () => finish(true);
      transaction.oncomplete = () => {
        pruneDeliveryLedger(db).finally(() => {
          try { db.close(); } catch { /* ignore */ }
        });
      };
    } catch {
      try { db.close(); } catch { /* ignore */ }
      finish(true);
    }
  });
}

async function releaseNotificationDelivery(key, env = globalThis) {
  if (!key) return;
  const db = await openDeliveryDb(env);
  if (!db) return;
  await new Promise((resolve) => {
    try {
      const transaction = db.transaction(DELIVERY_STORE_NAME, 'readwrite');
      transaction.objectStore(DELIVERY_STORE_NAME).delete(key);
      transaction.oncomplete = resolve;
      transaction.onerror = resolve;
      transaction.onabort = resolve;
    } catch {
      resolve();
    }
  });
  try { db.close(); } catch { /* ignore */ }
}

/** 权限四态：unsupported / default（未请求）/ granted / denied。 */
export function getPermissionState(env = globalThis) {
  const NotificationApi = env?.Notification;
  if (typeof NotificationApi !== 'function' && typeof NotificationApi !== 'object') return 'unsupported';
  if (env.isSecureContext === false) return 'unsupported';
  const permission = NotificationApi.permission;
  if (permission === 'granted' || permission === 'denied' || permission === 'default') return permission;
  return 'unsupported';
}

function isStandaloneWebApp(env) {
  try {
    return Boolean(env?.navigator?.standalone === true)
      || Boolean(env?.matchMedia?.('(display-mode: standalone)')?.matches);
  } catch {
    return false;
  }
}

function isSecurePushContext(env) {
  if (env?.isSecureContext === true) return true;
  const location = env?.location;
  const host = String(location?.hostname || '').toLowerCase();
  return location?.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
}

/** 后台推送只在用户明确点击时检查；失败原因可直接呈现给用户。 */
export function getPushCapability(env = globalThis) {
  if (!isStandaloneWebApp(env)) return { ok: false, code: 'not_standalone', message: '请先将本页面添加到主屏幕，再开启后台推送。' };
  if (!isSecurePushContext(env)) return { ok: false, code: 'insecure_context', message: '后台推送只能在 HTTPS 或 localhost 页面使用。' };
  if (typeof env?.Notification !== 'function' && typeof env?.Notification !== 'object') {
    return { ok: false, code: 'notification_unsupported', message: '当前浏览器不支持通知。' };
  }
  if (!env?.navigator?.serviceWorker || typeof env.navigator.serviceWorker.register !== 'function') {
    return { ok: false, code: 'service_worker_unsupported', message: '当前浏览器不支持 Service Worker。' };
  }
  if (typeof env?.PushManager !== 'function' && typeof env?.navigator?.PushManager !== 'function') {
    return { ok: false, code: 'push_unsupported', message: '当前浏览器不支持后台推送。' };
  }
  return { ok: true };
}

export function base64urlToUint8Array(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('VAPID 公钥格式无效');
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const binary = globalThis.atob(value.replaceAll('-', '+').replaceAll('_', '/') + padding);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function subscriptionJson(subscription) {
  const value = typeof subscription?.toJSON === 'function' ? subscription.toJSON() : subscription;
  if (!value || typeof value.endpoint !== 'string' || !value.keys || typeof value.keys.p256dh !== 'string' || typeof value.keys.auth !== 'string') {
    throw new TypeError('浏览器返回的推送订阅不完整');
  }
  return { endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}

async function getPushRegistration(env, { register = true } = {}) {
  const container = env?.navigator?.serviceWorker;
  if (!container) return null;
  let registration = await container.getRegistration?.('/');
  if (!registration && register) registration = await container.register(WORKER_URL, { scope: '/' });
  if (!registration && container.ready) registration = await container.ready;
  return registration;
}

function bufferSourceBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function sameBytes(left, right) {
  if (!left || !right || left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

async function subscribeWithCurrentVapidKey(pushManager, api) {
  if (typeof pushManager?.subscribe !== 'function') throw new Error('subscribe unsupported');
  const keyResponse = await api.getPushVapidPublicKey();
  const applicationServerKey = base64urlToUint8Array(keyResponse?.publicKey);
  return pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
}

/**
 * 确保浏览器订阅绑定当前服务端 VAPID 公钥。
 * 某些浏览器不暴露 applicationServerKey，此时保留现有订阅并继续由服务端同步。
 */
async function ensureCurrentVapidSubscription(pushManager, api, existing) {
  if (!existing) return subscribeWithCurrentVapidKey(pushManager, api);
  const boundKey = bufferSourceBytes(existing.options?.applicationServerKey);
  if (!boundKey) return existing;
  const keyResponse = await api.getPushVapidPublicKey();
  const currentKey = base64urlToUint8Array(keyResponse?.publicKey);
  if (sameBytes(boundKey, currentKey)) return existing;
  if (typeof existing.unsubscribe !== 'function') throw new Error('旧推送订阅无法取消');
  await existing.unsubscribe();
  return subscribeWithCurrentVapidKey(pushManager, api);
}

export async function syncPushSubscription({ api, subscription, storage }) {
  const serialized = subscriptionJson(subscription);
  await api.savePushSubscription(serialized);
  try { storage?.setItem(PUSH_ENABLED_KEY, '1'); } catch { /* 仅影响本地展示状态。 */ }
  return { ok: true, subscription: serialized };
}

function pushSubscriptionFailure(error, stage = '') {
  const stageText = stage ? `（${stage}失败）` : '';
  if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') {
    return {
      ok: false,
      code: 'push_permission_denied',
      message: `浏览器拒绝了后台推送订阅${stageText}，请确认系统通知权限和主屏幕 App 状态后重试。`,
    };
  }
  if (error?.name === 'NetworkError') {
    return { ok: false, code: 'push_network_error', message: `推送服务暂时不可用${stageText}，请检查网络后重试。` };
  }
  return { ok: false, code: 'subscribe_failed', message: `后台推送开启失败${stageText}，请刷新主屏幕 App 后重试。` };
}

/** 只应由“开启后台推送”点击触发；权限请求发生在第一次异步等待之前。 */
export async function enableBackgroundPush({ api, env = globalThis, storage } = {}) {
  const capability = getPushCapability(env);
  if (!capability.ok) return capability;
  let permission = getPermissionState(env);
  if (permission === 'default') permission = await requestNotificationPermission(env);
  if (permission !== 'granted') {
    return permission === 'denied'
      ? { ok: false, code: 'denied', message: '浏览器已拒绝后台推送，请在站点设置中允许通知。' }
      : { ok: false, code: 'permission_unavailable', message: '尚未获得通知权限。' };
  }
  let stage = '注册 Service Worker';
  try {
    const registration = await getPushRegistration(env);
    stage = '读取推送订阅';
    const pushManager = registration?.pushManager;
    if (!pushManager || typeof pushManager.getSubscription !== 'function') {
      return { ok: false, code: 'push_unsupported', message: '当前浏览器未提供 PushManager。' };
    }
    const existing = await pushManager.getSubscription();
    stage = '获取 VAPID 公钥并创建订阅';
    const subscription = await ensureCurrentVapidSubscription(pushManager, api, existing);
    stage = '向服务端登记订阅';
    return await syncPushSubscription({ api, subscription, storage });
  } catch (error) {
    return pushSubscriptionFailure(error, stage);
  }
}

/** 页面重新打开或 Service Worker 报告订阅变更时调用；不请求权限。 */
export async function syncExistingPushSubscription({ api, env = globalThis, storage } = {}) {
  if (getPermissionState(env) !== 'granted') return { ok: false, code: 'permission_unavailable' };
  try {
    const registration = await getPushRegistration(env);
    const pushManager = registration?.pushManager;
    const subscription = await pushManager?.getSubscription?.();
    if (!subscription) return { ok: false, code: 'not_subscribed' };
    const current = await ensureCurrentVapidSubscription(pushManager, api, subscription);
    return await syncPushSubscription({ api, subscription: current, storage });
  } catch {
    return { ok: false, code: 'sync_failed' };
  }
}

export function unsupportedReason(env = globalThis) {
  if (typeof env?.Notification !== 'function') return '当前浏览器不支持网页通知。';
  if (env.isSecureContext === false) return '网页通知只能在 HTTPS 或 localhost 页面使用，当前页面不满足。';
  return '浏览器返回了无法识别的通知权限状态。';
}

/** 必须由用户点击直接调用：函数体在第一个 await 之前就发起请求，保持用户手势。 */
export async function requestNotificationPermission(env = globalThis) {
  if (getPermissionState(env) === 'unsupported') return 'unsupported';
  try {
    await env.Notification.requestPermission();
  } catch {
    // 个别浏览器被策略禁止时会抛出；一律以实际权限状态为准。
  }
  return getPermissionState(env);
}

/** 把 task_finished 事件还原为通知候选；其他事件、未知状态一律忽略。 */
export function finishedCandidate(event) {
  if (!event || event.kind !== 'task_finished') return null;
  const detail = parseEventDetail(event.detail);
  if (!detail || typeof detail !== 'object') return null;
  if (detail.status !== 'success' && detail.status !== 'failed') return null;
  const taskId = typeof detail.task_id === 'string' ? detail.task_id : '';
  const eventId = event.id === undefined || event.id === null ? '' : String(event.id);
  if (!taskId && !eventId) return null;
  return {
    // 去重键：优先任务 UUID（数据库重建后仍唯一），缺失时退回事件 id。
    key: taskId ? 'task:' + taskId : 'event:' + eventId,
    taskId,
    eventId,
    type: typeof detail.type === 'string' ? detail.type : '',
    status: detail.status,
    durationMs: Number.isFinite(detail.duration_ms) ? detail.duration_ms : null,
    createdAt: Number.isFinite(event.created_at) ? event.created_at : null,
  };
}

/** 通知内容只取白名单字段：任务名称、成功/失败、任务级耗时。 */
export function buildNotification(candidate, label = String) {
  const name = label(candidate.type);
  const duration = formatTaskDuration(candidate.durationMs);
  return {
    key: candidate.key,
    title: name + '：' + (candidate.status === 'success' ? '成功' : '失败'),
    body: '耗时 ' + (duration || '未知'),
    tag: 'maaremote-task-' + (candidate.taskId || candidate.eventId),
  };
}

function buildSummary(candidates) {
  const failed = candidates.filter((item) => item.status === 'failed').length;
  return {
    key: 'summary',
    title: '另有 ' + candidates.length + ' 个任务已结束',
    body: '成功 ' + (candidates.length - failed) + ' · 失败 ' + failed + '，详见实时事件',
    tag: 'maaremote-task-summary',
  };
}

export function parseSeen(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const value = JSON.parse(raw);
    if (!value || value.v !== 1 || !Array.isArray(value.keys)) return null;
    return { v: 1, keys: value.keys.filter((key) => typeof key === 'string').slice(-NOTIFY_MAX_SEEN) };
  } catch {
    return null;
  }
}

function compareIdsDescending(left, right) {
  return (Number(right) - Number(left)) || 0;
}

/**
 * 计划本批事件的通知。seen 为 null 表示从未建立过基线：此时只记账不通知，
 * 因此首次打开、清除存储或存储损坏都不会把历史事件当成新结果。
 * canDeliver 为 false（无权限 / 已暂停）时同样只记账，之后开启不会补发这段时间的结果。
 */
export function planTaskNotifications({
  events = [],
  seen = null,
  now = Date.now(),
  canDeliver = false,
  maxAgeMs = NOTIFY_MAX_AGE_MS,
  maxIndividual = NOTIFY_MAX_INDIVIDUAL,
  label = String,
} = {}) {
  const baseline = seen === null || seen === undefined;
  const known = new Set(baseline ? [] : seen.keys);
  const batch = new Set();
  const added = [];
  const fresh = [];
  const stats = { baseline, candidates: 0, duplicate: 0, stale: 0, suppressed: 0, added: 0, planned: 0 };

  for (const event of events ?? []) {
    const candidate = finishedCandidate(event);
    if (!candidate) continue;
    stats.candidates += 1;
    if (known.has(candidate.key) || batch.has(candidate.key)) {
      stats.duplicate += 1;
      continue;
    }
    batch.add(candidate.key);
    added.push(candidate.key);
    if (baseline) continue;
    if (!canDeliver) {
      stats.suppressed += 1;
      continue;
    }
    if (candidate.createdAt === null || now - candidate.createdAt > maxAgeMs) {
      stats.stale += 1;
      continue;
    }
    fresh.push(candidate);
  }

  fresh.sort((left, right) => (right.createdAt - left.createdAt) || compareIdsDescending(left.eventId, right.eventId));
  const individual = fresh.slice(0, maxIndividual);
  const rest = fresh.slice(maxIndividual);
  const notifications = [];
  if (rest.length > 0) notifications.push(buildSummary(rest));
  // 先投递较早的，让最新的结果最后到达、停在系统通知栈顶部。
  for (const candidate of individual.reverse()) notifications.push(buildNotification(candidate, label));

  stats.added = added.length;
  stats.planned = notifications.length;
  return {
    notifications,
    nextSeen: { v: 1, keys: [...known, ...added].slice(-NOTIFY_MAX_SEEN) },
    stats,
  };
}

function delay(ms, value) {
  return new Promise((resolve) => {
    globalThis.setTimeout(() => resolve(value), ms);
  });
}

async function showViaWorker(note, options, env) {
  const container = env?.navigator?.serviceWorker;
  if (!container || typeof container.getRegistration !== 'function') return false;
  let registration = await container.getRegistration('/');
  if (!registration) return false;
  if (!registration.active && container.ready) {
    // showNotification 要求已有激活的 worker；限时等待，超时回退页面通知。
    registration = (await Promise.race([container.ready, delay(WORKER_READY_TIMEOUT_MS, null)])) || registration;
  }
  if (!registration?.active || typeof registration.showNotification !== 'function') return false;
  await registration.showNotification(note.title, options);
  return true;
}

/** 投递一条通知：优先 Service Worker（Android Chrome 只允许这种方式），其次页面 Notification。 */
export async function deliverNotification(note, env = globalThis, claim = claimNotificationDelivery) {
  let claimed = true;
  try { claimed = await claim(note.key, env); } catch { /* IndexedDB 不可用时保留 tag 兼容路径。 */ }
  if (!claimed) return 'duplicate';
  const options = { body: note.body, tag: note.tag, lang: 'zh-CN' };
  try {
    if (await showViaWorker(note, options, env)) return 'worker';
  } catch {
    // 回退到页面通知。
  }
  try {
    const shown = new env.Notification(note.title, options);
    shown.onclick = () => {
      try {
        env.focus?.();
        shown.close?.();
      } catch {
        // 聚焦失败不影响页面。
      }
    };
    return 'page';
  } catch {
    try { await releaseNotificationDelivery(note.key, env); } catch { /* ignore */ }
    return 'failed';
  }
}

export async function registerNotificationWorker(env = globalThis) {
  const container = env?.navigator?.serviceWorker;
  if (!container || typeof container.register !== 'function') return false;
  try {
    await container.register(WORKER_URL, { scope: '/' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 通知器：持久化已通知键（localStorage，多标签页共用）与暂停开关。
 * 存储不可用时退回会话内存去重；重载后会重新建立基线，宁可漏通知也不重复刷屏。
 */
export function createTaskNotifier({
  storage,
  env = globalThis,
  getNow = Date.now,
  label = String,
  maxAgeMs = NOTIFY_MAX_AGE_MS,
  maxIndividual = NOTIFY_MAX_INDIVIDUAL,
  deliver = deliverNotification,
} = {}) {
  let memorySeen = null;
  let memoryPaused = false;
  // 服务端时钟偏差：补发窗口按服务端 created_at 计算，不能依赖设备本机时钟是否准确。
  let clockSkewMs = 0;

  function readSeen() {
    let stored = null;
    try {
      stored = parseSeen(storage.getItem(NOTIFY_SEEN_KEY));
    } catch {
      stored = null;
    }
    if (!memorySeen) return stored;
    if (!stored) return memorySeen;
    const keys = [...stored.keys];
    const have = new Set(keys);
    for (const key of memorySeen.keys) if (!have.has(key)) keys.push(key);
    return { v: 1, keys: keys.slice(-NOTIFY_MAX_SEEN) };
  }

  function writeSeen(seen) {
    memorySeen = seen;
    try {
      storage.setItem(NOTIFY_SEEN_KEY, JSON.stringify(seen));
    } catch {
      // 仅保留会话内去重。
    }
  }

  function isPaused() {
    try {
      return storage.getItem(NOTIFY_PAUSED_KEY) === '1' || memoryPaused;
    } catch {
      return memoryPaused;
    }
  }

  async function deliverAll(notifications, stats) {
    let shown = 0;
    let failed = 0;
    let duplicate = 0;
    const via = new Set();
    for (const note of notifications) {
      let outcome = 'failed';
      try {
        outcome = await deliver(note, env);
      } catch {
        outcome = 'failed';
      }
      if (outcome === 'duplicate') duplicate += 1;
      else if (outcome === 'failed') failed += 1;
      else {
        shown += 1;
        via.add(outcome);
      }
    }
    return { ...stats, shown, failed, duplicate, via: [...via] };
  }

  return {
    permission: () => getPermissionState(env),
    unsupportedReason: () => unsupportedReason(env),
    isEnabled: () => !isPaused(),
    setEnabled(enabled) {
      memoryPaused = !enabled;
      try {
        if (enabled) storage.removeItem(NOTIFY_PAUSED_KEY);
        else storage.setItem(NOTIFY_PAUSED_KEY, '1');
      } catch {
        // 仅保留会话内开关。
      }
    },
    /** 只应由用户点击触发；授权成功后注册通知用的 Service Worker。 */
    async request() {
      const result = await requestNotificationPermission(env);
      if (result === 'granted') await registerNotificationWorker(env);
      return result;
    },
    registerWorker: () => registerNotificationWorker(env),
    /** 用 /api/overview 的服务端 now 校准本机时钟偏差。 */
    syncClock(serverNow) {
      if (Number.isFinite(serverNow)) clockSkewMs = serverNow - getNow();
    },
    /** 同步完成计划与记账（至多一次），再异步投递；返回的 Promise 汇总投递结果。 */
    process(events) {
      const permission = getPermissionState(env);
      const plan = planTaskNotifications({
        events,
        seen: readSeen(),
        now: getNow() + clockSkewMs,
        canDeliver: permission === 'granted' && !isPaused(),
        maxAgeMs,
        maxIndividual,
        label,
      });
      if (plan.stats.baseline || plan.stats.added > 0) writeSeen(plan.nextSeen);
      return deliverAll(plan.notifications, plan.stats);
    },
    /** 清除凭据时一并清掉已通知记录，重新登录后重建基线。 */
    reset() {
      memorySeen = null;
      try {
        storage.removeItem(NOTIFY_SEEN_KEY);
      } catch {
        // 存储不可用时无需清理。
      }
    },
    /** 浏览器站点设置里改动权限时回调；不支持 permissions API 的环境静默跳过。 */
    watchPermission(onChange) {
      try {
        const query = env?.navigator?.permissions?.query?.({ name: 'notifications' });
        Promise.resolve(query)
          .then((status) => {
            if (status && 'onchange' in status) status.onchange = () => onChange(getPermissionState(env));
          })
          .catch(() => {});
      } catch {
        // 不支持则只在页面重新可见时刷新权限状态。
      }
    },
  };
}
