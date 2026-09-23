import { ApiClient, ApiClientError, mapApiError } from './api.js?v=20260923-followup2';
import {
  canQueueAgainWhileInFlight,
  clearPendingConfirmationTasks,
  hasObservedCurrentTask,
  isActionControlDisabled,
  isLongRunningCommandType,
  isPendingConfirmationTask,
  isStopTaskStopped,
  isUnfinishedServerTask,
  mergeEvents,
  mergeTaskSnapshots,
  parseEventDetail,
  reconcilePendingConfirmationTasks,
  restoreInFlightTasks,
  shouldOfferInFlightConfirm,
} from './model.js?v=20260923-followup2';
import { renderInFlightSheetHtml, renderQuickActionWrapHtml, renderStuckClearButtonHtml } from './action-ui.js?v=20260923-followup2';
import { applyTheme, readThemePreference, writeThemePreference } from './theme.js';
import {
  captureSheetContext,
  clampSheetOffset,
  resolveSheetRelease,
  startSheetCloseTransition,
} from './sheet.js?v=20260913-3';

const TOKEN_STORAGE_KEY = 'maaremote.dashboard-token';
const DEVICE_STORAGE_KEY = 'maaremote.selected-device';
const IN_FLIGHT_STORAGE_KEY = 'maaremote.in-flight-tasks';
const POLL_INTERVAL_MS = 20_000;
const EVENT_REFRESH_DELAY_MS = 350;
const MAX_EVENTS = 80;

const TASKS = [
  { type: 'LinkStart-WakeUp', label: '开始唤醒', description: '执行电脑端 MAA 已保存的唤醒流程。' },
  { type: 'LinkStart-Recruiting', label: '自动公招', description: '执行电脑端 MAA 已保存的公开招募流程。' },
  { type: 'LinkStart-Base', label: '基建换班', description: '执行电脑端 MAA 已保存的基建换班流程。' },
  { type: 'LinkStart-Combat', label: '理智作战', description: '执行电脑端 MAA 已保存的作战流程。' },
  { type: 'LinkStart-Mall', label: '信用收支', description: '执行电脑端 MAA 已保存的信用商店流程。' },
  { type: 'LinkStart-Mission', label: '领取奖励', description: '执行电脑端 MAA 已保存的奖励领取流程。' },
  { type: 'LinkStart-AutoRoguelike', label: '自动肉鸽', description: '执行电脑端 MAA 已保存的肉鸽流程。' },
  { type: 'LinkStart-Reclamation', label: '生息演算', description: '执行电脑端 MAA 已保存的生息演算流程。' },
];

const QUICK_ACTIONS = [
  { type: 'LinkStart', label: '一键除草', detail: '执行已保存的默认流程' },
  { type: 'LinkStart-AutoRoguelike', label: '自动肉鸽', detail: '执行已保存的肉鸽流程' },
];

const TASK_BY_TYPE = new Map(TASKS.map((task) => [task.type, task]));
TASK_BY_TYPE.set('LinkStart', { type: 'LinkStart', label: '一键除草', description: '执行电脑端 MAA 已保存的默认流程。' });
TASK_BY_TYPE.set('StopTask', { type: 'StopTask', label: '停止任务', description: '尝试停止当前远程任务。' });
TASK_BY_TYPE.set('CaptureImageNow', { type: 'CaptureImageNow', label: '立即截图', description: '请求 MAA 立即保存一张画面。' });
TASK_BY_TYPE.set('Toolbox-GachaOnce', { type: 'Toolbox-GachaOnce', label: '工具箱单抽', description: '执行一次工具箱抽卡。' });
TASK_BY_TYPE.set('Toolbox-GachaTenTimes', { type: 'Toolbox-GachaTenTimes', label: '工具箱十连', description: '执行一次工具箱十连抽卡。' });
TASK_BY_TYPE.set('Settings-ConnectAddress', { type: 'Settings-ConnectAddress', label: '连接地址', description: '修改 MAA 连接地址。' });
TASK_BY_TYPE.set('Settings-Stage1', { type: 'Settings-Stage1', label: '第一关卡', description: '修改作战第一关卡。' });

const app = document.querySelector('#app');
const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');

let api = new ApiClient(readStoredValue(TOKEN_STORAGE_KEY));
let sessionEpoch = 0;
let sessionController = new AbortController();
const screenshotObjects = new Map();
const screenshotLoads = new Map();
let eventSource = null;
let pollTimer = null;
let eventRefreshTimer = null;
let authVerifyTimer = null;
let toastTimer = null;
let snapshotRequestSequence = 0;
let sheetSequence = 0;
let lastRenderedSheetId = null;
let pendingFocusSelector = null;
let scrollLock = null;
let dragState = null;
let closingSheetId = null;
let cancelSheetCloseTransition = null;

const state = {
  token: readStoredValue(TOKEN_STORAGE_KEY),
  tokenDraft: readStoredValue(TOKEN_STORAGE_KEY),
  tokenVisible: false,
  tokenError: '',
  themePreference: readThemePreference(),
  route: 'home',
  auth: readStoredValue(TOKEN_STORAGE_KEY) ? 'checking' : 'required',
  browserConnection: 'idle',
  loading: Boolean(readStoredValue(TOKEN_STORAGE_KEY)),
  overview: null,
  overviewStatus: readStoredValue(TOKEN_STORAGE_KEY) ? 'loading' : 'idle',
  overviewError: '',
  tasks: restoreInFlightTasks(readStoredJson(IN_FLIGHT_STORAGE_KEY, [])),
  screenshots: [],
  pendingDevices: [],
  pendingStatus: readStoredValue(TOKEN_STORAGE_KEY) ? 'loading' : 'idle',
  pendingError: '',
  approvalInProgress: new Set(),
  selectedDevice: readStoredValue(DEVICE_STORAGE_KEY),
  selectedScreenshotId: null,
  events: [],
  missingScreenshotIds: new Set(),
  stopIdleObservedAt: new Map(),
  stopVerificationInFlight: new Set(),
  actionInProgress: new Set(),
  sheet: null,
  toast: null,
};

function readStoredValue(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function writeStoredValue(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // localStorage 受策略禁用时仅维持当前页面会话。
  }
}

function readStoredJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存储失败不影响当前任务追踪。
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatNoteHtml(note) {
  return escapeHtml(note).replaceAll('\n', '<br>');
}

function attr(value) {
  return escapeHtml(value);
}

function taskDefinition(type) {
  return TASK_BY_TYPE.get(type) ?? { type, label: String(type || '未知任务'), description: '远程任务状态由服务端快照确认。' };
}

function taskLabel(type) {
  return taskDefinition(type).label;
}

function taskStatusLabel(status) {
  const labels = {
    queued: '已排队',
    dispatched: '已下发',
    running: '处理中',
    success: '已结束',
    failed: '执行失败',
    stale: '已超时',
    pending_confirmation: '结果待确认',
  };
  return labels[status] ?? '状态未知';
}

function isInFlight(task) {
  return ['queued', 'dispatched', 'running', 'pending_confirmation'].includes(task?.status);
}

function approvedDevices() {
  return (state.overview?.devices ?? []).filter((device) => device.approved);
}

function selectedDeviceRecord() {
  return state.overview?.devices?.find((device) => device.device === state.selectedDevice) ?? null;
}

function pendingIsReady() {
  return state.pendingStatus === 'ready';
}

function pendingApprovalKey(device, id) {
  return device ? `device:${device}` : `id:${id}`;
}

function isPendingDeviceId(id) {
  return typeof id === 'string' && /^[0-9a-f]{64}$/.test(id);
}

function reconcileSelectedDevice() {
  const devices = approvedDevices();
  if (devices.some((device) => device.device === state.selectedDevice)) return;
  // 无有效选择时自动绑定：优先已批准且在线，否则任一已批准；从不绑定 pending。
  const preferred = devices.find((device) => device.online) ?? devices[0];
  state.selectedDevice = preferred?.device ?? '';
  writeStoredValue(DEVICE_STORAGE_KEY, state.selectedDevice);
}

function setSelectedDevice(device) {
  state.selectedDevice = approvedDevices().some((item) => item.device === device) ? device : '';
  writeStoredValue(DEVICE_STORAGE_KEY, state.selectedDevice);
}

function actionKey(type, device = state.selectedDevice) {
  return `${type}::${device || 'none'}`;
}

function taskForAction(type, device = state.selectedDevice) {
  return state.tasks.find((task) => task.type === type && task.device === device && isInFlight(task)) ?? null;
}

function actionFeedback(type, device = state.selectedDevice) {
  if (isActionSending(type, device)) return '正在发送';
  const task = taskForAction(type, device);
  if (!task) return '';
  if (isPendingConfirmationTask(task)) return '结果待确认';
  if (isLongRunningCommandType(type)) return '进行中';
  return taskStatusLabel(task.status);
}

function isActionSending(type, device = state.selectedDevice) {
  return state.actionInProgress.has(actionKey(type, device));
}

function isActionBusy(type, device = state.selectedDevice) {
  return isActionSending(type, device) || Boolean(taskForAction(type, device));
}

function isActionDisabled(type, device = state.selectedDevice) {
  return isActionControlDisabled({
    type,
    sending: isActionSending(type, device),
    inFlight: Boolean(taskForAction(type, device)),
  });
}

function shouldOpenInFlightConfirm(type, device = state.selectedDevice) {
  return shouldOfferInFlightConfirm({
    type,
    sending: isActionSending(type, device),
    inFlight: Boolean(taskForAction(type, device)),
    device: (state.overview?.devices ?? []).find((item) => item.device === device),
  });
}

