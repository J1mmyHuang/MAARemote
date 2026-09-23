// 后台定时协程：离线检测器 + stale 回收器 + 心跳注入器 + 截图采集器（setInterval，服务关闭时 clearInterval）。
//
// 1. 离线检测器（每 2s）：遍历 approved 设备，按 now - last_seen >= offlineAfterSec*1000 判离线。
//    仅在「在线 ↔ 离线」状态转换时写一条事件（offline / online），内存 Map 缓存上次判定结果，
//    不会每周期重复写；服务启动时以库内当前数据建立基线，重启不产生转换事件（防刷屏）。
// 2. stale 回收器（每 5s）：扫描 status IN ('dispatched','running') 且锚点时间超过 staleMinutes
//    的任务，置为 stale（getTask 的下发查询只取 queued/dispatched/running，天然不再返回 stale）。
//    锚点优先 dispatched_at；HeartBeat 可能把 queued 直接推成 running，此时回落到 created_at。
//    HeartBeat 每次观测到该顺序任务会刷新 dispatched_at（见 routes/maa.js），因此真在跑的
//    自动肉鸽不会仅因首次下发超过 10 分钟被误标；失联超过 staleMinutes 仍会回收，避免
//    MAA 重启后重复执行旧 ID。UPDATE 带 status IN ('dispatched','running') 保证不覆盖已终结
//    任务。事件纪律：HeartBeat 任务完全不写任何事件（含 task_stale），其余类型照旧写 task_stale。
//    覆盖 running 是必要的：长 LinkStart* 常被心跳对上 id 后转入 running，若只扫 dispatched
//    会永不超时，仪表盘会把该指令当成永久在途。
// 3. 心跳注入器（M3，扫描每 1s、按 heartbeatIntervalSec 间隔触发）：对 approved=1 且在线
//    （与离线检测器同口径）的设备插入 type='HeartBeat' 的 queued 任务（立即类，MAA 取到即回，
//    payload 由 MAA 回报当前顺序任务 id）。防堆积护栏：同设备存在未终结（queued/dispatched/running）
//    的 HeartBeat 时跳过本次注入；未回报的旧实例由 stale 回收器安静过期，过期后下一扫描周期
//    自然恢复注入。设备离线时不注入、不推进间隔锚点（重新上线后从当刻起算，不补插）。
// 4. 截图采集器（M3，扫描每 1s、按 screenshotIntervalSec 间隔触发）：对 approved 且在线的设备
//    插入 type='CaptureImageNow' 的 queued 任务（立即类截图）；同样带「同类型未终结即跳过」护栏
//    与离线停注逻辑。回报侧的落盘/保留策略/事件见 routes/maa.js。
// 5. pending 设备清理器（Mr-sec1 低4 可选清理，每 60s + 启动即清一次）：删除 approved=0 且
//    last_seen 超 7 天的未批准设备（登记表防慢性膨胀；已批准设备永不清）。登记数量上限
//    （MAX_PENDING_DEVICES=20）见 routes/maa.js。
//
// 周期为代码内常量（任务书要求 config 不加字段）；注入间隔用「每设备内存时间戳」判定，
// 启动/首见时初始化为当前时刻，避免离线期间累积、启动瞬间爆发补插。
import crypto from 'node:crypto';

const OFFLINE_CHECK_INTERVAL_MS = 2000;
const STALE_SWEEP_INTERVAL_MS = 5000;
const INJECTOR_SCAN_INTERVAL_MS = 1000; // 心跳/截图注入协程的扫描周期
// [低4] pending 设备清理：每 60s 一次；last_seen 超 7 天的未批准设备视为超龄
const PENDING_SWEEP_INTERVAL_MS = 60000;
const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// 静态 SQL + 参数绑定，禁止拼接
const SQL_APPROVED_DEVICES = 'SELECT id, device, last_seen FROM devices WHERE approved = 1';
const SQL_STALE_CANDIDATES =
  "SELECT id, type, device_id FROM tasks WHERE status IN ('dispatched', 'running') AND COALESCE(dispatched_at, created_at) IS NOT NULL AND COALESCE(dispatched_at, created_at) < ?";
