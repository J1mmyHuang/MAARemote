// 前端状态只合并服务端的真实快照；不会根据时间或事件臆造 running/完成状态。
const TERMINAL_STATUSES = new Set(['success', 'failed', 'stale']);
const IN_FLIGHT_STATUSES = new Set(['queued', 'dispatched', 'running']);

/** 将 SSE 中以字符串保存的 detail 安全地还原为 JSON。 */
export function parseEventDetail(detail) {
  if (typeof detail !== 'string') return null;
  try {
    return JSON.parse(detail);
  } catch {
    return null;
  }
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

/**
 * 刷新或重新打开面板时恢复尚未由服务端终结的指令。POST 响应丢失仅标为待确认，绝不自动重发。
 */
export function restoreInFlightTasks(saved = []) {
  return saved
    .filter((task) => {
      if (!task || typeof task.id !== 'string') return false;
      return IN_FLIGHT_STATUSES.has(task.status) || task.status === 'pending_confirmation';
    })
    .map((task) => ({
      ...task,
      ...(task.status === 'pending_confirmation' ? { pendingConfirmation: true } : {}),
    }));
}

/** 是否已同时获得 StopTask 成功回报与同设备空闲心跳观测。 */
export function isStopTaskStopped(task, overview) {
  if (task?.type !== 'StopTask' || task.status !== 'success' || typeof task.device !== 'string') {
    return false;
  }
  const device = overview?.devices?.find((item) => item?.device === task.device);
  return device?.current_task_id === '';
}

export { TERMINAL_STATUSES };