function canQueueAgain(type, device = state.selectedDevice) {
  return canQueueAgainWhileInFlight({
    sending: isActionSending(type, device),
    device: (state.overview?.devices ?? []).find((item) => item.device === device),
    task: taskForAction(type, device),
  });
}

function renderStuckClearButton(type, { id } = {}) {
  const task = id
    ? state.tasks.find((item) => item.id === id)
    : taskForAction(type);
  if (!isPendingConfirmationTask(task)) return '';
  return renderStuckClearButtonHtml(type, { id, attr });
}

function renderActionFeedbackLine(type, extraClass = '') {
  const feedback = actionFeedback(type);
  if (!feedback) return '';
  const pending = isPendingConfirmationTask(taskForAction(type));
  const className = `feedback-line${extraClass ? ` ${extraClass}` : ''}${pending ? ' feedback-pending' : ''}`;
  return `<p class="${className}"><span>${escapeHtml(feedback)}</span>${pending ? renderStuckClearButton(type) : ''}</p>`;
}

function clearStuckPending(type, { id, device = state.selectedDevice } = {}) {
  const before = state.tasks.length;
  state.tasks = clearPendingConfirmationTasks(state.tasks, id ? { id } : { type, device });
  if (state.tasks.length === before) return;
  saveInFlightTasks();
  setToast('已清除卡住状态。', 'success');
  render();
}

function saveInFlightTasks() {
  writeStoredJson(IN_FLIGHT_STORAGE_KEY, state.tasks.filter((task) => isInFlight(task)).slice(0, 60));
}

function mergeOverviewEvents(events = []) {
  for (const event of events) state.events = mergeEvents(state.events, event);
  state.events = state.events.slice(0, MAX_EVENTS);
}

function mergeTasks(tasks = []) {
  state.tasks = reconcilePendingConfirmationTasks(
    mergeTaskSnapshots(state.tasks, tasks),
    tasks,
    Date.now(),
  );
  saveInFlightTasks();
  scheduleStopVerifications();
}

function formatTime(value) {
  if (!Number.isFinite(value)) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function formatDateTime(value) {
  if (!Number.isFinite(value)) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function deviceStatus(device) {
  if (!device) return { className: 'status-offline', label: '未选择设备' };
  if (!device.approved) return { className: 'status-offline', label: '等待批准' };
  return device.online
    ? { className: 'status-online', label: '设备在线' }
    : { className: 'status-offline', label: '设备离线' };
}

function normalizeOverviewForStopCheck() {
  return {
    ...state.overview,
    devices: (state.overview?.devices ?? []).map((device) => ({
      ...device,
      current_task_id: device.current_task_id ?? '',
    })),
  };
}

function isStopObserved(task) {
  return Boolean(state.stopIdleObservedAt.get(task?.id)) && isStopTaskStopped(task, normalizeOverviewForStopCheck());
}

function currentTaskForDevice(device) {
  if (!device?.current_task_id) return null;
  return state.tasks.find((task) => task.id === device.current_task_id) ?? null;
}

function currentTaskDisplay(device) {
  if (!device) {
    if (state.auth === 'invalid') return { title: 'Token 无效', note: '请重新粘贴 dashboardToken 后再连接。' };
    if (state.auth !== 'authorized' || state.overviewStatus !== 'ready') {
      return state.overviewStatus === 'error'
        ? { title: '设备状态暂不可用', note: state.overviewError || '请刷新后重试。' }
        : { title: '正在加载设备状态', note: '连接成功后会显示已批准设备。' };
    }
    if (!pendingIsReady()) {
      return state.pendingStatus === 'error'
        ? { title: '待批准列表暂不可用', note: state.pendingError || '请刷新后重试。' }
        : { title: '正在读取待批准设备', note: '请稍候，读取完成后再显示设备状态。' };
    }
    if (state.pendingDevices.length) return { title: '等待批准', note: '有设备在敲门，先去批准。' };
    return (state.overview?.devices ?? []).length === 0
      ? { title: '没有已登记设备', note: '可能是 maaUserToken 填错；请对照 config.json 检查。' }
      : { title: '请选择设备', note: '选择已批准设备后才能发送操作。' };
  }
  if (!device.approved) return { title: '等待设备批准', note: '批准后才可以发送远程命令。' };
  if (!device.online) {
    return {
      title: '本机没在线',
      note: '请检查：\n• 睡眠\n• 托盘服务\n• Tunnel',
    };
  }
  if (!device.current_task_id) return { title: '当前空闲', note: '暂无 HeartBeat 观测到的顺序任务。' };
  const task = currentTaskForDevice(device);
  return {
    title: task ? taskLabel(task.type) : device.current_task_id,
    note: task ? '远程命令正在处理；游戏内部进度请查看截图。' : 'MAA 上报的任务标识未出现在本地任务记录中。',
  };
}

function eventText(event) {
  const detail = parseEventDetail(event?.detail) ?? {};
  const device = detail.device || event?.device || '设备';
  if (event?.kind === 'online') return `${device} 已上线`;
  if (event?.kind === 'offline') return `${device} 已离线`;
  if (event?.kind === 'task_started') return `${taskLabel(detail.type)} 已开始`;
  if (event?.kind === 'task_stale') return `${taskLabel(detail.type)} 超时未回报`;
  if (event?.kind === 'task_finished') {
    return detail.status === 'success' ? `${taskLabel(detail.type)} 已回报结束` : `${taskLabel(detail.type)} 回报失败`;
  }
  if (event?.kind === 'screenshot_saved') return '已保存最新截图';
  if (event?.kind === 'device_approved') return `${device} 已批准`;
  return event?.kind || '收到新事件';
}

function eventClass(event) {
  const detail = parseEventDetail(event?.detail) ?? {};
  const suffix = event?.kind === 'task_finished' ? (detail.status === 'success' ? ' is-success' : ' is-failed') : '';
  return `kind-${attr(event?.kind || 'unknown')}${suffix}`;
}

function latestScreenshot() {
  if (state.selectedScreenshotId !== null) {
    const selected = state.screenshots.find((shot) => Number(shot.id) === Number(state.selectedScreenshotId));
    if (selected) return selected;
  }
  return state.screenshots[0] ?? null;
}

function screenshotUrl(id) {
  const url = screenshotObjects.get(String(id));
  return url ? `src="${attr(url)}"` : '';
}

function clearScreenshotObjects() {
  for (const url of screenshotObjects.values()) URL.revokeObjectURL(url);
  screenshotObjects.clear();
  screenshotLoads.clear();
}

// 只为当前显示的图片获取二进制，长期 Token 不进入 DOM 或图片 URL。
function loadVisibleScreenshots() {
  if (!state.token || state.auth !== 'authorized') return;
  const images = [...app.querySelectorAll('img[data-screenshot-id]')];
  const visibleIds = new Set(images.map((image) => image.dataset.screenshotId));
  for (const [id, url] of screenshotObjects) {
    if (!visibleIds.has(id)) { URL.revokeObjectURL(url); screenshotObjects.delete(id); }
  }
  for (const id of visibleIds) {
    if (screenshotObjects.has(id) || screenshotLoads.has(id)) continue;
    const epoch = sessionEpoch;
    const request = api.getScreenshotBlob(id, { signal: sessionController.signal });
    screenshotLoads.set(id, request);
    request.then((blob) => {
      if (epoch !== sessionEpoch || state.auth !== 'authorized') return;
      const targets = [...app.querySelectorAll('img[data-screenshot-id]')].filter((image) => image.dataset.screenshotId === id);
      if (!targets.length) return;
      const url = URL.createObjectURL(blob);
      screenshotObjects.set(id, url);
      for (const image of targets) image.src = url;
    }).catch((error) => {
      if (epoch !== sessionEpoch) return;
      if (error?.status === 404) {
        state.missingScreenshotIds.add(id);
        state.screenshots = state.screenshots.filter((shot) => String(shot.id) !== id);
        refreshScreenshots().catch((refreshError) => {
          if (epoch === sessionEpoch) handleApiError(refreshError, { quiet: true });
        });
        render();
      } else {
        handleApiError(error, { quiet: true });
      }
    }).finally(() => {
      if (screenshotLoads.get(id) === request) screenshotLoads.delete(id);
    });
  }
}

function setToast(message, tone = 'default') {
  state.toast = { message, tone };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    state.toast = null;
    render();
  }, 4500);
}

function renderHeader() {
  const pendingCount = pendingIsReady() ? state.pendingDevices.length : 0;
  return `
    <header class="app-header">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">M</div>
        <div class="brand-copy">
          <div class="brand-title">MAA Remote</div>
          <div class="brand-subtitle">监控与远程控制</div>
        </div>
      </div>
      <div class="header-actions" aria-label="页面操作">
        <button class="icon-button" type="button" data-action="navigate" data-route="monitor" data-focus-id="nav-monitor" aria-label="打开画面与日志" title="画面与日志"><span class="icon-symbol" aria-hidden="true">▣</span></button>
        <button class="icon-button" type="button" data-action="open-theme" data-focus-id="open-theme" aria-label="选择主题" title="主题"><span class="icon-symbol" aria-hidden="true">◐</span></button>
        <button class="icon-button" type="button" data-action="open-settings" data-focus-id="open-settings" aria-label="打开设置与工具" title="设置与工具"><span class="icon-symbol" aria-hidden="true">⚙</span></button>
      </div>
    </header>
    ${pendingCount > 0 ? `<div class="notice-banner notice-warning"><span>有 ${pendingCount} 台设备等待人工批准</span><button class="text-button" type="button" data-action="navigate" data-route="pending" data-focus-id="open-pending">查看</button></div>` : ''}
  `;
}

