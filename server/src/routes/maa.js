// MAA 官方远程控制协议端点：POST /maa/getTask、POST /maa/reportStatus。
// 协议红线（违反即实现错误）：
// 1. getTask 响应必有 tasks 数组字段（空队列也返回 {"tasks":[]}），params 仅 Settings 类任务携带；
// 2. getTask 幂等可重入：reportStatus 确认前任务一直重复返回（MAA 端按 id 去重）；
// 3. reportStatus 的截图 payload（CaptureImageNow）先解码落盘再回包（MAA 不读响应、不重试）；
// 4. user 不匹配 → 403；
// 5. user 匹配但 device 未知 → 401 并登记（approved=0）；每次合法 getTask 刷新 last_seen。
// 事件纪律（M3）：HeartBeat 任务完全不写任何事件；CaptureImageNow 不写 task_started/task_finished，
// 改为保存成功后写一条 screenshot_saved；其余类型任务写 task_started/task_finished，
// task_finished.detail.duration_ms 为从任务入队到首次有效回报的任务级耗时。
// 安全修复轮（Mr-sec1）：
// [中B] getTask 路由单独 bodyLimit 64KB（合法请求体仅几十字节），reportStatus 保持实例级 100MB；
//       本插件 setErrorHandler 保证 /maa/* 框架级错误（413 大包、400 坏 JSON 等）响应体也带
//       tasks:[] / ok:false，延续 M1 决策「非 200 响应体统一带 tasks:[]」。
// [低1] maaUserToken 校验改用 auth.js 的 safeEqual（常量时间比较）。
// [低2] getTask 403（user 不匹配）按来源 IP 滑动窗限频，超限 429（只限失败流量，见 ratelimit.js）。
// [低3] reportStatus 仅接受 queued/dispatched/running → success/failed 的首次终结转换；
//       已终结任务的重复/迟到回报不写事件、不落盘截图、不写 screenshots 行，响应仍 200。
// [低4] 未批准（approved=0）设备登记数量设上限，达上限后新设备仍按未知设备 401、不入库。
import fs from 'node:fs';
import path from 'node:path';
import { SCREENSHOT_DIR } from '../config.js';
import { deviceIdOf } from '../db.js';
import { safeEqual } from '../auth.js';
import { createSlidingWindowLimiter } from '../ratelimit.js';

// 监控类立即任务：不产生 task_started / task_finished 事件（防 SSE 每周期刷屏）
const MONITOR_TYPES = new Set(['HeartBeat', 'CaptureImageNow']);

// ---- 安全修复轮常量（代码常量，不加 config 字段；同 M2/M3 协程常量惯例）----
// [中B] getTask 单独 bodyLimit：合法请求体仅几十字节（user+device 两个短字符串），64KB 封死
//       匿名大包 DoS 放大面；reportStatus 不设路由级上限，沿用实例级 100MB（截图需要）。
const GET_TASK_BODY_LIMIT_BYTES = 64 * 1024;
// reportStatus 的大包额度仅供图片；设备标识、任务标识与心跳仍受小字段预算约束。
const METADATA_LIMIT_BYTES = 64 * 1024;
// [低2] getTask 403（user 不匹配）按来源 IP 限频：60s 滑动窗口内最多 10 次失败，第 11 次起 429。
//       只统计鉴权失败流量；user 正常的轮询（含 401 待批准设备）不进限流器。
const GETTASK_FAIL_WINDOW_MS = 60000;
const GETTASK_FAIL_MAX = 10;
// [低4] 未批准（approved=0）设备登记上限：达到上限后新设备仍按未知设备 401、不入库；
//       已登记的 pending 设备不受影响。超龄清理（last_seen 超 7 天）见 scheduler.js 协程。
const MAX_PENDING_DEVICES = 20;

// 未终结状态集合：reportStatus 终结转换的合法来源状态（[低3]）
const UNFINISHED_STATUSES = new Set(['queued', 'dispatched', 'running']);

// 所有 SQL 均为静态语句常量 + prepare 参数绑定（better-sqlite3 惯用法）
const SQL_GET_DEVICE = 'SELECT id, approved FROM devices WHERE id = ?';
const SQL_INSERT_DEVICE =
  'INSERT INTO devices (id, user, device, approved, last_seen, current_task_id, first_seen) VALUES (?, ?, ?, 0, ?, NULL, ?)';
