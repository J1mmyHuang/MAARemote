// 进程内事件总线：所有「写 events 表」的地方统一经 recordAndPublishEvent，
// 同步完成「入库 + 广播」，保证 SSE 订阅者收到的消息与 events 表记录一致（含 kind、detail、created_at）。
import { EventEmitter } from 'node:events';

/** 事件总线：'event' 通道广播完整事件对象 */
export class EventBus extends EventEmitter {}

/** 创建事件总线（SSE 客户端数量不定，取消监听器上限警告） */
export function createEventBus() {
  const bus = new EventBus();
  bus.setMaxListeners(0);
  return bus;
}

// 静态 SQL + 参数绑定，禁止拼接
const SQL_INSERT_EVENT = 'INSERT INTO events (device_id, kind, detail, created_at) VALUES (?, ?, ?, ?)';
const SQL_DEVICE_NAME = 'SELECT device FROM devices WHERE id = ?';

/**
 * 统一事件写入点：写 events 表并经总线广播。
 * opts:
 *   deviceId  事件关联设备 id（可 null）
 *   kind      事件类型（online / offline / task_started / task_finished / task_stale ...）
 *   detail    明细（对象或字符串；对象将被 JSON.stringify，与表内 TEXT 存储一致）
 *   createdAt 时间戳（可省，默认当前时间；getTask/reportStatus 传入自身 now 以对齐任务时间）
 * 广播对象 = events 表行字段（id / device_id / kind / detail / created_at）
 *          + device（设备名字符串，便于前端展示；设备未登记时为 null）。
 * 返回写入后的完整事件对象。
 */
export function recordAndPublishEvent(db, bus, opts) {
  const { deviceId = null, kind, detail, createdAt } = opts;
  const created = typeof createdAt === 'number' ? createdAt : Date.now();
  const detailText = typeof detail === 'string' ? detail : JSON.stringify(detail);

  const info = db.prepare(SQL_INSERT_EVENT).run(deviceId, kind, detailText, created);

  let deviceName = null;
  if (deviceId) {
    const row = db.prepare(SQL_DEVICE_NAME).get(deviceId);
    deviceName = row ? row.device : null;
  }

  const event = {
    id: Number(info.lastInsertRowid),
    device_id: deviceId,
    device: deviceName,
    kind,
    detail: detailText,
    created_at: created,
  };
  bus.emit('event', event);
  return event;
}