function renderDeviceCard() {
  const device = selectedDeviceRecord();
  const status = deviceStatus(device);
  const options = approvedDevices().map((item) => `<option value="${attr(item.device)}" ${item.device === state.selectedDevice ? 'selected' : ''}>${escapeHtml(item.device)}</option>`).join('');
  return `
    <section class="data-card device-card" aria-labelledby="device-heading">
      <div class="section-heading">
        <div>
          <h2 id="device-heading" class="heading-title">设备</h2>
          <p class="heading-caption">目标设备由你明确选择</p>
        </div>
        <span class="status-line ${status.className}"><span class="status-dot" aria-hidden="true"></span>${status.label}</span>
      </div>
      <label class="field-label" for="device-select">当前设备</label>
      <select id="device-select" class="select-field" data-action="select-device" aria-label="选择目标设备">
        <option value="">请选择设备</option>
        ${options}
      </select>
      ${device ? `<p class="device-id">设备标识：${escapeHtml(device.device)}</p>` : `<p class="device-id">尚未选择已批准设备。</p>`}
      <div class="inline-actions">
        <button class="text-button" type="button" data-action="navigate" data-route="pending" data-focus-id="device-pending">管理待批准设备</button>
        <button class="text-button" type="button" data-action="refresh" data-focus-id="refresh-overview">刷新</button>
      </div>
    </section>
  `;
}

function renderCurrentTask() {
  const device = selectedDeviceRecord();
  const current = currentTaskDisplay(device);
  const pendingAttention = pendingIsReady() && state.pendingDevices.length > 0;
  const stopTask = state.tasks.find((task) => task.type === 'StopTask' && task.device === state.selectedDevice && task.status === 'success');
  const stopFeedback = stopTask
    ? (isStopObserved(stopTask) ? '已由心跳观测到设备空闲。' : '停止命令已回报，仍在等待心跳确认空闲。')
    : actionFeedback('StopTask');
  return `
    <section class="data-card current-task-card" aria-labelledby="current-task-heading">
      <div class="card-heading">
        <div>
          <h2 id="current-task-heading" class="heading-title">当前状态</h2>
          <p class="heading-caption">来自设备上报与任务快照</p>
        </div>
        ${device ? `<span class="status-line ${deviceStatus(device).className}"><span class="status-dot" aria-hidden="true"></span>${deviceStatus(device).label}</span>` : ''}
      </div>
      <div class="current-task-main">${pendingAttention ? '等待批准' : escapeHtml(current.title)}</div>
      <p class="task-note">${pendingAttention ? '有设备在敲门，先去批准。' : formatNoteHtml(current.note)}</p>
      ${pendingAttention && device ? `<p class="task-note">当前已选设备：${escapeHtml(current.title)}。${formatNoteHtml(current.note)}</p>` : ''}
      ${pendingAttention ? '<button class="primary-button" type="button" data-action="navigate" data-route="pending" data-focus-id="current-pending">去批准</button>' : ''}
      <button class="danger-button stop-button" type="button" data-action="open-stop" data-focus-id="open-stop" ${!device ? 'disabled' : ''}>停止任务</button>
      ${stopFeedback ? `<p class="feedback-line ${stopTask && isStopObserved(stopTask) ? 'status-success' : ''}${isPendingConfirmationTask(taskForAction('StopTask')) ? ' feedback-pending' : ''}"><span>${escapeHtml(stopFeedback)}</span>${renderStuckClearButton('StopTask')}</p>` : ''}
    </section>
  `;
}

function renderQuickActions() {
  const buttons = QUICK_ACTIONS.map((action) => {
    const task = taskForAction(action.type);
    const sending = isActionSending(action.type);
    const pending = isPendingConfirmationTask(task);
    const inFlight = Boolean(task);
    return renderQuickActionWrapHtml({
      action,
      feedback: actionFeedback(action.type),
      pending,
      disabled: isActionDisabled(action.type),
      running: !sending && inFlight && isLongRunningCommandType(action.type) && !pending,
      attr,
      escapeHtml,
    });
  }).join('');
  return `
    <section class="section-card" aria-labelledby="quick-heading">
      <div class="section-heading">
        <div>
          <h2 id="quick-heading" class="heading-title">快捷操作</h2>
          <p class="heading-caption">使用电脑端 MAA 已保存的参数</p>
        </div>
      </div>
      <div class="quick-grid">${buttons}</div>
    </section>
  `;
}

function renderTasks() {
  const tiles = TASKS.map((task) => {
    const feedback = actionFeedback(task.type);
    return `
      <button class="task-tile" type="button" data-action="open-task" data-type="${attr(task.type)}" data-focus-id="task-${attr(task.type)}">
        <span class="task-tile-title">${escapeHtml(task.label)}</span>
        <span class="task-tile-subtitle">${escapeHtml(feedback || '查看详情')}</span>
      </button>
    `;
  }).join('');
  return `
    <section class="section-card" aria-labelledby="tasks-heading">
      <div class="section-heading">
        <div>
          <h2 id="tasks-heading" class="heading-title">任务</h2>
          <p class="heading-caption">选择任务后再单独执行</p>
        </div>
      </div>
      <div class="task-grid">${tiles}</div>
    </section>
  `;
}

function renderScreenshotPreview(compact = false) {
  const shot = latestScreenshot();
  const primary = shot
    ? `<img ${screenshotUrl(shot.id)} data-screenshot-id="${attr(shot.id)}" alt="${escapeHtml(formatDateTime(shot.created_at))} 的 MAA 截图">`
    : `<div class="screenshot-empty"><strong>暂无截图</strong><span>设备回报截图后会显示在这里。</span></div>`;
  const thumbs = state.screenshots.slice(0, 4).map((item) => `
    <button class="thumbnail ${Number(item.id) === Number(shot?.id) ? 'is-active' : ''}" type="button" data-action="select-screenshot" data-id="${attr(item.id)}" data-focus-id="screenshot-${attr(item.id)}" aria-label="查看 ${escapeHtml(formatDateTime(item.created_at))} 的截图">
      <img ${screenshotUrl(item.id)} data-screenshot-id="${attr(item.id)}" alt="">
    </button>
  `).join('');
  return `
    <section class="section-card ${compact ? '' : 'monitor-screenshot'}" aria-labelledby="screen-heading">
      <div class="section-heading">
        <div>
          <h2 id="screen-heading" class="heading-title">最新画面</h2>
          <p class="heading-caption">${shot ? escapeHtml(formatDateTime(shot.created_at)) : '等待设备回报'}</p>
        </div>
        ${compact ? `<button class="text-button" type="button" data-action="navigate" data-route="monitor" data-focus-id="open-monitor">全部</button>` : ''}
      </div>
      <div class="screenshot-preview">${primary}</div>
      ${thumbs ? `<div class="thumb-row">${thumbs}</div>` : ''}
      <div class="button-row" style="margin-top: 12px;">
        <button class="primary-button" type="button" data-action="capture-image" data-focus-id="capture-image" ${isActionDisabled('CaptureImageNow') ? 'disabled' : ''}>${escapeHtml(actionFeedback('CaptureImageNow') || '立即截图')}</button>
        ${renderStuckClearButton('CaptureImageNow')}
      </div>
    </section>
  `;
}

function renderEvents(limit = 6) {
  const rows = state.events.slice(0, limit).map((event) => `
    <li class="event-item ${eventClass(event)}">
      <span class="event-marker" aria-hidden="true"></span>
      <div>
        <div class="event-title">${escapeHtml(eventText(event))}</div>
        <div class="event-meta">${escapeHtml(formatTime(event.created_at))} · ${escapeHtml(event.device || '未知设备')}</div>
      </div>
    </li>
  `).join('');
  const streamText = state.browserConnection === 'connected'
    ? '浏览器实时连接中'
    : state.browserConnection === 'reconnecting' ? '正在重连实时事件' : '等待实时连接';
  return `
    <section class="section-card" aria-labelledby="events-heading">
      <div class="section-heading">
        <div>
          <h2 id="events-heading" class="heading-title">实时事件</h2>
          <p class="heading-caption">${streamText}</p>
        </div>
        <button class="text-button" type="button" data-action="navigate" data-route="monitor" data-focus-id="open-events">查看</button>
      </div>
      ${rows ? `<ol class="event-list">${rows}</ol>` : `<div class="empty-state"><strong>暂无事件</strong><span>新事件会按时间显示在这里。</span></div>`}
    </section>
  `;
}

function renderLoadingColumn() {
  return `
    <section class="section-card" aria-label="正在加载">
      <div class="skeleton" style="width: 42%;"></div>
      <div class="skeleton" style="height: 44px; margin-top: 18px;"></div>
      <div class="skeleton" style="height: 92px; margin-top: 12px;"></div>
    </section>
  `;
}