const SQL_PENDING_COUNT = 'SELECT COUNT(*) AS n FROM devices WHERE approved = 0';
const SQL_TOUCH_DEVICE = 'UPDATE devices SET last_seen = ? WHERE id = ?';
const SQL_QUEUED_TASKS =
  "SELECT id, type FROM tasks WHERE device_id = ? AND status = 'queued' ORDER BY created_at ASC, rowid ASC";
const SQL_MARK_ONE_DISPATCHED =
  "UPDATE tasks SET status = 'dispatched', dispatched_at = ? WHERE id = ? AND status = 'queued'";
const SQL_PENDING_TASKS =
  "SELECT id, type, params FROM tasks WHERE device_id = ? AND status IN ('queued', 'dispatched', 'running') ORDER BY created_at ASC, rowid ASC";
const SQL_GET_TASK = 'SELECT * FROM tasks WHERE id = ? AND device_id = ?';
// [低3] 终结 UPDATE 带状态条件：仅 queued/dispatched/running → success/failed 可转换；
//       已终结（success/failed/stale）行不再被覆盖，重复/迟到回报 changes=0。
const SQL_FINISH_TASK =
  "UPDATE tasks SET status = ?, finished_at = ?, payload_path = COALESCE(?, payload_path) " +
  "WHERE id = ? AND status IN ('queued', 'dispatched', 'running')";
const SQL_INSERT_SCREENSHOT =
  'INSERT INTO screenshots (device_id, task_id, path, size, created_at) VALUES (?, ?, ?, ?, ?)';
const SQL_SET_CURRENT_TASK = 'UPDATE devices SET current_task_id = ? WHERE id = ?';
// HeartBeat 观测到该顺序任务时转入 running，并刷新 dispatched_at 作为 stale 计时锚点。
// 覆盖已是 running 的行：长任务（自动肉鸽）会持续被心跳确认，不能一直用首次下发时间判断超时。
const SQL_MARK_TASK_RUNNING =
  "UPDATE tasks SET status = 'running', dispatched_at = ? WHERE id = ? AND device_id = ? AND status IN ('queued', 'dispatched', 'running')";
const SQL_SCREENSHOTS_EXCESS =
  'SELECT id, path FROM screenshots WHERE device_id = ? ORDER BY id DESC LIMIT -1 OFFSET ?';
const SQL_DELETE_SCREENSHOT_BY_ID = 'DELETE FROM screenshots WHERE id = ?';

function taskDurationMs(taskRow, finishedAt) {
  if (!Number.isFinite(taskRow.created_at)) return null;
  return Math.max(0, finishedAt - taskRow.created_at);
}

