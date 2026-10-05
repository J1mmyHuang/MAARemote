// SPDX-License-Identifier: AGPL-3.0-or-later
// 前端状态只合并服务端的真实快照；不会根据时间或事件臆造 running/完成状态。
const TERMINAL_STATUSES = new Set(['success', 'failed', 'stale']);
const IN_FLIGHT_STATUSES = new Set(['queued', 'dispatched', 'running']);
const PENDING_ID_PREFIX = 'pending:';
// POST /api/tasks 超时后的本地幽灵任务：超过该时长仍未与服务端快照对上则丢弃（代码常量）。
const PENDING_CONFIRMATION_MAX_AGE_MS = 5 * 60 * 1000;
// 用创建时间窗口把幽灵 pending 与「其实已经入库」的真实任务对上。
const PENDING_CONFIRMATION_MATCH_WINDOW_MS = 2 * 60 * 1000;

/** 将 SSE 中以字符串保存的 detail 安全地还原为 JSON。 */
export function parseEventDetail(detail) {
  if (typeof detail !== 'string') return null;
  try {
    return JSON.parse(detail);
  } catch {
    return null;
  }
}

/** 将服务端记录的任务级毫秒耗时格式化为时间线可读文本。 */
export function formatTaskDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '';

  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
}

function compareDescendingId(left, right) {
  const leftText = String(left ?? '');
  const rightText = String(right ?? '');
  if (/^\d+$/.test(leftText) && /^\d+$/.test(rightText)) {
    if (leftText.length !== rightText.length) return rightText.length - leftText.length;
    return rightText.localeCompare(leftText);
  }
  return 0;
}

/**
 * 以 events.id 去重，保留服务器事件 ID 的倒序。SSE 重连回放会覆盖同 ID 的旧对象。
 */
export function mergeEvents(previous = [], incoming) {
  if (!incoming || incoming.id === undefined || incoming.id === null) return [...previous];

  const byId = new Map();
  for (const event of previous) {
    if (event?.id !== undefined && event.id !== null) byId.set(String(event.id), event);
  }
  byId.set(String(incoming.id), incoming);

  return [...byId.values()].sort((left, right) => compareDescendingId(left.id, right.id));
}

function taskSortTime(task) {
  return typeof task?.created_at === 'number' ? task.created_at : Number.NEGATIVE_INFINITY;
}

/**
 * 以任务 UUID 合并列表快照。服务端快照是状态的唯一来源，允许 queued 直接成为 success/failed/stale。
 */
export function mergeTaskSnapshots(previous = [], snapshot = []) {
  const byId = new Map();
  for (const task of previous) {
    if (task?.id !== undefined && task.id !== null) byId.set(String(task.id), task);
  }
  for (const task of snapshot) {
    if (task?.id !== undefined && task.id !== null) byId.set(String(task.id), task);
  }

  return [...byId.values()].sort((left, right) => taskSortTime(right) - taskSortTime(left));
}

/** 本地因网络/超时虚构的 pending:... 任务，服务端快照永远对不上这个 id。 */
export function isPendingConfirmationTask(task) {
  if (!task) return false;
  if (task.status === 'pending_confirmation' || task.pendingConfirmation === true) return true;
  return typeof task.id === 'string' && task.id.startsWith(PENDING_ID_PREFIX);
}

/** 仅一键除草 / 自动肉鸽走「进行中可点 → 再确认」；其余 LinkStart-* 仍用 busy 禁用。 */
const LONG_RUNNING_COMMAND_TYPES = new Set(['LinkStart', 'LinkStart-AutoRoguelike']);

export function isLongRunningCommandType(type) {
  return LONG_RUNNING_COMMAND_TYPES.has(type);
}

/** HeartBeat 上报的 current_task_id 非空，视为设备仍被顺序任务占用。 */
export function hasObservedCurrentTask(device) {
  return typeof device?.current_task_id === 'string' && device.current_task_id.length > 0;
}

/** 服务端真实在途：queued / dispatched / running。不含本地幽灵 pending_confirmation。 */
export function isUnfinishedServerTask(task) {
  return IN_FLIGHT_STATUSES.has(task?.status);
}

/**
 * 长任务在途，或心跳仍观测到占用时，打开进行中确认，避免直接再入队。
 * 公招 / 基建等短流程不会走到这里（控件保持 disabled）。
 */