function renderDashboard() {
  if (state.loading && !state.overview) {
    return `<main class="app-main"><div class="dashboard-grid"><div class="dashboard-column">${renderLoadingColumn()}</div><div class="dashboard-column">${renderLoadingColumn()}</div><div class="dashboard-column">${renderLoadingColumn()}</div></div></main>`;
  }
  const authNotice = state.auth === 'required' || state.auth === 'invalid'
    ? `<div class="notice-banner notice-error"><span>${state.auth === 'invalid' ? 'Token 无效，连接已暂停。' : '设置 Token 后即可连接仪表盘。'}</span><button class="text-button" type="button" data-action="open-token" data-focus-id="token-notice">设置 Token</button></div>`
    : '';
  const overviewNotice = state.overviewStatus === 'error'
    ? `<div class="notice-banner notice-error"><span>设备状态暂时无法加载。${escapeHtml(state.overviewError || '请刷新后重试。')}</span><button class="text-button" type="button" data-action="refresh" data-focus-id="retry-overview">重试</button></div>`
    : '';
  return `
    <main class="app-main">
      ${authNotice}
      ${overviewNotice}
      <div class="dashboard-grid">
        <div class="dashboard-column">${renderDeviceCard()}${renderCurrentTask()}${renderQuickActions()}</div>
        <div class="dashboard-column">${renderTasks()}</div>
        <div class="dashboard-column">${renderScreenshotPreview(true)}${renderEvents(6)}</div>
      </div>
    </main>
  `;
}

function renderTaskHistory() {
  const rows = state.tasks.slice(0, 12).map((task) => `
    <li class="history-item">
      <span class="status-dot status-${attr(task.status)}" aria-hidden="true"></span>
      <div>
        <div class="history-title">${escapeHtml(taskLabel(task.type))}</div>
        <div class="history-meta">${escapeHtml(taskStatusLabel(task.status))} · ${escapeHtml(formatDateTime(task.created_at))}</div>
        ${isPendingConfirmationTask(task) ? renderStuckClearButton(task.type, { id: task.id }) : ''}
      </div>
    </li>
  `).join('');
  return `
    <section class="section-card" aria-labelledby="history-heading">
      <div class="section-heading">
        <div>
          <h2 id="history-heading" class="heading-title">任务记录</h2>
          <p class="heading-caption">以服务端任务 ID 和状态为准</p>
        </div>
      </div>
      ${rows ? `<ol class="task-history">${rows}</ol>` : `<div class="empty-state"><strong>暂无任务记录</strong><span>发送任务后会显示实际状态。</span></div>`}
    </section>
  `;
}

function renderMonitor() {
  return `
    <main class="app-main page-panel">
      <div class="page-heading">
        <div>
          <h1 class="page-title">画面与日志</h1>
          <p class="page-caption">最新截图、历史截图与设备事件</p>
        </div>
        <button class="secondary-button" type="button" data-action="navigate" data-route="home" data-focus-id="back-home">返回首页</button>
      </div>
      <div class="monitor-grid">
        <div class="dashboard-column">${renderScreenshotPreview(false)}${renderTaskHistory()}</div>
        <div class="dashboard-column">${renderEvents(40)}</div>
      </div>
    </main>
  `;
}

function renderPendingDevices() {
  const rows = pendingIsReady() ? state.pendingDevices.map((device) => {
    const id = typeof device?.id === 'string' ? device.id : '';
    const deviceName = typeof device?.device === 'string' ? device.device : '';
    const approvalKey = pendingApprovalKey(deviceName, id);
    const busy = state.approvalInProgress.has(approvalKey) || state.approvalInProgress.has(`id:${id}`);
    const valid = isPendingDeviceId(id);
    return `
      <li class="pending-item">
        <div>
          <div class="pending-device">${escapeHtml(deviceName || '未知设备')}</div>
          <div class="metadata">首次发现：${escapeHtml(formatDateTime(device?.first_seen))}</div>
        </div>
        <button class="primary-button" type="button" data-action="approve-device" data-id="${attr(id)}" data-device="${attr(deviceName)}" data-focus-id="approve-${attr(id)}" ${!valid || busy ? 'disabled' : ''}>${busy ? '正在批准' : valid ? '批准' : '记录无效'}</button>
      </li>
    `;
  }).join('') : '';
  const content = state.auth === 'invalid'
    ? `<div class="empty-state"><strong>Token 无效，无法读取待批准设备</strong><span>请重新设置 dashboardToken 后再试。</span><button class="secondary-button" type="button" data-action="open-token" data-focus-id="pending-token">设置 Token</button></div>`
    : state.auth === 'required'
      ? `<div class="empty-state"><strong>尚未连接仪表盘</strong><span>请先验证 dashboardToken。</span><button class="secondary-button" type="button" data-action="open-token" data-focus-id="pending-token">设置 Token</button></div>`
      : state.auth === 'checking'
        ? `<div class="empty-state"><strong>正在连接仪表盘</strong><span>请稍候，连接成功后会读取待批准设备。</span></div>`
      : state.pendingStatus === 'error'
    ? `<div class="empty-state"><strong>待批准设备暂时无法读取</strong><span>${escapeHtml(state.pendingError || '请刷新后重试。')}</span><button class="secondary-button" type="button" data-action="refresh" data-focus-id="retry-pending">重试</button></div>`
    : state.pendingStatus !== 'ready'
      ? `<div class="empty-state"><strong>正在读取待批准设备</strong><span>请稍候，读取成功后会显示设备记录。</span></div>`
      : rows
        ? `<ol class="pending-list">${rows}</ol>`
        : `<div class="empty-state"><strong>没有待批准设备</strong><span>未知设备请求连接时会显示在这里。</span></div>`;
  return `
    <main class="app-main page-panel">
      <div class="page-heading">
        <div>
          <h1 class="page-title">待批准设备</h1>
          <p class="page-caption">请核对完整 device 标识后再批准。</p>
        </div>
        <button class="secondary-button" type="button" data-action="navigate" data-route="home" data-focus-id="back-from-pending">返回首页</button>
      </div>
      <section class="section-card">
        ${content}
      </section>
    </main>
  `;
}

function renderTaskSheet(sheet) {
  const task = sheet.task;
  return `
    <div class="sheet-heading"><div><h2 class="sheet-title">${escapeHtml(task.label)}</h2><p class="sheet-caption">单项任务</p></div></div>
    <p class="sheet-copy">使用电脑端 MAA 已保存的参数。</p>
    <p class="sheet-note">单独执行该任务，不改变电脑端的勾选状态。其他任务进行中时会排队等待。</p>
    <p class="sheet-note">结果回报仅表示远程任务已结束，可查看截图确认游戏结果。</p>
    ${task.type === 'LinkStart-Combat' ? `<button class="secondary-button" type="button" data-action="open-setting" data-setting="Settings-Stage1" data-focus-id="open-stage-from-task">修改作战关卡</button>` : ''}
    ${renderActionFeedbackLine(task.type)}
    <div class="sheet-actions">
      <button class="secondary-button" type="button" data-action="close-sheet">返回</button>
      <button class="primary-button" type="button" data-action="submit-task" data-type="${attr(task.type)}" ${isActionDisabled(task.type) ? 'disabled' : ''}>${escapeHtml(isActionSending(task.type) ? '正在发送' : '单独执行该任务')}</button>
    </div>
  `;
}

function renderThemeSheet() {
  const choices = [
    ['system', '跟随系统', '根据设备系统外观显示'],
    ['light', '浅色', '使用浅色界面'],
    ['dark', '深色', '使用深色界面'],
  ];
  const inputs = choices.map(([value, label, detail]) => `
    <label class="radio-option"><input type="radio" name="theme" value="${value}" data-theme-choice ${state.themePreference === value ? 'checked' : ''}><span><strong>${label}</strong><span class="sheet-menu-detail">${detail}</span></span></label>
  `).join('');
  return `
    <div class="sheet-heading"><div><h2 class="sheet-title">主题</h2><p class="sheet-caption">外观会保存在本机</p></div></div>
    <div class="radio-list">${inputs}</div>
    <div class="sheet-actions single"><button class="secondary-button" type="button" data-action="close-sheet">完成</button></div>
  `;
}

function renderTokenSheet(sheet) {
  const inputType = state.tokenVisible ? 'text' : 'password';
  return `
    <div class="sheet-heading"><div><h2 class="sheet-title">Token 设置</h2><p class="sheet-caption">打开本机 server/config.json，复制 dashboardToken 粘贴到这里</p></div></div>
    <form data-form="token">
      <label class="field-label" for="token-input">访问 Token</label>
      <div class="token-input-wrap">
        <input id="token-input" class="text-input ${state.tokenError ? 'input-error' : ''}" name="token" data-field="token" data-focus-key="token-input" type="${inputType}" value="${attr(state.tokenDraft)}" autocomplete="current-password" spellcheck="false" required>
        <button class="input-toggle" type="button" data-action="toggle-token">${state.tokenVisible ? '隐藏' : '显示'}</button>
      </div>
      <p class="sheet-note">不是 MAA 里的用户标识符。仅在本机保存，勿分享给他人。</p>
      ${state.tokenError ? `<p class="form-error"><span aria-hidden="true">!</span><span>${escapeHtml(state.tokenError)}</span></p>` : ''}
      <div class="sheet-actions">
        <button class="secondary-button" type="button" data-action="clear-token">清除</button>
        <button class="primary-button" type="submit" ${sheet.submitting ? 'disabled' : ''}>${sheet.submitting ? '正在验证' : '验证并连接'}</button>
      </div>
    </form>
  `;
}