/** MAA 协议端点路由插件。opts: { config, db, recordEvent }（recordEvent 由入口注入：入库 + 广播一次完成） */
export default async function maaRoutes(fastify, opts) {
  const { config, db, recordEvent } = opts;

  // [低2] getTask 403 失败限流器（按来源 IP；仅 user 不匹配路径调用）
  const getTaskFailLimiter = createSlidingWindowLimiter({
    windowMs: GETTASK_FAIL_WINDOW_MS,
    max: GETTASK_FAIL_MAX,
  });

  /**
   * [低4] 未批准设备登记（带 pending 数量上限）：上限内正常入库返回 true；
   * 已达上限返回 false（调用方仍按未知设备 401 响应，不入库）。
   */
  const tryRegisterPendingDevice = (deviceId, user, device, now) => {
    const { n } = db.prepare(SQL_PENDING_COUNT).get();
    if (n >= MAX_PENDING_DEVICES) return false;
    db.prepare(SQL_INSERT_DEVICE).run(deviceId, user, device, now, now);
    return true;
  };

  /**
   * 每设备截图保留策略：只保留最近 keepCount 张（按 screenshots.id 即时间倒序），
   * 超出的旧行删库、对应 png 文件同步 unlink（文件已不存在等错误一律忽略）。
   * 返回本次删除的行数。
   */
  const pruneScreenshotsForDevice = (deviceId, keepCount) => {
    const excess = db.prepare(SQL_SCREENSHOTS_EXCESS).all(deviceId, keepCount);
    for (const row of excess) {
      db.prepare(SQL_DELETE_SCREENSHOT_BY_ID).run(row.id);
      try {
        fs.unlinkSync(row.path);
      } catch {
        // 文件不存在/被占用等错误忽略：以 DB 行为准，不因清理失败影响回报主流程
      }
    }
    return excess.length;
  };

  // [中B] 插件级错误处理：/maa/* 的框架级错误（413 大包、400 坏 JSON、handler 抛错等）
  // 响应体同样遵守 M1 决策「非 200 响应体统一带 tasks:[]」（getTask）/ ok:false（reportStatus）。
  // error 字段取 Fastify 错误码（如 FST_ERR_CTP_BODY_TOO_LARGE）；无错误码时按状态级别给通用码，
  // 避免向匿名调用方泄露内部错误消息。
  fastify.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    const code =
      error.code ?? (statusCode < 500 ? 'bad_request' : 'internal_error');
    const routeUrl = request.routeOptions?.url ?? (request.url ?? '').split('?')[0];
    if (routeUrl === '/maa/getTask') {
      return reply.code(statusCode).send({ tasks: [], error: code });
    }
    return reply.code(statusCode).send({ ok: false, error: code });
  });

  fastify.post(
    '/maa/getTask',
    { bodyLimit: GET_TASK_BODY_LIMIT_BYTES }, // [中B] 路由级 bodyLimit（实例级仍为 100MB）
    async (request, reply) => {
      const body = request.body ?? {};
      const { user, device } = body;

      // 基本类型校验：user / device 必须是非空字符串
      if (typeof user !== 'string' || typeof device !== 'string' || device.length === 0) {
        return reply.code(400).send({ tasks: [], error: 'bad_request' });
      }

      // 红线 4：user 是共享密钥，不匹配 → 403（[低1] 常量时间比较防时序侧信道）
      if (!safeEqual(user, config.maaUserToken)) {
        // [低2] 403 失败按来源 IP 限频：60s 内超 10 次 → 429（响应仍带 tasks:[]）
        if (getTaskFailLimiter.hit(request.ip)) {
          return reply.code(429).send({ tasks: [], error: 'too_many_requests' });
        }
        return reply.code(403).send({ tasks: [], error: 'user_mismatch' });
      }

      const deviceId = deviceIdOf(user, device);
      const now = Date.now();

      // 红线 5：user 对但 device 未知 → 401，同时登记该设备（approved=0），等待人工批准
      const deviceRow = db.prepare(SQL_GET_DEVICE).get(deviceId);
      if (!deviceRow) {
        // [低4] pending 登记带数量上限：达上限后新设备仍按未知设备 401、不入库
        if (!tryRegisterPendingDevice(deviceId, user, device, now)) {
          fastify.log.warn(
            { device },
            'getTask：pending 设备登记数已达上限，拒绝登记（仍按未知设备 401）'
          );
        }
        return reply.code(401).send({ tasks: [], error: 'device_not_approved' });
      }

      // 每次合法 getTask（user 校验通过）刷新 last_seen → 在线判定依据
      db.prepare(SQL_TOUCH_DEVICE).run(now, deviceId);

      if (!deviceRow.approved) {
        return reply.code(401).send({ tasks: [], error: 'device_not_approved' });
      }

      // 状态机：本次轮询把 queued 逐个标为 dispatched（已下发）。
      // 仅当确有行从 queued 变为 dispatched（changes()>0）时写一次 task_started 事件并广播，
      // 保证幂等：后续每秒重复轮询不会重复产生事件。
      // 事件纪律：HeartBeat / CaptureImageNow 跳过 task_started（状态转换照常，只是不广播）。
      const queuedRows = db.prepare(SQL_QUEUED_TASKS).all(deviceId);
      for (const t of queuedRows) {
        const info = db.prepare(SQL_MARK_ONE_DISPATCHED).run(now, t.id);
        if (info.changes > 0 && !MONITOR_TYPES.has(t.type)) {
          recordEvent({
            deviceId,
            kind: 'task_started',
            detail: { task_id: t.id, type: t.type },
            createdAt: now,
          });
        }
      }

      // 红线 2：幂等可重入 —— 返回所有未终结（queued/dispatched/running）任务，
      // 直到收到 reportStatus（SUCCESS/FAILED）才不再返回
      const rows = db.prepare(SQL_PENDING_TASKS).all(deviceId);
      // 红线 1：tasks 字段永不缺失；params 仅在任务携带时返回（实际只有 Settings 类会带）
      const tasks = rows.map((row) => {
        const t = { id: row.id, type: row.type };
        if (row.params !== null && row.params !== undefined) {
          t.params = row.params;
        }
        return t;
      });
      return { tasks };
    }
  );

  fastify.post('/maa/reportStatus', async (request, reply) => {
    const body = request.body ?? {};
    const { user, device, task, status, payload } = body;

    if (typeof user !== 'string' || typeof device !== 'string' || device.length === 0 ||
        typeof task !== 'string' || task.length === 0) {
      return reply.code(400).send({ ok: false, error: 'bad_request' });
    }
    if (status !== 'SUCCESS' && status !== 'FAILED') {
      return reply.code(400).send({ ok: false, error: 'bad_status' });
    }

    // user 不匹配 → 403（同 getTask；[低1] 常量时间比较）
    if (!safeEqual(user, config.maaUserToken)) {
      return reply.code(403).send({ ok: false, error: 'user_mismatch' });
    }
    if (Buffer.byteLength(device, 'utf8') + Buffer.byteLength(task, 'utf8') > METADATA_LIMIT_BYTES) {
      return reply.code(400).send({ ok: false, error: 'metadata_too_large' });
    }

    const deviceId = deviceIdOf(user, device);
    const now = Date.now();

    // device 未知 → 401 并登记（与 getTask 同一准入逻辑，含 [低4] pending 上限）
    const deviceRow = db.prepare(SQL_GET_DEVICE).get(deviceId);
    if (!deviceRow) {
      if (!tryRegisterPendingDevice(deviceId, user, device, now)) {
        fastify.log.warn(
          { device },
          'reportStatus：pending 设备登记数已达上限，拒绝登记（仍按未知设备 401）'
        );
      }
      return reply.code(401).send({ ok: false, error: 'device_not_approved' });
    }
    db.prepare(SQL_TOUCH_DEVICE).run(now, deviceId);
    if (!deviceRow.approved) {
      return reply.code(401).send({ ok: false, error: 'device_not_approved' });
    }

    // 在读取任务类型和触发任何副作用之前绑定回报设备；跨设备与未知任务统一处理。
    const taskRow = db.prepare(SQL_GET_TASK).get(task, deviceId);
    if (!taskRow) {
      // MAA 不读该响应、失败不重试；未知任务仅记录后返回 200，避免 MAA 侧无意义等待
      fastify.log.warn({ task }, 'reportStatus：未知任务 id');
      return { ok: false, error: 'task_not_found' };
    }

    const finalStatus = status === 'SUCCESS' ? 'success' : 'failed';

    // [低3] 已终结任务的重复/迟到回报：不写事件、不落盘截图、不写 screenshots 行，
    //       响应仍 200 {ok:true}（协议：MAA 不读响应、不重试，行为对 MAA 透明）。
    //       预读状态检查 + 下方终结 UPDATE 的状态条件 + changes()>0 门控（M2 判定模式）双保险：
    //       本项目单进程同步处理，前置检查即已生效，changes()>0 防未来引入并发写路径。
    if (!UNFINISHED_STATUSES.has(taskRow.status)) {
      fastify.log.warn(
        { task: taskRow.id, task_status: taskRow.status },
        'reportStatus：已终结任务的重复/迟到回报，忽略副作用'
      );
      return { ok: true };
    }

    // ---- 心跳回报：HeartBeat 探针的收获点 ----
    // payload = MAA 当前正在执行的顺序任务 id（空串 = 空闲）。
    // 1) 空串 → current_task_id 置 NULL（overview 中表现为 null）；
    // 2) 非空 → 照常记录到 current_task_id（即使本地任务表对不上，如 MAA 重启后的旧 id，不猜状态）；
    // 3) 恰好对上本设备未终结（queued/dispatched/running）任务 → 置 running 并刷新
    //    dispatched_at（running 状态的唯一来源；对不上绝不动任务状态）。
    // 事件纪律：HeartBeat 完全不写任何事件（含 task_finished）。
    if (taskRow.type === 'HeartBeat') {
      const observed = typeof payload === 'string' ? payload : '';
      if (Buffer.byteLength(observed, 'utf8') > METADATA_LIMIT_BYTES) {
        return reply.code(400).send({ ok: false, error: 'metadata_too_large' });
      }
      db.prepare(SQL_SET_CURRENT_TASK).run(observed.length > 0 ? observed : null, deviceId);
      if (observed.length > 0) {
        // running 的唯一来源：仅当 payload 对上本设备未终结任务才转换 / 刷新锚点；
        // 对不上（含已终结或他设备任务）绝不动任务状态。
        db.prepare(SQL_MARK_TASK_RUNNING).run(now, observed, taskRow.device_id);
      }
      // [低3] 终结 UPDATE 带状态条件（仅 queued/dispatched/running 可转换）
      db.prepare(SQL_FINISH_TASK).run(finalStatus, now, null, taskRow.id);
      return { ok: true };
    }

    // ---- 截图回报：payload 为图片 Base64（可达数十 MB）→ 先落盘再回包 ----
    // 事件纪律：CaptureImageNow 不写 task_started / task_finished，保存成功后写一条 screenshot_saved。
    if (taskRow.type === 'CaptureImageNow') {
      let payloadPath = null;
      let saved = null; // { screenshotId, size }：保存成功才有，决定是否写 screenshot_saved
      if (typeof payload === 'string' && payload.length > 0) {
        // 兼容可能出现的 data URL 前缀（协议本身为裸 Base64）
        const base64 = payload.replace(/^data:image\/png;base64,/, '');
        const buf = Buffer.from(base64, 'base64');
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
        payloadPath = path.join(SCREENSHOT_DIR, `${taskRow.id}.png`);
        fs.writeFileSync(payloadPath, buf);
        const info = db.prepare(SQL_INSERT_SCREENSHOT).run(taskRow.device_id, taskRow.id, payloadPath, buf.length, now);
        saved = { screenshotId: Number(info.lastInsertRowid), size: buf.length };
      }
      // [低3] 终结 UPDATE 带状态条件；changes()>0 才写 screenshot_saved / 清理（M2 判定模式）
      const finishInfo = db.prepare(SQL_FINISH_TASK).run(finalStatus, now, payloadPath, taskRow.id);
      if (finishInfo.changes > 0) {
        if (saved) {
          // 每设备保留最近 N 张：先入库再清理，超出部分旧行与 png 文件同删
          pruneScreenshotsForDevice(taskRow.device_id, config.screenshotKeepCount);
          recordEvent({
            deviceId: taskRow.device_id,
            kind: 'screenshot_saved',
            detail: { task_id: taskRow.id, screenshot_id: saved.screenshotId, size: saved.size },
            createdAt: now,
          });
        }
      } else {
        fastify.log.warn(
          { task: taskRow.id },
          'reportStatus：截图任务终结转换未发生（并发兜底），跳过 screenshot_saved'
        );
      }
      // MAA 不读取响应内容，返回 200 即可
      return { ok: true };
    }

    // ---- 其他任务：终结 + task_finished（含任务级耗时）----
    // [低3] 终结 UPDATE 带状态条件；changes()>0（首次转换）才写 task_finished，重复回报不重复写事件
    const finishInfo = db.prepare(SQL_FINISH_TASK).run(finalStatus, now, null, taskRow.id);
    if (finishInfo.changes > 0) {
      // 自然写入点：任务终结事件（经事件总线入库 + 广播，SSE 实时推送）
      recordEvent({
        deviceId: taskRow.device_id,
        kind: 'task_finished',
        detail: {
          task_id: taskRow.id,
          type: taskRow.type,
          status: finalStatus,
          duration_ms: taskDurationMs(taskRow, now),
        },
        createdAt: now,
      });
    } else {
      fastify.log.warn(
        { task: taskRow.id },
        'reportStatus：终结转换未发生（并发兜底），跳过 task_finished'
      );
    }

    // MAA 不读取响应内容，返回 200 即可
    return { ok: true };
  });
}
