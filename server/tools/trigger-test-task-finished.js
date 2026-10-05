// P4b 验收工具：通过现有 HTTP 契约模拟 MAA，触发一条 task_finished。
// 不连接真实 MAA，不直接读写 SQLite；必须显式传入 --confirm-test-task。
import crypto from 'node:crypto';
import { loadOrCreateConfig } from '../src/config.js';

const USAGE = `用法：
  node tools/trigger-test-task-finished.js --confirm-test-task [选项]

选项：
  --confirm-test-task       明确允许创建并结束一条测试任务（必填）
  --device <名称>          测试设备名，默认自动生成唯一名称
  --type <类型>            任务类型，默认 LinkStart-WakeUp
  --status <SUCCESS|FAILED> 终结状态，默认 SUCCESS
  --delay-ms <毫秒>        模拟 MAA 取到任务后的等待时间，默认 1200
  --timeout-sec <秒>       等待任务完成事件的上限，默认 30
  --help                   显示帮助

示例：
  node tools/trigger-test-task-finished.js --confirm-test-task --status SUCCESS
`;

const COMMAND_TYPES = new Set([
  'LinkStart', 'LinkStart-Base', 'LinkStart-WakeUp', 'LinkStart-Combat',
  'LinkStart-Recruiting', 'LinkStart-Mall', 'LinkStart-Mission',
  'LinkStart-AutoRoguelike', 'LinkStart-Reclamation', 'StopTask',
  'Toolbox-GachaOnce', 'Toolbox-GachaTenTimes', 'Settings-ConnectAddress',
  'Settings-Stage1', 'CaptureImageNow',
]);