function renderSettingsSheet() {
  return `
    <div class="sheet-heading"><div><h2 class="sheet-title">设置与工具</h2><p class="sheet-caption">需要确认的操作会再次提示后果</p></div></div>
    <div class="sheet-menu">
      <button class="sheet-menu-button" type="button" data-action="open-token" data-focus-id="settings-token"><span><span class="sheet-menu-title">Token 设置</span><span class="sheet-menu-detail">修改或重新验证访问 Token</span></span><span class="sheet-menu-arrow" aria-hidden="true">›</span></button>
      <button class="sheet-menu-button" type="button" data-action="open-setting" data-setting="Settings-ConnectAddress" data-focus-id="settings-address"><span><span class="sheet-menu-title">连接地址</span><span class="sheet-menu-detail">排队更新 MAA 连接地址</span></span><span class="sheet-menu-arrow" aria-hidden="true">›</span></button>
      <button class="sheet-menu-button" type="button" data-action="open-setting" data-setting="Settings-Stage1" data-focus-id="settings-stage"><span><span class="sheet-menu-title">第一关卡</span><span class="sheet-menu-detail">替换为单关卡计划</span></span><span class="sheet-menu-arrow" aria-hidden="true">›</span></button>
      <button class="sheet-menu-button" type="button" data-action="open-gacha" data-focus-id="settings-gacha"><span><span class="sheet-menu-title">工具箱抽卡</span><span class="sheet-menu-detail">单抽或十连均需确认消耗风险</span></span><span class="sheet-menu-arrow" aria-hidden="true">›</span></button>
    </div>
    <div class="sheet-actions single"><button class="secondary-button" type="button" data-action="close-sheet">关闭</button></div>
  `;
}

function renderSettingInputSheet(sheet) {
  const isAddress = sheet.setting === 'Settings-ConnectAddress';
  const title = isAddress ? '连接地址' : '第一关卡';
  const hint = isAddress ? '例如：127.0.0.1:16384' : '例如：1-7';
  return `
    <div class="sheet-heading"><div><h2 class="sheet-title">${title}</h2><p class="sheet-caption">点击下一步核对变更</p></div></div>
    <form data-form="setting">
      <label class="field-label" for="setting-input">${isAddress ? '连接地址' : '作战关卡'}</label>
      <input id="setting-input" class="text-input" name="settingValue" data-field="setting" data-focus-key="setting-input" type="text" value="${attr(sheet.value || '')}" placeholder="${hint}" required>
      <p class="sheet-note">${isAddress ? '其他任务进行中时会排队等待。' : '多关卡计划将被清空并替换为单关卡。'}</p>
      <div class="sheet-actions">
        <button class="secondary-button" type="button" data-action="back-sheet">返回</button>
        <button class="primary-button" type="submit">下一步</button>
      </div>
    </form>
  `;
}

function renderGachaSheet() {
  return `
    <div class="sheet-heading"><div><h2 class="sheet-title">工具箱抽卡</h2><p class="sheet-caption">选择后会再次确认</p></div></div>
    <p class="sheet-warning">抽卡会消耗游戏内资源，请确认当前目标设备和游戏状态。</p>
    <div class="sheet-menu">
      <button class="sheet-menu-button" type="button" data-action="confirm-gacha" data-type="Toolbox-GachaOnce" data-focus-id="gacha-once"><span><span class="sheet-menu-title">单抽</span><span class="sheet-menu-detail">执行一次抽卡</span></span><span class="sheet-menu-arrow" aria-hidden="true">›</span></button>
      <button class="sheet-menu-button" type="button" data-action="confirm-gacha" data-type="Toolbox-GachaTenTimes" data-focus-id="gacha-ten"><span><span class="sheet-menu-title">十连</span><span class="sheet-menu-detail">执行一次十连抽卡</span></span><span class="sheet-menu-arrow" aria-hidden="true">›</span></button>
    </div>
    <div class="sheet-actions single"><button class="secondary-button" type="button" data-action="back-sheet">返回</button></div>
  `;
}

function renderConfirmSheet(sheet) {
  const type = sheet.type;
  const stop = type === 'StopTask';
  const stage = type === 'Settings-Stage1';
  const gacha = type.startsWith('Toolbox-Gacha');
  const title = stop ? '请确认操作' : gacha ? '确认抽卡' : '请确认操作';
  const actionLabel = stop ? '发送停止命令' : gacha ? '确认执行' : '确认变更';
  const detail = stop
    ? '将尝试停止当前任务。命令回报后仍需等待心跳确认；队列中后续任务可能继续执行。'
    : gacha
      ? `该操作会消耗游戏内资源。确认后将向已选择设备下发 ${taskLabel(type)}。`
      : `将向已选择设备排队下发${stage ? '新的第一关卡' : '新的连接地址'}。`;
  const warning = stop
    ? `当前远程任务：${currentTaskDisplay(selectedDeviceRecord()).title}`
    : stage
      ? '多关卡计划将被清空并替换为单关卡。'
      : gacha
        ? '请确认游戏内资源与目标设备无误。'
        : '其他任务进行中时会排队等待。';
  return `
    <div class="sheet-heading"><div><h2 class="sheet-title">${title}</h2><p class="sheet-caption">此操作不会自动撤销</p></div></div>
    <p class="sheet-copy">${escapeHtml(detail)}</p>
    <p class="sheet-warning">${escapeHtml(warning)}</p>
    <p class="sheet-note">关闭面板不会撤销已发送的指令。</p>
    ${renderActionFeedbackLine(type)}
    <div class="sheet-actions">
      <button class="secondary-button" type="button" data-action="back-sheet">取消</button>
      <button class="danger-button" type="button" data-action="confirm-task" data-type="${attr(type)}" ${isActionDisabled(type) ? 'disabled' : ''}>${escapeHtml(isActionSending(type) ? '正在发送' : actionLabel)}</button>
    </div>
  `;
}

function renderInFlightSheet(sheet) {
  const type = sheet.type;
  const task = taskForAction(type);
  const pending = isPendingConfirmationTask(task);
  return renderInFlightSheetHtml({
    type,
    label: taskLabel(type),
    pending,
    sending: isActionSending(type),
    queueAgainEnabled: canQueueAgain(type),
    stopDisabled: isActionDisabled('StopTask'),
    observedCurrent: hasObservedCurrentTask(selectedDeviceRecord()),
    realInFlight: isUnfinishedServerTask(task),
    attr,
    escapeHtml,
    stuckClearButtonHtml: pending ? renderStuckClearButton(type) : '',
  });
}

function renderSheet() {
  const sheet = state.sheet;
  if (!sheet) return '';
  let content = '';
  if (sheet.kind === 'task') content = renderTaskSheet(sheet);
  if (sheet.kind === 'theme') content = renderThemeSheet(sheet);
  if (sheet.kind === 'token') content = renderTokenSheet(sheet);
  if (sheet.kind === 'settings') content = renderSettingsSheet(sheet);
  if (sheet.kind === 'setting') content = renderSettingInputSheet(sheet);
  if (sheet.kind === 'gacha') content = renderGachaSheet(sheet);
  if (sheet.kind === 'confirm') content = renderConfirmSheet(sheet);
  if (sheet.kind === 'inflight') content = renderInFlightSheet(sheet);
  return `
    <div class="sheet-layer" data-sheet-layer>
      <button class="sheet-dismiss-area" type="button" data-action="dismiss-sheet" aria-label="关闭面板"></button>
      <section class="sheet-panel" id="sheet-panel" role="dialog" aria-modal="true" aria-label="${attr(sheet.title || '操作面板')}" tabindex="-1">
        <div class="sheet-handle-zone" data-sheet-handle aria-label="拖动关闭面板"><span class="sheet-handle" aria-hidden="true"></span></div>
        <div class="sheet-content">${content}</div>
      </section>
    </div>
  `;
}

function renderToast() {
  if (!state.toast) return '<div class="toast-region" aria-live="polite"></div>';
  return `<div class="toast-region" aria-live="polite"><div class="toast is-${attr(state.toast.tone)}">${escapeHtml(state.toast.message)}</div></div>`;
}

function render() {
  if (closingSheetId !== null) return;
  const sheetId = state.sheet?.id ?? null;
  const main = state.route === 'monitor'
    ? renderMonitor()
    : state.route === 'pending'
      ? renderPendingDevices()
      : renderDashboard();
  app.innerHTML = `<div class="app-shell">${renderHeader()}${main}</div>${renderSheet()}${renderToast()}`;
  loadVisibleScreenshots();
  updateRenderedSheetState(sheetId);
}

function lockPageScroll() {
  if (scrollLock) return;
  const y = window.scrollY;
  scrollLock = {
    y,
    position: document.body.style.position,
    top: document.body.style.top,
    left: document.body.style.left,
    right: document.body.style.right,
    width: document.body.style.width,
    overflow: document.body.style.overflow,
  };
  document.body.style.position = 'fixed';
  document.body.style.top = `-${y}px`;
  document.body.style.left = '0';
  document.body.style.right = '0';
  document.body.style.width = '100%';
  document.body.style.overflow = 'hidden';
}

function unlockPageScroll() {
  if (!scrollLock) return;
  const lock = scrollLock;
  document.body.style.position = lock.position;
  document.body.style.top = lock.top;
  document.body.style.left = lock.left;
  document.body.style.right = lock.right;
  document.body.style.width = lock.width;
  document.body.style.overflow = lock.overflow;
  scrollLock = null;
  window.scrollTo(0, lock.y);
}

function focusFirstInSheet() {
  const panel = document.querySelector('#sheet-panel');
  if (!panel) return;
  const preferred = panel.querySelector('[data-focus-key], input, button:not([disabled]), select:not([disabled])');
  (preferred ?? panel).focus({ preventScroll: true });
}

