// 仪表盘 API（挂载于 /api 前缀）：
//   GET  /api/overview                设备在线状态 + 最近事件
//   GET  /api/tasks?limit=50          任务历史（按创建时间倒序）
//   POST /api/tasks                   指令下发（M4：白名单校验 + 二次确认防线）
//   GET  /api/events                  SSE 实时事件流
//   GET  /api/screenshots?limit=20    截图元数据列表（M3，按 id 倒序）
//   GET  /api/screenshots/:id         截图文件本体（M3，image/png 流式下发）
//   GET  /api/devices/pending         待批准设备列表（M4 首次绑定流程）
//   POST /api/devices/:id/approve     批准设备（M4，幂等；写 device_approved 事件）
// 鉴权：本插件内部注册 onRequest 钩子（Fastify 封装上下文隔离，只作用于 /api/*，
// 不影响匿名可达的 /maa/* 协议端点），无 token 或错 token → 401。
// ?token= 查询参数全程可用（浏览器 <img> 标签无法自定义 header 的场景）。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildDashboardAuth } from '../auth.js';
import { createSlidingWindowLimiter } from '../ratelimit.js';
import { recordAndPublishEvent } from '../eventbus.js';

// 最近事件查询（JOIN devices 带出设备名；倒序取最新，用于 overview 与 SSE 首推）
const SQL_RECENT_EVENTS_DESC =
  'SELECT e.id, e.device_id, d.device AS device, e.kind, e.detail, e.created_at ' +
  'FROM events e LEFT JOIN devices d ON d.id = e.device_id ORDER BY e.id DESC LIMIT ?';
// 全部已登记设备（含待批准；overview 展示用）
const SQL_ALL_DEVICES =
  'SELECT id, device, approved, last_seen, current_task_id, first_seen FROM devices ORDER BY first_seen ASC, rowid ASC';
// 任务历史（JOIN devices 带出设备名；创建时间倒序）
const SQL_TASKS_RECENT =
  'SELECT t.id, t.device_id, d.device AS device, t.type, t.params, t.status, ' +
  't.created_at, t.dispatched_at, t.finished_at, t.payload_path ' +
  'FROM tasks t LEFT JOIN devices d ON d.id = t.device_id ORDER BY t.created_at DESC, t.rowid DESC LIMIT ?';
// 截图元数据列表（JOIN devices 带出设备名；id 为 rowid 别名即时间序，倒序取最新）
const SQL_SCREENSHOTS_RECENT =
  'SELECT s.id, s.device_id, d.device AS device, s.task_id, s.size, s.created_at ' +
  'FROM screenshots s LEFT JOIN devices d ON d.id = s.device_id ORDER BY s.id DESC LIMIT ?';
// 截图单行（含落盘路径，仅内部使用，不外发）
const SQL_SCREENSHOT_BY_ID = 'SELECT id, device_id, task_id, path, size, created_at FROM screenshots WHERE id = ?';
// ---- M4：指令下发与设备批准 ----
// 按设备名查设备（指令下发的目标解析；本项目单 user，设备名唯一）
const SQL_DEVICE_BY_NAME = 'SELECT id, device, approved, current_task_id FROM devices WHERE device = ?';
// 已登记设备总数（device 缺省时的「唯一设备默认」判定）
const SQL_DEVICE_COUNT = 'SELECT COUNT(*) AS n FROM devices';
// 取唯一已登记设备（排序口径与 overview 一致：first_seen 正序）
const SQL_FIRST_DEVICE = 'SELECT id, device, approved, current_task_id FROM devices ORDER BY first_seen ASC, rowid ASC LIMIT 1';
// 指令任务入库（与 insert-task.js / scheduler.js 同款 INSERT：queued + uuid，
// 走既有 getTask 通道下发、共用既有状态机，不新增表）
const SQL_INSERT_COMMAND_TASK =
  "INSERT INTO tasks (id, device_id, type, params, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)";