const SQL_MARK_STALE =
  "UPDATE tasks SET status = 'stale' WHERE id = ? AND status IN ('dispatched', 'running')";
const SQL_HAS_UNFINISHED_BY_TYPE =
  "SELECT COUNT(*) AS n FROM tasks WHERE device_id = ? AND type = ? AND status IN ('queued', 'dispatched', 'running')";
const SQL_INSERT_QUEUED_TASK =
  "INSERT INTO tasks (id, device_id, type, params, status, created_at) VALUES (?, ?, ?, NULL, 'queued', ?)";
// [低4] 超龄 pending 设备清理（仅 approved=0；last_seen 必非空——登记时即写入）
const SQL_DELETE_EXPIRED_PENDING =
  'DELETE FROM devices WHERE approved = 0 AND last_seen IS NOT NULL AND last_seen < ?';

/**
 * 扫描并回收超时的 dispatched / running 任务。抽出独立函数便于单测，不走 setInterval。
 * opts: { db, staleMinutes, recordEvent, now? }
 * 返回本次真正置 stale 的行数。
 */
export function recycleStaleTasks(opts) {
  const { db, staleMinutes, recordEvent, now = Date.now() } = opts;
  const cutoff = now - staleMinutes * 60000;
  const rows = db.prepare(SQL_STALE_CANDIDATES).all(cutoff);
  let recycled = 0;
  for (const row of rows) {
    const info = db.prepare(SQL_MARK_STALE).run(row.id);
    // changes()>0 才是本次真正置 stale 的行（防与 reportStatus 终结竞态重复记事件）；
    // HeartBeat 完全不写事件（事件纪律），其余类型照旧广播 task_stale
    if (info.changes > 0) {
      recycled += 1;
      if (row.type !== 'HeartBeat') {
        recordEvent({
          deviceId: row.device_id,
          kind: 'task_stale',
          detail: { task_id: row.id, type: row.type },
        });
      }
    }
  }
  return recycled;
}

/**
 * 启动全部后台协程。opts: { config, db, bus, log, recordEvent }
 * recordEvent: (opts) => recordAndPublishEvent(...)，由入口注入，保证入库与广播一致。
 * 返回 stopSchedulers()：清理全部定时器。
 */