function updateRenderedSheetState(sheetId) {
  const opened = sheetId !== null && sheetId !== lastRenderedSheetId;
  const closed = sheetId === null && lastRenderedSheetId !== null;
  if (opened) {
    lockPageScroll();
    window.requestAnimationFrame(focusFirstInSheet);
  }
  if (closed) {
    unlockPageScroll();
    const selector = pendingFocusSelector;
    pendingFocusSelector = null;
    window.requestAnimationFrame(() => {
      const target = selector ? document.querySelector(selector) : null;
      if (target && typeof target.focus === 'function') {
        target.focus({ preventScroll: true });
      }
    });
  }
  lastRenderedSheetId = sheetId;
}

function openSheet(spec, trigger = null) {
  cancelActiveSheetClose();
  const previous = state.sheet;
  const focusId = trigger?.dataset?.focusId || '';
  state.sheet = {
    ...spec,
    id: ++sheetSequence,
    title: spec.title || '操作面板',
    previous,
    context: captureSheetContext({ trigger, scrollY: window.scrollY }),
    restoreFocusId: focusId,
  };
  render();
}

function cancelActiveSheetClose() {
  cancelSheetCloseTransition?.();
  cancelSheetCloseTransition = null;
  closingSheetId = null;
}

function finishSheetClose(closing) {
  if (state.sheet?.id !== closing.id) return;
  pendingFocusSelector = closing.restoreFocusId ? `[data-focus-id="${closing.restoreFocusId}"]` : null;
  state.sheet = null;
  render();
}

function closeSheet() {
  const closing = state.sheet;
  if (!closing || closingSheetId === closing.id) return;
  const layer = document.querySelector('[data-sheet-layer]');
  const panel = document.querySelector('#sheet-panel');
  if (!layer || !panel) {
    finishSheetClose(closing);
    return;
  }
  closingSheetId = closing.id;
  cancelSheetCloseTransition = startSheetCloseTransition({
    layer,
    panel,
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    onComplete() {
      cancelSheetCloseTransition = null;
      closingSheetId = null;
      finishSheetClose(closing);
    },
  });
}

function backSheet() {
  cancelActiveSheetClose();
  const previous = state.sheet?.previous;
  if (!previous) {
    closeSheet();
    return;
  }
  state.sheet = {
    ...previous,
    id: ++sheetSequence,
    previous: previous.previous ?? null,
  };
  render();
}

function setTheme(preference) {
  state.themePreference = writeThemePreference(localStorage, preference);
  applyTheme(state.themePreference, { mediaQuery: colorScheme });
  render();
}

function stopEventStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  if (authVerifyTimer) {
    clearTimeout(authVerifyTimer);
    authVerifyTimer = null;
  }
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// 凭据变更是异步边界：取消网络请求，并阻止已排队的旧回调回填状态。
function invalidateSession() {
  sessionEpoch += 1;
  sessionController.abort();
  sessionController = new AbortController();
  stopEventStream();
  stopPolling();
  if (eventRefreshTimer) clearTimeout(eventRefreshTimer);
  eventRefreshTimer = null;
  clearScreenshotObjects();
  return sessionEpoch;
}

function clearPrivateState() {
  state.overview = null;
  state.overviewStatus = 'idle';
  state.overviewError = '';
  state.tasks = [];
  state.screenshots = [];
  state.pendingDevices = [];
  state.pendingStatus = 'idle';
  state.pendingError = '';
  state.approvalInProgress.clear();
  state.selectedDevice = '';
  state.selectedScreenshotId = null;
  state.events = [];
  state.missingScreenshotIds.clear();
  state.stopIdleObservedAt.clear();
  state.stopVerificationInFlight.clear();
  state.actionInProgress.clear();
  state.loading = false;
  state.toast = null;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  writeStoredValue(DEVICE_STORAGE_KEY, '');
  writeStoredValue(IN_FLIGHT_STORAGE_KEY, '');
  cancelSheetCloseTransition?.();
  cancelSheetCloseTransition = null;
  closingSheetId = null;
  // 清掉返回栈中可能携带的设备、任务和设置参数。
  if (state.sheet?.kind === 'token') state.sheet.previous = null;
  else state.sheet = null;
}

function startPolling() {
  stopPolling();
  if (!state.token || state.auth === 'invalid') return;
  pollTimer = window.setInterval(() => {
    refreshSnapshots({ includePending: true }).catch(() => {});
  }, POLL_INTERVAL_MS);
}

function pauseForUnauthorized(error) {
  invalidateSession();
  clearPrivateState();
  state.auth = 'invalid';
  state.browserConnection = 'idle';
  state.loading = false;
  state.tokenError = mapApiError(error);
  state.sheet = {
    kind: 'token',
    title: 'Token 设置',
    id: ++sheetSequence,
    submitting: false,
    previous: null,
    context: captureSheetContext({ trigger: null, scrollY: window.scrollY }),
    restoreFocusId: '',
  };
  setToast('Token 无效，已暂停同步。', 'error');
  render();
}

function handleApiError(error, { quiet = false } = {}) {
  if (error instanceof ApiClientError && error.status === 401) {
    pauseForUnauthorized(error);
    return 'unauthorized';
  }
  const message = error instanceof ApiClientError ? error.message : mapApiError(error);
  if (!quiet) setToast(message, error?.status === 429 ? 'error' : 'default');
  return 'other';
}

function applyOverview(payload) {
  if (!payload || !Array.isArray(payload.devices)) return false;
  state.overview = payload;
  mergeOverviewEvents(Array.isArray(payload.events) ? payload.events : []);
  reconcileSelectedDevice();
  state.overviewStatus = 'ready';
  state.overviewError = '';
  return true;
}

function applyTasks(payload) {
  mergeTasks(payload?.tasks ?? []);
}

function applyScreenshots(payload) {
  state.screenshots = (payload?.screenshots ?? []).filter((item) => !state.missingScreenshotIds.has(String(item.id)));
  if (state.selectedScreenshotId !== null && !state.screenshots.some((item) => Number(item.id) === Number(state.selectedScreenshotId))) {
    state.selectedScreenshotId = null;
  }
}

function applyPending(payload) {
  if (!payload || !Array.isArray(payload.devices)) return false;
  state.pendingDevices = payload.devices.filter((item) => item && typeof item === 'object');
  state.pendingStatus = 'ready';
  state.pendingError = '';
  return true;
}

function scheduleStopVerifications() {
  if (!state.token || state.auth === 'invalid') return;
  for (const task of state.tasks) {
    if (task?.type !== 'StopTask' || task.status !== 'success' || !task.id || !task.device) continue;
    if (state.stopIdleObservedAt.has(task.id) || state.stopVerificationInFlight.has(task.id)) continue;
    verifyStopIdleAfterCompletion(task).catch(() => {});
  }
}

async function verifyStopIdleAfterCompletion(task) {
  const epoch = sessionEpoch;
  state.stopVerificationInFlight.add(task.id);
  try {
    // 这一次 overview 请求在已观察到 StopTask success 后才发出，避免把早于回报的本地空闲状态当作完成。
    const overview = await api.getOverview({ signal: sessionController.signal });
    if (epoch !== sessionEpoch) return;
    applyOverview(overview);
    if (isStopTaskStopped(task, normalizeOverviewForStopCheck())) {
      state.stopIdleObservedAt.set(task.id, Date.now());
    } else {
      state.stopIdleObservedAt.delete(task.id);
    }
  } catch (error) {
    if (epoch !== sessionEpoch) return;
    handleApiError(error, { quiet: true });
  } finally {
    if (epoch === sessionEpoch) {
      state.stopVerificationInFlight.delete(task.id);
      render();
    }
  }
}

async function refreshScreenshots() {
  if (!state.token || state.auth === 'invalid') return;
  const epoch = sessionEpoch;
  let payload;
  try {
    payload = await api.getScreenshots(50, { signal: sessionController.signal });
  } catch (error) {
    if (epoch !== sessionEpoch) return;
    throw error;
  }
  if (epoch !== sessionEpoch) return;
  applyScreenshots(payload);
  render();
}

async function refreshSnapshots({ includePending = false, quiet = false } = {}) {
  if (!state.token || state.auth === 'invalid') return false;
  const epoch = sessionEpoch;
  const requestSequence = ++snapshotRequestSequence;
  if (!state.overview) {
    state.overviewStatus = 'loading';
    state.overviewError = '';
  }
  if (includePending) {
    state.pendingStatus = 'loading';
    state.pendingError = '';
  }
  const options = { signal: sessionController.signal };
  const requests = [
    api.getOverview(options),
    api.getTasks(50, options),
    api.getScreenshots(50, options),
  ];
  if (includePending) requests.push(api.getPendingDevices(options));
  const results = await Promise.allSettled(requests);
  if (epoch !== sessionEpoch || requestSequence !== snapshotRequestSequence) return false;
  // 任一接口的 401 都先使整批快照失效，不能先渲染其他成功结果。
  const unauthorized = results.find((result) => result.status === 'rejected' && result.reason?.status === 401);
  if (unauthorized) {
    pauseForUnauthorized(unauthorized.reason);
    return false;
  }
  let authorized = true;
  let authenticatedResponse = false;
  if (results[0].status === 'fulfilled') {
    authenticatedResponse = true;
    if (!applyOverview(results[0].value)) {
      state.overviewStatus = 'error';
      state.overviewError = '服务返回的设备状态无效，请刷新后重试。';
    }
  } else {
    if (handleApiError(results[0].reason, { quiet }) === 'unauthorized') authorized = false;
    state.overviewStatus = 'error';
    state.overviewError = results[0].reason instanceof ApiClientError ? results[0].reason.message : mapApiError(results[0].reason);
  }
  if (results[1].status === 'fulfilled') {
    authenticatedResponse = true;
    applyTasks(results[1].value);
  } else if (handleApiError(results[1].reason, { quiet: true }) === 'unauthorized') authorized = false;
  if (results[2].status === 'fulfilled') {
    authenticatedResponse = true;
    applyScreenshots(results[2].value);
  } else if (handleApiError(results[2].reason, { quiet: true }) === 'unauthorized') authorized = false;
  if (includePending && results[3]?.status === 'fulfilled') {
    authenticatedResponse = true;
    if (!applyPending(results[3].value)) {
      state.pendingStatus = 'error';
      state.pendingError = '服务返回的待批准设备数据无效，请刷新后重试。';
    }
  } else if (includePending && results[3]?.status === 'rejected') {
    handleApiError(results[3].reason, { quiet: true });
    state.pendingStatus = 'error';
    state.pendingError = results[3].reason instanceof ApiClientError ? results[3].reason.message : mapApiError(results[3].reason);
  }
  if (!authorized) return false;
  if (authenticatedResponse) state.auth = 'authorized';
  state.loading = false;
  render();
  return authenticatedResponse || state.auth === 'authorized';
}