// 与 scheduler 注入器同口径：同设备同类型未终结则不能再入队用户 LinkStart*
const SQL_HAS_UNFINISHED_BY_TYPE =
  "SELECT COUNT(*) AS n FROM tasks WHERE device_id = ? AND type = ? AND status IN ('queued', 'dispatched', 'running')";
const SQL_TASK_BY_ID_FOR_DEVICE = 'SELECT id, type, status FROM tasks WHERE id = ? AND device_id = ?';
// 待批准设备列表（仅 approved=0，首次登记时间正序）
const SQL_PENDING_DEVICES =
  'SELECT id, device, first_seen, last_seen FROM devices WHERE approved = 0 ORDER BY first_seen ASC, rowid ASC';
// 按 id 查设备（批准前校验存在性与批准位）
const SQL_DEVICE_BY_ID = 'SELECT id, device, approved FROM devices WHERE id = ?';
// 批准设备：仅置 approved=1（表无批准时间列，不做多余写入）
const SQL_APPROVE_DEVICE = 'UPDATE devices SET approved = 1 WHERE id = ?';

// 常量参数（config 不加字段）
const OVERVIEW_EVENT_LIMIT = 20; // overview 与 SSE 连接首推的最近事件条数
const TASKS_DEFAULT_LIMIT = 50;  // /api/tasks 默认条数
const TASKS_MAX_LIMIT = 200;     // /api/tasks 上限
const SCREENSHOTS_DEFAULT_LIMIT = 20; // /api/screenshots 默认条数
const SCREENSHOTS_MAX_LIMIT = 200;    // /api/screenshots 上限
const SSE_KEEPALIVE_MS = 15000;  // SSE 保活注释行周期

// [低2] /api/* 鉴权失败（401）按来源 IP 滑动窗限频：60s 内最多 20 次失败，第 21 次起 429
// （代码常量，不加 config 字段；只统计鉴权失败流量，token 正确的请求不进限流器，
//  正常仪表盘/SSE 流量不受任何影响；实现见 ../ratelimit.js）
const API_AUTHFAIL_WINDOW_MS = 60000;
const API_AUTHFAIL_MAX = 20;

// ---- M4：指令下发类型白名单（精确匹配、大小写敏感，恰好这些）----
// 两条协议红线体现在白名单上：
// 1. HeartBeat 不开放——它是注入器内部探针（scheduler 周期注入），人工下发无意义；
// 2. CaptureImage（排队类截图）绝不入白名单——监控截图一律 CaptureImageNow（立即类）。
const COMMAND_TYPES = new Set([
  'LinkStart',
  'LinkStart-Base', 'LinkStart-WakeUp', 'LinkStart-Combat', 'LinkStart-Recruiting',
  'LinkStart-Mall', 'LinkStart-Mission', 'LinkStart-AutoRoguelike', 'LinkStart-Reclamation',
  'StopTask',
  'Toolbox-GachaOnce', 'Toolbox-GachaTenTimes',
  'Settings-ConnectAddress', 'Settings-Stage1',
  'CaptureImageNow',
]);
// Settings 类：params 必填且必须是字符串（协议层 params 为字符串，排队生效）
const SETTINGS_TYPES = new Set(['Settings-ConnectAddress', 'Settings-Stage1']);
// 需二次确认的类型：请求体必须 confirm === true（安全防线，前端据此弹窗）
const CONFIRM_REQUIRED_TYPES = new Set(['StopTask', 'Settings-ConnectAddress', 'Settings-Stage1']);

function isLinkStartCommandType(type) {
  return type === 'LinkStart' || (typeof type === 'string' && type.startsWith('LinkStart-'));
}

/** 用户下发的 LinkStart*：同设备同类型未终结，或心跳仍观测到同类型占用，则拒绝叠单。 */
function linkStartBlocked(db, devRow, type) {
  if (!isLinkStartCommandType(type)) return false;
  const { n } = db.prepare(SQL_HAS_UNFINISHED_BY_TYPE).get(devRow.id, type);
  if (n > 0) return true;
  const currentId = devRow.current_task_id;
  if (typeof currentId !== 'string' || currentId.length === 0) return false;
  const current = db.prepare(SQL_TASK_BY_ID_FOR_DEVICE).get(currentId, devRow.id);
  return !current || current.type === type;
}