export function startSchedulers(opts) {
  const { config, db, log, recordEvent } = opts;
  const lastOnline = new Map(); // deviceId -> 上次周期判定的在线布尔（离线检测器）

  // 注入间隔锚点：deviceId -> 上次注入时刻（内存时间戳；启动/首见时初始化，离线不推进）
  const lastHeartbeatAt = new Map();
  const lastScreenshotAt = new Map();

  // 在线判定（与 /api/overview 同口径的补集写法）：now - last_seen < offlineAfterSec*1000
  const isOnline = (lastSeen, now) =>
    typeof lastSeen === 'number' && now - lastSeen < config.offlineAfterSec * 1000;

  // 基线：按启动时刻库内状态初始化缓存，不写转换事件；注入锚点也从启动时刻起算
  const bootAt = Date.now();
  for (const row of db.prepare(SQL_APPROVED_DEVICES).all()) {
    lastOnline.set(row.id, isOnline(row.last_seen, bootAt));
    lastHeartbeatAt.set(row.id, bootAt);
    lastScreenshotAt.set(row.id, bootAt);
  }

  const offlineCheck = () => {
    const now = Date.now();
    const rows = db.prepare(SQL_APPROVED_DEVICES).all();
    for (const row of rows) {
      const online = isOnline(row.last_seen, now);
      const prev = lastOnline.get(row.id);
      if (prev === undefined) {
        // 首次见到（如刚批准的设备）只登记当前状态，不视为转换；注入锚点同样从现在起算
        lastOnline.set(row.id, online);
        if (!lastHeartbeatAt.has(row.id)) {
          lastHeartbeatAt.set(row.id, now);
          lastScreenshotAt.set(row.id, now);
        }
        continue;
      }
      if (prev === online) continue; // 无转换不写事件（防重复刷屏）
      lastOnline.set(row.id, online);
      recordEvent({
        deviceId: row.id,
        kind: online ? 'online' : 'offline',
        detail: { device: row.device, last_seen: row.last_seen ?? null },
      });
    }
  };

  const staleSweep = () => {
    recycleStaleTasks({ db, staleMinutes: config.staleMinutes, recordEvent });
  };

  /**
   * 生成一个注入协程的扫描函数（心跳注入器 / 截图采集器共用骨架）。
   * type：任务类型；intervalSec：注入间隔（config 字段）；lastAtMap：该类型的每设备间隔锚点。
   */
  const makeInjectorTick = (type, intervalSec, lastAtMap) => () => {
    const now = Date.now();
    for (const row of db.prepare(SQL_APPROVED_DEVICES).all()) {
      // 仅对 approved=1 且在线的设备注入；离线时跳过且不推进锚点（重新上线后从当刻起算，不补插）
      if (!isOnline(row.last_seen, now)) continue;
      const last = lastAtMap.get(row.id);
      if (last === undefined) {
        // 运行中首见（如刚批准的设备）：锚点从现在起算，下一个间隔才首次注入
        lastAtMap.set(row.id, now);
        continue;
      }
      if (now - last < intervalSec * 1000) continue;
      // 防堆积护栏：同设备存在该类型未终结任务则跳过（不推进锚点，护栏解除后下一扫描周期即恢复）
      const { n } = db.prepare(SQL_HAS_UNFINISHED_BY_TYPE).get(row.id, type);
      if (n > 0) continue;
      db.prepare(SQL_INSERT_QUEUED_TASK).run(crypto.randomUUID(), row.id, type, now);
      lastAtMap.set(row.id, now);
    }
  };

  const heartbeatInject = makeInjectorTick('HeartBeat', config.heartbeatIntervalSec, lastHeartbeatAt);
  const screenshotInject = makeInjectorTick('CaptureImageNow', config.screenshotIntervalSec, lastScreenshotAt);

  // [低4] pending 设备清理：启动即清一次 + 每 60s 一次；无事件（登记/清理都不广播，事件克制纪律）
  const pendingSweep = () => {
    db.prepare(SQL_DELETE_EXPIRED_PENDING).run(Date.now() - PENDING_MAX_AGE_MS);
  };
  pendingSweep();

  const offlineTimer = setInterval(() => {
    try {
      offlineCheck();
    } catch (err) {
      log.error(err, '离线检测器异常');
    }
  }, OFFLINE_CHECK_INTERVAL_MS);
  const staleTimer = setInterval(() => {
    try {
      staleSweep();
    } catch (err) {
      log.error(err, 'stale 回收器异常');
    }
  }, STALE_SWEEP_INTERVAL_MS);
  const heartbeatTimer = setInterval(() => {
    try {
      heartbeatInject();
    } catch (err) {
      log.error(err, '心跳注入器异常');
    }
  }, INJECTOR_SCAN_INTERVAL_MS);
  const screenshotTimer = setInterval(() => {
    try {
      screenshotInject();
    } catch (err) {
      log.error(err, '截图采集器异常');
    }
  }, INJECTOR_SCAN_INTERVAL_MS);
  const pendingTimer = setInterval(() => {
    try {
      pendingSweep();
    } catch (err) {
      log.error(err, 'pending 设备清理器异常');
    }
  }, PENDING_SWEEP_INTERVAL_MS);

  log.info(
    `后台协程已启动：离线检测每 ${OFFLINE_CHECK_INTERVAL_MS}ms，stale 回收每 ${STALE_SWEEP_INTERVAL_MS}ms，` +
      `心跳注入每 ${config.heartbeatIntervalSec}s，截图采集每 ${config.screenshotIntervalSec}s` +
      `（判定阈值 offlineAfterSec=${config.offlineAfterSec}s，staleMinutes=${config.staleMinutes}min，` +
      `截图保留 screenshotKeepCount=${config.screenshotKeepCount} 张/设备）`
  );

  return function stopSchedulers() {
    clearInterval(offlineTimer);
    clearInterval(staleTimer);
    clearInterval(heartbeatTimer);
    clearInterval(screenshotTimer);
    clearInterval(pendingTimer);
  };
}