function scheduleEventRefresh() {
  if (eventRefreshTimer) clearTimeout(eventRefreshTimer);
  eventRefreshTimer = window.setTimeout(() => {
    eventRefreshTimer = null;
    refreshSnapshots({ includePending: true, quiet: true }).catch(() => {});
  }, EVENT_REFRESH_DELAY_MS);
}

function ingestEvent(event) {
  if (!event || event.id === undefined || event.id === null) return;
  state.events = mergeEvents(state.events, event).slice(0, MAX_EVENTS);
  const detail = parseEventDetail(event.detail) ?? {};
  if (event.kind === 'screenshot_saved' && detail.screenshot_id) {
    state.missingScreenshotIds.delete(String(detail.screenshot_id));
  }
  scheduleEventRefresh();
  render();
}

function startEventStream() {
  if (!state.token || state.auth === 'invalid' || eventSource) return;
  const epoch = sessionEpoch;
  try {
    eventSource = api.openEvents({
      onEvent(event) {
        if (epoch !== sessionEpoch) return;
        ingestEvent(event);
      },
      onOpen() {
        if (epoch !== sessionEpoch) return;
        if (state.browserConnection !== 'connected') {
          state.browserConnection = 'connected';
          render();
        }
        scheduleEventRefresh();
      },
      onError() {
        if (epoch !== sessionEpoch) return;
        if (state.auth === 'invalid') return;
        if (state.browserConnection !== 'reconnecting') {
          state.browserConnection = 'reconnecting';
          render();
        }
        if (!authVerifyTimer) {
          authVerifyTimer = window.setTimeout(async () => {
            if (epoch !== sessionEpoch) return;
            authVerifyTimer = null;
            try {
              await api.getOverview({ signal: sessionController.signal });
            } catch (error) {
              if (epoch !== sessionEpoch) return;
              handleApiError(error, { quiet: true });
            }
          }, 3000);
        }
      },
    });
  } catch (error) {
    state.browserConnection = 'idle';
    handleApiError(error, { quiet: true });
  }
}

async function syncAll({ includePending = true } = {}) {
  const epoch = sessionEpoch;
  if (!state.token) {
    state.loading = false;
    state.auth = 'required';
    render();
    return false;
  }
  state.loading = true;
  render();
  const okay = await refreshSnapshots({ includePending, quiet: false });
  if (okay && epoch === sessionEpoch) {
    startEventStream();
    startPolling();
  }
  return okay;
}

function pendingTask(type, device) {
  return {
    id: `pending:${Date.now()}:${type}:${device || 'unknown'}`,
    type,
    device,
    status: 'pending_confirmation',
    created_at: Date.now(),
    pendingConfirmation: true,
  };
}

async function sendTask(type, { params, confirm = false, force = false } = {}) {
  const epoch = sessionEpoch;
  const definition = taskDefinition(type);
  if (!state.token || state.auth !== 'authorized') {
    state.tokenError = state.auth === 'invalid' ? 'Token 无效，请重新粘贴后验证。' : '';
    openSheet({ kind: 'token', title: 'Token 设置', submitting: false });
    return false;
  }
  const device = state.selectedDevice;
  if (!device) {
    setToast('请选择要操作的已批准设备。', 'error');
    render();
    return false;
  }
  if (isActionSending(type, device) || (!force && isActionBusy(type, device))) return false;
  if (force && isLongRunningCommandType(type) && !canQueueAgain(type, device)) return false;
  const key = actionKey(type, device);
  state.actionInProgress.add(key);
  render();
  const body = { type, device };
  if (params !== undefined) body.params = params;
  if (confirm) body.confirm = true;
  try {
    const response = await api.sendTask(body, { signal: sessionController.signal });
    if (epoch !== sessionEpoch) return false;
    mergeTasks([response]);
    setToast(`${definition.label}已排队。`, 'success');
    scheduleEventRefresh();
    return true;
  } catch (error) {
    if (epoch !== sessionEpoch) return false;
    if (error instanceof ApiClientError && ['timeout', 'network'].includes(error.kind)) {
      mergeTasks([pendingTask(type, device)]);
      setToast('请求结果待确认，请查看任务记录；不会自动重发。', 'error');
    } else {
      handleApiError(error);
    }
    return false;
  } finally {
    if (epoch === sessionEpoch) {
      state.actionInProgress.delete(key);
      saveInFlightTasks();
      render();
    }
  }
}

async function validateToken(token) {
  const candidate = String(token ?? '').trim();
  state.tokenDraft = candidate;
  if (!candidate) {
    state.tokenError = '请粘贴访问 Token。';
    render();
    return;
  }
  let epoch = invalidateSession();
  if (state.sheet?.kind === 'token') state.sheet.submitting = true;
  state.tokenError = '';
  render();
  const candidateApi = new ApiClient(candidate);
  try {
    const overview = await candidateApi.getOverview({ signal: sessionController.signal });
    if (epoch !== sessionEpoch) return;
    // 验证期间可能仍有旧页面触发的读取；安装新凭据时再次切断旧请求。
    epoch = invalidateSession();
    if (candidate !== state.token) clearPrivateState();
    state.token = candidate;
    state.tokenDraft = candidate;
    state.tokenError = '';
    state.auth = 'authorized';
    state.browserConnection = 'idle';
    api = candidateApi;
    writeStoredValue(TOKEN_STORAGE_KEY, candidate);
    applyOverview(overview);
    closeSheet();
    startEventStream();
    startPolling();
    const connected = await refreshSnapshots({ includePending: true, quiet: false });
    if (epoch !== sessionEpoch || !connected) return;
    setToast('Token 已验证，开始同步。', 'success');
    render();
  } catch (error) {
    if (epoch !== sessionEpoch) return;
    state.tokenError = error instanceof ApiClientError ? error.message : mapApiError(error);
    if (state.sheet?.kind === 'token') state.sheet.submitting = false;
    if (state.token && state.auth === 'authorized') {
      startEventStream();
      startPolling();
    }
    render();
  }
}

function clearToken() {
  invalidateSession();
  clearPrivateState();
  state.token = '';
  state.tokenDraft = '';
  state.tokenError = '';
  state.tokenVisible = false;
  state.auth = 'required';
  state.browserConnection = 'idle';
  api = new ApiClient('');
  writeStoredValue(TOKEN_STORAGE_KEY, '');
  if (state.sheet?.kind === 'token') state.sheet.submitting = false;
  render();
}

async function approveDevice(id, deviceName = '') {
  const requestedId = typeof id === 'string' ? id : String(id ?? '');
  const requestedDevice = typeof deviceName === 'string' ? deviceName : '';
  if (!isPendingDeviceId(requestedId)) {
    setToast('待批准设备记录无效，请刷新列表。', 'error');
    render();
    return;
  }
  const lockKey = pendingApprovalKey(requestedDevice, requestedId);
  if (state.approvalInProgress.has(lockKey)) return;
  state.approvalInProgress.add(lockKey);
  render();

  const epoch = sessionEpoch;
  const client = api;
  const signal = sessionController.signal;
  let pendingLoaded = false;
  try {
    // pending 记录可能在按钮绘制后变化；以这次 GET 返回的记录 id 为准。
    const pending = await client.getPendingDevices({ signal });
    if (epoch !== sessionEpoch) return;
    if (!applyPending(pending)) {
      state.pendingStatus = 'error';
      state.pendingError = '服务返回的待批准设备数据无效，请刷新后重试。';
      setToast(state.pendingError, 'error');
      return;
    }
    pendingLoaded = true;
    const device = state.pendingDevices.find((item) => requestedDevice
      ? item.device === requestedDevice
      : String(item.id) === requestedId);
    if (!device) {
      setToast('该设备已不在待批准列表，请刷新后重试。', 'error');
      return;
    }
    const targetId = typeof device.id === 'string' ? device.id : '';
    if (!isPendingDeviceId(targetId)) {
      setToast('待批准设备记录无效，请刷新列表。', 'error');
      return;
    }
    const result = await client.approveDevice(targetId, { signal });
    if (epoch !== sessionEpoch) return;
    setToast(result.already_approved ? '该设备此前已批准。' : '设备已批准。', 'success');
    await refreshSnapshots({ includePending: true, quiet: false });
  } catch (error) {
    if (epoch !== sessionEpoch) return;
    if (!pendingLoaded) {
      state.pendingStatus = 'error';
      state.pendingError = error instanceof ApiClientError ? error.message : mapApiError(error);
    }
    if (error instanceof ApiClientError && error.status === 404) {
      setToast('该设备已不在待批准列表，请刷新后重试。', 'error');
      refreshSnapshots({ includePending: true, quiet: true }).catch(() => {});
    } else {
      handleApiError(error);
    }
    render();
  } finally {
    if (epoch === sessionEpoch) {
      state.approvalInProgress.delete(lockKey);
      render();
    }
  }
}

