// backdate-task.js —— 自测辅助（M2 验收 stale 回收用）：把指定任务的 dispatched_at 改为 N 分钟前，
// 使其落入 stale 回收器的扫描范围（dispatched / running 超 staleMinutes 无终结回报 → stale，不再下发）。
// HeartBeat 若仍观测到该任务会刷新 dispatched_at；验证「失联超时」时需停掉心跳或回拨后尽快回收。
// 用法：node tools/backdate-task.js <task_id> [minutes]
//   <task_id>  任务 id（insert-task.js 输出的 id；也可从 /api/tasks 或库里查）
//   [minutes]  回拨分钟数，默认 11（大于 staleMinutes 默认值 10 即可触发）
// 直接读写 SQLite，参数绑定；仅测试用，不参与业务流程。
import { openDb } from '../src/db.js';

function usage() {
  console.error('用法：node tools/backdate-task.js <task_id> [minutes]');
  process.exit(1);
}

const args = process.argv.slice(2);
const [taskId, minutesArg] = args;
if (!taskId) usage();
const minutes = Number.parseInt(minutesArg ?? '11', 10);
if (!Number.isFinite(minutes) || minutes <= 0) {
  console.error('[失败] minutes 必须是正整数');
  usage();
}

const db = openDb();
const SQL_GET_TASK = 'SELECT id, type, status, dispatched_at FROM tasks WHERE id = ?';
const row = db.prepare(SQL_GET_TASK).get(taskId);
if (!row) {
  console.error(`[失败] 任务 ${taskId} 不存在`);
  db.close();
  process.exit(1);
}
if (row.status !== 'dispatched' && row.status !== 'running') {
  console.error(
    `[警告] 任务 ${taskId} 当前 status=${row.status}（非 dispatched/running）；已仍按请求回拨 dispatched_at，` +
      `但 stale 回收器只扫描 status IN ('dispatched','running') 的行`
  );
}

const newTs = Date.now() - minutes * 60000;
// 参数绑定回拨；不改动 status，交由服务端 stale 回收器按正常路径回收（验证完整链路）
db.prepare('UPDATE tasks SET dispatched_at = ? WHERE id = ?').run(newTs, taskId);

console.log(
  `已回拨任务 ${taskId}（type=${row.type}, status=${row.status}）：` +
    `dispatched_at ${row.dispatched_at} → ${newTs}（${minutes} 分钟前）`
);
db.close();
