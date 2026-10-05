// SPDX-License-Identifier: MPL-2.0
// mock-maa.js —— 模拟 MAA 客户端（自测用）。
// 用法：node tools/mock-maa.js [--user U] [--device D] [--delay 毫秒] [--once]
//   --user   默认取 server/config.json 的 maaUserToken；可手动指定以便测 403
//   --device 默认 mock-device；可手动指定以便测 401
//   --delay  顺序类任务「执行」耗时，默认 3000ms（便于观察 dispatched 态）
//   --once   只做一轮 getTask，处理完本轮任务后退出；默认无限轮询（Ctrl+C 停止）
// 行为：以约 1s 间隔 POST /maa/getTask；收到任务后逐个执行并 POST /maa/reportStatus。
// 任务类别（M3）：
//   立即类 = HeartBeat / CaptureImageNow / StopTask：不占「顺序任务」执行位、不走 --delay，收到即回报；
//     HeartBeat → payload = 当前顺序任务 id（无则空串 ''）；CaptureImageNow → payload = 内置 1×1 PNG Base64。
//   顺序类（LinkStart 等）：--delay 耗时后回报；开始执行时记录其 id、完成回报后清空（模拟真实 MAA 的
//     「当前正在执行的顺序任务」，供 HeartBeat 探针观测）。
// 回报规则：其余顺序任务 → SUCCESS 无 payload。收到 401/403 时打印状态码并继续轮询。仅用 Node 内置 fetch。
import { loadOrCreateConfig } from '../src/config.js';

const MINIMAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='; // 1×1 像素 PNG

// 立即类任务集合：穿插执行、快速返回，不进入顺序任务队列
const IMMEDIATE_TYPES = new Set(['HeartBeat', 'CaptureImageNow', 'StopTask']);

// ---- 参数解析 ----
function parseArgs(argv) {
  const opts = { user: null, device: 'mock-device', delay: 3000, once: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user') opts.user = argv[++i];
    else if (a === '--device') opts.device = argv[++i];
    else if (a === '--delay') opts.delay = Number(argv[++i]);
    else if (a === '--once') opts.once = true;
    else {
      console.error(`未知参数：${a}`);
      process.exit(1);
    }
  }
  if (!Number.isFinite(opts.delay) || opts.delay < 0) {
    console.error('--delay 必须是非负整数（毫秒）');
    process.exit(1);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const config = loadOrCreateConfig();
const user = opts.user ?? config.maaUserToken;
const device = opts.device;
const base = `http://127.0.0.1:${config.port}`;

const log = (msg) => console.log(`[mock-maa ${new Date().toISOString()}] ${msg}`);

// 已回报完成的任务 id（服务端在收到 reportStatus 后不再下发，这里做客户端侧兜底去重）
const reported = new Set();
// 正在执行中的任务 id → Promise
const inflight = new Map();
// 当前正在模拟执行的顺序任务 id（立即类不占此位；供 HeartBeat payload 观测）
let currentSequentialTaskId = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 「执行」一个任务并在完成后回报 */
async function executeTask(task) {
  const immediate = IMMEDIATE_TYPES.has(task.type);
  if (!immediate) {
    // 顺序任务：开始执行 → 记录为「当前顺序任务」
    currentSequentialTaskId = task.id;
  }
  log(`执行任务 ${task.id}（type=${task.type}，${immediate ? '立即类' : `顺序类，耗时 ${opts.delay}ms`}）...`);
  if (!immediate) {
    await sleep(opts.delay);
  }

  const body = { user, device, task: task.id, status: 'SUCCESS' };
  if (task.type === 'CaptureImageNow') {
    // 截图任务：回报 1×1 PNG 的 Base64
    body.payload = MINIMAL_PNG_BASE64;
  } else if (task.type === 'HeartBeat') {
    // 心跳任务：payload = 当前顺序任务 id，空闲为空串（协议语义）
    body.payload = currentSequentialTaskId ?? '';
  }
  try {
    const res = await fetch(`${base}/maa/reportStatus`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    log(`reportStatus ${task.id} → HTTP ${res.status}`);
  } catch (err) {
    log(`reportStatus ${task.id} 请求失败：${err.message}`);
  } finally {
    // 顺序任务完成回报 → 清空「当前顺序任务」（仅当仍是自己时清，防并发覆盖误清）
    if (!immediate && currentSequentialTaskId === task.id) {
      currentSequentialTaskId = null;
    }
    inflight.delete(task.id);
    reported.add(task.id);
  }
}

/** 一轮轮询：getTask → 对新任务发起执行（不阻塞下一轮轮询） */
async function pollOnce() {
  let res;
  try {
    res = await fetch(`${base}/maa/getTask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user, device }),
    });
  } catch (err) {
    log(`getTask 请求失败（服务端未启动？）：${err.message}`);
    return;
  }

  if (res.status === 401 || res.status === 403) {
    // 模拟真实 MAA：打印状态码，不放弃，继续轮询
    log(`getTask → HTTP ${res.status}（${res.status === 401 ? '设备待批准' : 'user 不匹配'}），继续轮询`);
    return;
  }
  if (!res.ok) {
    log(`getTask → HTTP ${res.status}，继续轮询`);
    return;
  }

  const data = await res.json();
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  if (tasks.length === 0) return; // 空队列不打日志，避免刷屏

  const fresh = tasks.filter((t) => !inflight.has(t.id) && !reported.has(t.id));
  log(`getTask → ${tasks.length} 个任务：${tasks.map((t) => `${t.type}(${t.id})`).join('、')}`);
  for (const t of fresh) {
    const p = executeTask(t);
    inflight.set(t.id, p);
  }
}

log(`启动：user=${opts.user ? '<手动指定>' : '<config.maaUserToken>'} device=${device} delay=${opts.delay}ms once=${opts.once}`);
log(`端点：${base}/maa/getTask`);

// 主循环：约 1s 一轮；--once 时跑完首轮并等任务全部回报完再退出
do {
  await pollOnce();
  if (opts.once) {
    while (inflight.size > 0) {
      await Promise.all([...inflight.values()]);
    }
    break;
  }
  await sleep(1000);
} while (true);

if (opts.once) log('本轮完成，退出');