function isDesktopLayout() {
  return window.matchMedia('(min-width: 760px)').matches;
}

function snapSheetBack() {
  const panel = document.querySelector('#sheet-panel');
  if (!panel) return;
  panel.classList.remove('is-dragging');
  panel.getBoundingClientRect();
  panel.style.transform = '';
}

function startSheetDrag(event, handle) {
  if (isDesktopLayout() || !state.sheet || event.button !== 0) return;
  const panel = document.querySelector('#sheet-panel');
  if (!panel) return;
  dragState = {
    pointerId: event.pointerId,
    startY: event.clientY,
    startedAt: performance.now(),
    panelHeight: panel.offsetHeight,
    handle,
  };
  handle.setPointerCapture?.(event.pointerId);
  panel.classList.add('is-dragging');
  event.preventDefault();
}

function moveSheetDrag(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const panel = document.querySelector('#sheet-panel');
  if (!panel) return;
  const delta = clampSheetOffset(event.clientY - dragState.startY, dragState.panelHeight);
  panel.style.transform = `translateY(${delta}px)`;
  event.preventDefault();
}

function finishSheetDrag(event, cancelled = false) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const currentDrag = dragState;
  dragState = null;
  currentDrag.handle.releasePointerCapture?.(event.pointerId);
  const panel = document.querySelector('#sheet-panel');
  if (!panel) return;
  if (cancelled) {
    snapSheetBack();
    return;
  }
  const outcome = resolveSheetRelease({
    deltaY: event.clientY - currentDrag.startY,
    elapsedMs: performance.now() - currentDrag.startedAt,
    panelHeight: currentDrag.panelHeight,
  });
  if (outcome === 'close') {
    closeSheet();
  } else {
    snapSheetBack();
  }
}

function focusableInSheet() {
  const panel = document.querySelector('#sheet-panel');
  if (!panel) return [];
  return [...panel.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.hidden && element.offsetParent !== null);
}

function onDocumentKeydown(event) {
  if (!state.sheet) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSheet();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = focusableInSheet();
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openToken(trigger) {
  state.tokenError = state.auth === 'invalid' ? state.tokenError : '';
  openSheet({ kind: 'token', title: 'Token 设置', submitting: false }, trigger);
}

function openSetting(type, trigger) {
  const setting = taskDefinition(type);
  openSheet({
    kind: 'setting',
    title: setting.label,
    setting: type,
    value: '',
  }, trigger);
}

function openConfirmation(type, trigger, params) {
  openSheet({
    kind: 'confirm',
    title: '请确认操作',
    type,
    params,
  }, trigger);
}

function navigate(route) {
  state.route = ['home', 'monitor', 'pending'].includes(route) ? route : 'home';
  render();
}

async function handleAction(target) {
  const action = target.dataset.action;
  if (action === 'navigate') {
    navigate(target.dataset.route);
    return;
  }
  if (action === 'open-theme') {
    openSheet({ kind: 'theme', title: '主题' }, target);
    return;
  }
  if (action === 'open-settings') {
    openSheet({ kind: 'settings', title: '设置与工具' }, target);
    return;
  }
  if (action === 'open-token') {
    openToken(target);
    return;
  }
  if (action === 'close-sheet' || action === 'dismiss-sheet') {
    closeSheet();
    return;
  }
  if (action === 'back-sheet') {
    backSheet();
    return;
  }
  if (action === 'toggle-token') {
    const input = document.querySelector('[data-field="token"]');
    if (input) state.tokenDraft = input.value;
    state.tokenVisible = !state.tokenVisible;
    render();
    return;
  }
  if (action === 'clear-token') {
    clearToken();
    return;
  }
  if (action === 'run-quick' || action === 'submit-task') {
    const type = target.dataset.type;
    if (shouldOpenInFlightConfirm(type)) {
      openSheet({ kind: 'inflight', title: '任务进行中', type }, target);
      return;
    }
    await sendTask(type);
    return;
  }
  if (action === 'queue-again') {
    const type = target.dataset.type;
    if (!canQueueAgain(type)) return;
    const ok = await sendTask(type, { force: true });
    if (ok) closeSheet();
    return;
  }
  if (action === 'stop-current') {
    const ok = await sendTask('StopTask', { confirm: true });
    if (ok) closeSheet();
    return;
  }
  if (action === 'clear-pending') {
    clearStuckPending(target.dataset.type, { id: target.dataset.id });
    return;
  }
  if (action === 'open-task') {
    const task = TASK_BY_TYPE.get(target.dataset.type);
    if (task) openSheet({ kind: 'task', title: task.label, task }, target);
    return;
  }
  if (action === 'open-stop') {
    openConfirmation('StopTask', target);
    return;
  }
  if (action === 'open-setting') {
    openSetting(target.dataset.setting, target);
    return;
  }
  if (action === 'open-gacha') {
    openSheet({ kind: 'gacha', title: '工具箱抽卡' }, target);
    return;
  }
  if (action === 'confirm-gacha') {
    openConfirmation(target.dataset.type, target);
    return;
  }
  if (action === 'confirm-task') {
    const type = target.dataset.type;
    const currentSheet = state.sheet;
    const confirm = ['StopTask', 'Settings-ConnectAddress', 'Settings-Stage1'].includes(type);
    await sendTask(type, { params: currentSheet?.params, confirm });
    return;
  }
  if (action === 'capture-image') {
    await sendTask('CaptureImageNow');
    return;
  }
  if (action === 'select-screenshot') {
    state.selectedScreenshotId = Number(target.dataset.id);
    render();
    return;
  }
  if (action === 'approve-device') {
    await approveDevice(target.dataset.id, target.dataset.device);
    return;
  }
  if (action === 'refresh') {
    await refreshSnapshots({ includePending: true, quiet: false });
  }
}

function onAppClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  handleAction(target).catch((error) => {
    handleApiError(error);
    render();
  });
}

function onAppChange(event) {
  const target = event.target;
  if (target.matches('[data-action="select-device"]')) {
    setSelectedDevice(target.value);
    render();
    return;
  }
  if (target.matches('[data-theme-choice]')) {
    setTheme(target.value);
  }
}

function onAppInput(event) {
  const target = event.target;
  if (target.matches('[data-field="token"]')) state.tokenDraft = target.value;
  if (target.matches('[data-field="setting"]') && state.sheet?.kind === 'setting') state.sheet.value = target.value;
}

function onAppSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (form.dataset.form === 'token') {
    validateToken(new FormData(form).get('token')).catch((error) => {
      state.tokenError = error instanceof Error ? error.message : '验证失败，请稍后再试';
      if (state.sheet?.kind === 'token') state.sheet.submitting = false;
      render();
    });
    return;
  }
  if (form.dataset.form === 'setting' && state.sheet?.kind === 'setting') {
    const value = String(new FormData(form).get('settingValue') ?? '').trim();
    if (!value) {
      setToast('请填写参数后继续。', 'error');
      render();
      return;
    }
    openConfirmation(state.sheet.setting, form.querySelector('[data-focus-key]'), value);
  }
}

function onImageError(event) {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.dataset.screenshotId || image.dataset.failed) return;
  image.dataset.failed = 'true';
  const id = String(image.dataset.screenshotId);
  state.missingScreenshotIds.add(id);
  state.screenshots = state.screenshots.filter((shot) => String(shot.id) !== id);
  setToast('截图不存在或已被清理，正在刷新列表。', 'error');
  refreshScreenshots().catch((error) => {
    handleApiError(error, { quiet: true });
    render();
  });
  render();
}

function bindInteractions() {
  app.addEventListener('click', onAppClick);
  app.addEventListener('change', onAppChange);
  app.addEventListener('input', onAppInput);
  app.addEventListener('submit', onAppSubmit);
  app.addEventListener('error', onImageError, true);
  app.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('[data-sheet-handle]');
    if (handle) startSheetDrag(event, handle);
  });
  app.addEventListener('pointermove', moveSheetDrag);
  app.addEventListener('pointerup', (event) => finishSheetDrag(event, false));
  app.addEventListener('pointercancel', (event) => finishSheetDrag(event, true));
  document.addEventListener('keydown', onDocumentKeydown);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.auth === 'authorized') {
      refreshSnapshots({ includePending: true, quiet: true }).catch(() => {});
    }
  });
  colorScheme.addEventListener?.('change', () => {
    if (state.themePreference === 'system') {
      applyTheme(state.themePreference, { mediaQuery: colorScheme });
      render();
    }
  });
  window.addEventListener('beforeunload', saveInFlightTasks);
  // 同源另一标签页清除凭据时，本页也必须立即撤销旧会话和私密快照。
  window.addEventListener('storage', (event) => {
    if ((event.key === TOKEN_STORAGE_KEY || event.key === null) && event.newValue === null) clearToken();
  });
}

bindInteractions();
applyTheme(state.themePreference, { mediaQuery: colorScheme });
// 兼容旧版本清除凭据后遗留的任务缓存，首次绘制前恢复隐私边界。
if (!state.token) clearPrivateState();
render();
if (state.token) {
  syncAll({ includePending: true }).catch((error) => {
    handleApiError(error);
    render();
  });
} else {
  openSheet({ kind: 'token', title: 'Token 设置', submitting: false });
}