export function shouldOfferInFlightConfirm({ type, sending = false, inFlight = false, device } = {}) {
  if (!isLongRunningCommandType(type) || sending) return false;
  return Boolean(inFlight) || hasObservedCurrentTask(device);
}

/**
 * 同类型仍在 queued/dispatched/running，或心跳仍占用时，不允许「再下一单」。
 * 仅幽灵 pending_confirmation（结果待确认）且心跳空闲时允许再发一次。
 */
export function canQueueAgainWhileInFlight({ sending = false, device, task } = {}) {
  if (sending) return false;
  if (hasObservedCurrentTask(device)) return false;
  if (isUnfinishedServerTask(task)) return false;
  return true;
}

function sameActionTarget(left, right) {
  return left?.type === right?.type && left?.device === right?.device;
}

/**
 * 丢掉已过期、或已能被真实任务解释的幽灵 pending_confirmation。
 * snapshot 为本次新快照（可为空）；也会扫描 tasks 里已有的非幽灵任务，避免超时回调把幽灵叠在已入库任务上。
 */
export function reconcilePendingConfirmationTasks(tasks = [], snapshot = [], now = Date.now()) {
  const serverTasks = [...snapshot, ...tasks].filter((task) => task && !isPendingConfirmationTask(task));
  return tasks.filter((task) => {
    if (!isPendingConfirmationTask(task)) return true;
    const createdAt = typeof task.created_at === 'number' ? task.created_at : null;
    if (createdAt === null || now - createdAt > PENDING_CONFIRMATION_MAX_AGE_MS) return false;
    const unfinished = serverTasks.some(
      (other) => sameActionTarget(other, task) && IN_FLIGHT_STATUSES.has(other.status),
    );
    if (unfinished) return false;
    const nearby = serverTasks.some((other) => {
      if (!sameActionTarget(other, task)) return false;
      const otherCreated = typeof other.created_at === 'number' ? other.created_at : NaN;
      return Number.isFinite(otherCreated) && Math.abs(otherCreated - createdAt) <= PENDING_CONFIRMATION_MATCH_WINDOW_MS;
    });
    return !nearby;
  });
}

/** 用户点「清除卡住状态」时，只去掉匹配的幽灵 pending，不动服务端任务。 */
export function clearPendingConfirmationTasks(tasks = [], { type, device, id } = {}) {
  return tasks.filter((task) => {
    if (!isPendingConfirmationTask(task)) return true;
    if (id) return String(task.id) !== String(id);
    if (type && device) return !(task.type === type && task.device === device);
    if (type) return task.type !== type;
    return true;
  });
}

/**
 * 发送中始终禁用；一键除草 / 自动肉鸽在途只展示「进行中」，不把控件 disabled。
 * 公招 / 基建 / 截图等短操作仍按原 busy 锁定。
 */
export function isActionControlDisabled({ type, sending = false, inFlight = false } = {}) {
  if (sending) return true;
  if (isLongRunningCommandType(type)) return false;
  return Boolean(inFlight);
}

/**
 * 刷新或重新打开面板时恢复尚未由服务端终结的指令。POST 响应丢失仅标为待确认，绝不自动重发。
 * 超龄的 pending_confirmation 在恢复时直接丢弃，避免永久锁死快捷按钮。
 */
export function restoreInFlightTasks(saved = [], now = Date.now()) {
  const restored = saved
    .filter((task) => {
      if (!task || typeof task.id !== 'string') return false;
      return IN_FLIGHT_STATUSES.has(task.status) || task.status === 'pending_confirmation';
    })
    .map((task) => ({
      ...task,
      ...(task.status === 'pending_confirmation' ? { pendingConfirmation: true } : {}),
    }));
  return reconcilePendingConfirmationTasks(restored, [], now);
}

/** 是否已同时获得 StopTask 成功回报与同设备空闲心跳观测。 */
export function isStopTaskStopped(task, overview) {
  if (task?.type !== 'StopTask' || task.status !== 'success' || typeof task.device !== 'string') {
    return false;
  }
  const device = overview?.devices?.find((item) => item?.device === task.device);
  return device?.current_task_id === '';
}

export {
  TERMINAL_STATUSES,
  IN_FLIGHT_STATUSES,
  PENDING_CONFIRMATION_MAX_AGE_MS,
  PENDING_CONFIRMATION_MATCH_WINDOW_MS,
};
