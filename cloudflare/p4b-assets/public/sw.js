// MAARemote 通知 Service Worker：页面关闭时接收 Web Push 并立即显示通知。
// 不缓存、不拦截 fetch、不读取任何凭据；/api 与 /maa 请求完全不经过它。
const DELIVERY_DB_NAME = 'maaremote-notification-delivery';
const DELIVERY_STORE_NAME = 'delivered';
const DELIVERY_DB_VERSION = 1;
// 页面补发窗口只有 30 分钟；保留更长时间可覆盖推送与重开之间的延迟，同时避免无限增长。
const DELIVERY_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function openDeliveryDb() {
  if (!self.indexedDB || typeof self.indexedDB.open !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    let request;
    try {
      request = self.indexedDB.open(DELIVERY_DB_NAME, DELIVERY_DB_VERSION);
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

async function claimNotificationDelivery(key) {
  if (!key) return true;
  const db = await openDeliveryDb();
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

async function releaseNotificationDelivery(key) {
  if (!key) return;
  const db = await openDeliveryDb();
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

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data?.json?.() ?? {};
  } catch {
    try { payload = { body: event.data?.text?.() ?? '' }; } catch { payload = {}; }
  }
  const taskId = typeof payload.task_id === 'string' ? payload.task_id : '';
  const eventId = payload.event_id === undefined || payload.event_id === null ? '' : String(payload.event_id);
  const title = typeof payload.title === 'string' && payload.title.length > 0 ? payload.title : 'MAA 任务已结束';
  const body = typeof payload.body === 'string' && payload.body.length > 0 ? payload.body : '请打开仪表盘查看实时事件。';
  const url = typeof payload.url === 'string' && payload.url.startsWith('/') ? payload.url : '/';
  const deliveryKey = taskId ? `task:${taskId}` : `event:${eventId || 'unknown'}`;
  event.waitUntil((async () => {
    if (!await claimNotificationDelivery(deliveryKey)) return;
    try {
      await self.registration.showNotification(title, {
        body,
        tag: `maaremote-task-${taskId || eventId || 'unknown'}`,
        lang: 'zh-CN',
        data: { url },
      });
    } catch {
      await releaseNotificationDelivery(deliveryKey);
    }
  })());
});

// 订阅在推送服务侧失效后由浏览器触发；页面拿到消息后用 Bearer token 重新登记。
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    let subscription = event.newSubscription;
    if (!subscription && event.oldSubscription?.options) {
      try { subscription = await self.registration.pushManager.subscribe(event.oldSubscription.options); } catch { subscription = null; }
    }
    if (!subscription) return;
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const message = { type: 'maaremote-push-subscription-change', subscription: subscription.toJSON() };
    for (const client of clients) client.postMessage(message);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (typeof client.navigate === 'function') await client.navigate(targetUrl).catch(() => {});
      if (typeof client.focus === 'function') return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    return undefined;
  })());
});