/** 仪表盘 API 路由插件。opts: { config, db, bus } */
export default async function apiRoutes(fastify, opts) {
  const { config, db, bus } = opts;

  // 私密 JSON、截图及鉴权错误均不得进入浏览器或代理缓存。
  fastify.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
  });

  // 统一事件入口（与入口文件注入的 recordEvent 等价）：入库 + 广播一次完成。
  // api.js 自身持有 db 与 bus，就地构造即可，不必改 index.js 的注册参数。
  const recordEvent = (eventOpts) => recordAndPublishEvent(db, bus, eventOpts);

  // /api/* 鉴权：Bearer header 或 ?token= 任一匹配 dashboardToken 即放行；
  // 无 token / 错 token → 401（[低2] 失败按来源 IP 限频，60s 内超 20 次失败 → 429 too_many_requests）
  const apiAuthFailLimiter = createSlidingWindowLimiter({
    windowMs: API_AUTHFAIL_WINDOW_MS,
    max: API_AUTHFAIL_MAX,
  });
  fastify.addHook('onRequest', buildDashboardAuth(config, {
    onAuthFailure: (request) => apiAuthFailLimiter.hit(request.ip),
  }));

  // 设备在线状态 + 最近事件（前端状态卡与时间线的数据源）
  fastify.get('/overview', async () => {
    const now = Date.now();
    const devices = db.prepare(SQL_ALL_DEVICES).all().map((row) => ({
      device: row.device,
      approved: row.approved === 1,
      // 在线判定（与离线检测器同口径）：now - last_seen < offlineAfterSec*1000
      online: typeof row.last_seen === 'number' && now - row.last_seen < config.offlineAfterSec * 1000,
      // HeartBeat 观测值，M3 注入 HeartBeat 后才有来源，本期恒为 null（字段保留）
      current_task_id: row.current_task_id ?? null,
      last_seen: row.last_seen ?? null,
    }));
    // 最近 20 条事件，最新在前
    const events = db.prepare(SQL_RECENT_EVENTS_DESC).all(OVERVIEW_EVENT_LIMIT);
    return { now, offline_after_sec: config.offlineAfterSec, devices, events };
  });

  // 任务历史：?limit=N，默认 50，上限 200；按创建时间倒序；含设备名
  fastify.get('/tasks', async (request, reply) => {
    const raw = request.query?.limit;
    let limit = TASKS_DEFAULT_LIMIT;
    if (raw !== undefined) {
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return reply.code(400).send({ error: 'bad_limit' });
      }
      limit = Math.min(n, TASKS_MAX_LIMIT);
    }
    const tasks = db.prepare(SQL_TASKS_RECENT).all(limit);
    return { count: tasks.length, limit, tasks };
  });

  // 指令下发（M4）：body {type, params?, device?, confirm?}。
  // 校验顺序：type 白名单 → params → confirm 二次确认 → 目标设备解析 → LinkStart* 同类型互斥。
  // 入库与 insert-task.js / scheduler.js 同款（queued + uuid），走既有 getTask 通道与状态机。
  // LinkStart / LinkStart-* 与注入器同口径：同设备同类型未终结则拒绝（already_in_flight）；
  // 心跳 current_task_id 仍指向同类型（含已标 stale 的旧任务）也拒绝，避免误标超时后叠单。
  // StopTask / 立即类 / Settings 不受此护栏。
  fastify.post('/tasks', async (request, reply) => {
    const body = request.body ?? {};
    const { type, params, device, confirm } = body;

    // 1) type 校验：缺失 / 非字符串 / 白名单外（含 HeartBeat、CaptureImage）一律 invalid_type
    if (typeof type !== 'string' || !COMMAND_TYPES.has(type)) {
      return reply.code(400).send({ error: 'invalid_type' });
    }

    // 2) params 校验：仅 Settings 类携带（协议层为字符串）；其余类型带 params 即拒绝
    let paramsText = null;
    if (SETTINGS_TYPES.has(type)) {
      if (params === undefined || params === null) {
        return reply.code(400).send({ error: 'params_required' });
      }
      if (typeof params !== 'string') {
        return reply.code(400).send({ error: 'invalid_params' });
      }
      paramsText = params;
    } else if (params !== undefined && params !== null) {
      return reply.code(400).send({ error: 'invalid_params' });
    }

    // 3) 二次确认防线：StopTask 与 Settings 类必须 confirm === true（其余类型该字段被忽略）
    if (CONFIRM_REQUIRED_TYPES.has(type) && confirm !== true) {
      return reply.code(400).send({ error: 'confirm_required' });
    }

    // 4) 目标设备解析：
    //    缺省 → 库中恰有一个已登记设备时默认它；零个或多个 → 要求显式指定（device_required）；
    //    显式给定 → 必须非空字符串；按名查无 → 404。
    //    批准检查对两条路径统一生效（见下）：解析出的设备未批准一律 device_not_approved
    //    （「批准后才可下发」而非「允许入队」，避免指令静默积压在未批准设备上）。
    let devRow;
    if (device === undefined || device === null) {
      const { n } = db.prepare(SQL_DEVICE_COUNT).get();
      if (n !== 1) {
        return reply.code(400).send({ error: 'device_required' });
      }
      devRow = db.prepare(SQL_FIRST_DEVICE).get();
    } else if (typeof device !== 'string' || device.length === 0) {
      return reply.code(400).send({ error: 'device_required' });
    } else {
      devRow = db.prepare(SQL_DEVICE_BY_NAME).get(device);
      if (!devRow) {
        return reply.code(404).send({ error: 'device_not_found' });
      }
    }
    // 批准检查：缺省解析与显式指定同语义（主控验收修复：缺省分支此前漏检）
    if (!devRow.approved) {
      return reply.code(400).send({ error: 'device_not_approved' });
    }

    // 5) LinkStart* 同类型互斥（StopTask 等不受限）
    if (linkStartBlocked(db, devRow, type)) {
      return reply.code(400).send({ error: 'already_in_flight' });
    }

    // 6) 入库：status='queued'，立即对 getTask 可见（幂等可重入由协议层保证）
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(SQL_INSERT_COMMAND_TASK).run(id, devRow.id, type, paramsText, now);

    return {
      id,
      type,
      params: paramsText,
      status: 'queued',
      device: devRow.device,
      device_id: devRow.id,
      created_at: now,
    };
  });

  // 截图元数据列表：?limit=N，默认 20，上限 200（校验风格与 /api/tasks 一致）；按 id（即时间）倒序
  fastify.get('/screenshots', async (request, reply) => {
    const raw = request.query?.limit;
    let limit = SCREENSHOTS_DEFAULT_LIMIT;
    if (raw !== undefined) {
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return reply.code(400).send({ error: 'bad_limit' });
      }
      limit = Math.min(n, SCREENSHOTS_MAX_LIMIT);
    }
    const screenshots = db.prepare(SQL_SCREENSHOTS_RECENT).all(limit);
    return { count: screenshots.length, limit, screenshots };
  });

  // 截图文件本体：流式返回 png（不新增依赖、不用 @fastify/static）。
  // :id 非正整数 → 400；库中无此行 → 404 screenshot_not_found；行在但文件缺失 → 404 screenshot_file_missing。
  fastify.get('/screenshots/:id', async (request, reply) => {
    const raw = request.params?.id;
    const id = Number.parseInt(raw, 10);
    // 严格整数校验：纯数字字符串且为正整数（拒绝 "12abc"、小数、负数、0）
    if (!Number.isInteger(id) || id <= 0 || !/^\d+$/.test(String(raw))) {
      return reply.code(400).send({ error: 'bad_id' });
    }
    const row = db.prepare(SQL_SCREENSHOT_BY_ID).get(id);
    if (!row) {
      return reply.code(404).send({ error: 'screenshot_not_found' });
    }
    if (!fs.existsSync(row.path)) {
      return reply.code(404).send({ error: 'screenshot_file_missing' });
    }
    return reply.type('image/png').send(fs.createReadStream(row.path));
  });

  // 待批准设备列表（M4 首次绑定流程）：仅 approved=0，首次登记时间正序
  fastify.get('/devices/pending', async () => {
    const devices = db.prepare(SQL_PENDING_DEVICES).all().map((row) => ({
      id: row.id,
      device: row.device,
      first_seen: row.first_seen ?? null,
      last_seen: row.last_seen ?? null,
    }));
    return { count: devices.length, devices };
  });

  // 批准设备（M4）：:id = devices.id，即 deviceIdOf 产出的小写 64 位 sha256 hex。
  // 幂等：已批准再批同样 200；批准成功写一条 device_approved 事件（统一事件入口）。
  // 批准后的效果全部自动：getTask 每次现查 approved 即放行、overview 在线判定现算、
  // 心跳/截图注入随 scheduler 每 tick 现查 approved 自动开始（锚点从批准时刻起算，
  // 等一个完整间隔后才首次注入）。
  fastify.post('/devices/:id/approve', async (request, reply) => {
    const raw = request.params?.id;
    // 格式校验：仅接受小写 64 位 hex（与库内 id 表示一致；大写等其他格式一律 bad_id）
    if (typeof raw !== 'string' || !/^[0-9a-f]{64}$/.test(raw)) {
      return reply.code(400).send({ error: 'bad_id' });
    }
    const row = db.prepare(SQL_DEVICE_BY_ID).get(raw);
    if (!row) {
      return reply.code(404).send({ error: 'device_not_found' });
    }
    const alreadyApproved = row.approved === 1;
    if (!alreadyApproved) {
      // 仅 1 个占位符（approved 无时间列，不记批准时刻）；参数个数与占位符严格对应
      db.prepare(SQL_APPROVE_DEVICE).run(raw);
      recordEvent({
        deviceId: raw,
        kind: 'device_approved',
        detail: { device: row.device, id: raw },
      });
    }
    return { ok: true, id: raw, device: row.device, approved: true, already_approved: alreadyApproved };
  });

  // SSE 实时事件流：
  //   1. 连接建立即回放最近 20 条事件（按 id 正序 = 时间正序）；
  //   2. 之后总线每有新事件实时推送；
  //   3. 每 15s 发送注释行 ": ping" 保活（穿透代理防空闲断连）；
  //   4. 客户端断开（close/error）即清理订阅与定时器。
  // 消息格式（每条三行 + 空行）：
  //   id: <events.id>
  //   event: <kind>
  //   data: {"id":..,"device_id":..,"device":..,"kind":..,"detail":..,"created_at":..}
  // detail 为 JSON 字符串（与 events 表存储一致），前端按需 JSON.parse。
  fastify.get('/events', async (request, reply) => {
    // 接管原始响应，脱离 Fastify 序列化流程
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'private, no-store, no-transform',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // 若日后加反代，禁其缓冲 SSE
    });

    let closed = false;
    const write = (text) => {
      if (closed) return;
      try {
        res.write(text);
      } catch {
        // 写失败（客户端已断开）交给 close/error 回调统一清理
      }
    };
    const sendEvent = (ev) => {
      write(`id: ${ev.id}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`);
    };

    // 首推：最近 20 条，反转成时间正序回放
    const backlog = db.prepare(SQL_RECENT_EVENTS_DESC).all(OVERVIEW_EVENT_LIMIT).reverse();
    for (const ev of backlog) sendEvent(ev);

    // 订阅进程内事件总线：所有写 events 表处均经 recordAndPublishEvent 广播到此
    const onBusEvent = (ev) => sendEvent(ev);
    bus.on('event', onBusEvent);

    const keepalive = setInterval(() => write(': ping\n\n'), SSE_KEEPALIVE_MS);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      bus.off('event', onBusEvent);
      try {
        res.end();
      } catch {
        // 忽略已断开连接的 end 错误
      }
      fastify.log.info('SSE 客户端断开，已清理订阅');
    };
    request.raw.on('close', cleanup);
    res.on('error', cleanup);
  });
}