function fail(message) {
  console.error(`[失败] ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = {
    confirm: false,
    device: `p4b-test-${Date.now().toString(36)}`,
    type: 'LinkStart-WakeUp',
    status: 'SUCCESS',
    delayMs: 1200,
    timeoutSec: 30,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--confirm-test-task') {
      options.confirm = true;
    } else if (arg === '--help') {
      options.help = true;
    } else if (arg === '--device' || arg === '--type' || arg === '--status' ||
      arg === '--delay-ms' || arg === '--timeout-sec') {
      const value = argv[++i];
      if (!value) throw new Error(`参数 ${arg} 缺少值`);
      if (arg === '--device') options.device = value;
      if (arg === '--type') options.type = value;
      if (arg === '--status') options.status = value.toUpperCase();
      if (arg === '--delay-ms') options.delayMs = Number(value);
      if (arg === '--timeout-sec') options.timeoutSec = Number(value);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }

  if (options.help) return options;
  if (!options.confirm) throw new Error('必须显式传入 --confirm-test-task；该工具会在当前服务端创建测试任务。');
  if (!options.device || options.device.length > 256) throw new Error('--device 必须是 1 至 256 个字符');
  if (!COMMAND_TYPES.has(options.type) || options.type === 'CaptureImageNow') {
    throw new Error('--type 必须是可产生 task_finished 的排队任务类型');
  }
  if (options.status !== 'SUCCESS' && options.status !== 'FAILED') {
    throw new Error('--status 只能是 SUCCESS 或 FAILED');
  }
  if (!Number.isInteger(options.delayMs) || options.delayMs < 0 || options.delayMs > 60000) {
    throw new Error('--delay-ms 必须是 0 至 60000 的整数');
  }
  if (!Number.isInteger(options.timeoutSec) || options.timeoutSec < 5 || options.timeoutSec > 120) {
    throw new Error('--timeout-sec 必须是 5 至 120 的整数');
  }
  return options;
}

function deviceIdOf(user, device) {
  return crypto.createHash('sha256').update(`${user}:${device}`, 'utf8').digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(baseUrl, path, { method = 'GET', body, token } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 200) };
    }
  }
  return { status: response.status, data };
}

function apiError(response) {
  const detail = response.data?.error ?? `HTTP ${response.status}`;
  return `${detail}（HTTP ${response.status}）`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const config = loadOrCreateConfig();
  const baseUrl = `http://127.0.0.1:${config.port}`;
  const dashboardToken = config.dashboardToken;
  const maaBody = { user: config.maaUserToken, device: options.device };

  console.log(`[P4b 测试] 仅模拟 MAA HTTP，目标端口 ${config.port}，设备 ${options.device}`);

  let getTask = await requestJson(baseUrl, '/maa/getTask', { method: 'POST', body: maaBody });
  if (getTask.status === 401) {
    const deviceId = deviceIdOf(config.maaUserToken, options.device);
    const approved = await requestJson(baseUrl, `/api/devices/${deviceId}/approve`, {
      method: 'POST',
      body: {},
      token: dashboardToken,
    });
    if (approved.status !== 200) throw new Error(`自动批准测试设备失败：${apiError(approved)}`);
    console.log('[P4b 测试] 测试设备已自动批准');
    getTask = await requestJson(baseUrl, '/maa/getTask', { method: 'POST', body: maaBody });
  }
  if (getTask.status !== 200) throw new Error(`getTask 初始化失败：${apiError(getTask)}`);

  const created = await requestJson(baseUrl, '/api/tasks', {
    method: 'POST',
    body: { type: options.type, device: options.device },
    token: dashboardToken,
  });
  if (created.status !== 200) throw new Error(`创建测试任务失败：${apiError(created)}`);
  const taskId = created.data?.id;
  if (typeof taskId !== 'string' || taskId.length === 0) throw new Error('创建测试任务响应缺少任务 ID');
  console.log(`[P4b 测试] 已创建任务 ${taskId}（${options.type}）`);

  const deadline = Date.now() + options.timeoutSec * 1000;
  let delivered = false;
  while (Date.now() < deadline) {
    getTask = await requestJson(baseUrl, '/maa/getTask', { method: 'POST', body: maaBody });
    if (getTask.status !== 200) throw new Error(`getTask 取任务失败：${apiError(getTask)}`);
    if (Array.isArray(getTask.data?.tasks) && getTask.data.tasks.some((task) => task.id === taskId)) {
      delivered = true;
      break;
    }
    await sleep(250);
  }
  if (!delivered) throw new Error('在等待时间内未从 getTask 取到测试任务');

  await sleep(options.delayMs);
  const reported = await requestJson(baseUrl, '/maa/reportStatus', {
    method: 'POST',
    body: {
      ...maaBody,
      task: taskId,
      status: options.status,
      payload: '',
    },
  });
  if (reported.status !== 200) throw new Error(`reportStatus 失败：${apiError(reported)}`);
  console.log(`[P4b 测试] 已模拟 reportStatus ${options.status}`);

  let finishedEvent = null;
  while (Date.now() < deadline) {
    const overview = await requestJson(baseUrl, '/api/overview', { token: dashboardToken });
    if (overview.status !== 200) throw new Error(`读取 task_finished 失败：${apiError(overview)}`);
    for (const event of overview.data?.events ?? []) {
      if (event.kind !== 'task_finished') continue;
      let detail;
      try {
        detail = JSON.parse(event.detail);
      } catch {
        continue;
      }
      if (detail?.task_id === taskId) {
        finishedEvent = { id: event.id, detail };
        break;
      }
    }
    if (finishedEvent) break;
    await sleep(250);
  }
  if (!finishedEvent) throw new Error('在等待时间内未观察到 task_finished');

  console.log(`[P4b 测试] task_finished 已入库：event_id=${finishedEvent.id} status=${finishedEvent.detail.status} duration_ms=${finishedEvent.detail.duration_ms}`);
  console.log('[P4b 测试] 现在可检查 iPhone 锁屏通知；该任务不经过真实 MAA。');
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  if (process.exitCode === 1 && !process.argv.includes('--confirm-test-task')) {
    console.error(USAGE);
  }
}
