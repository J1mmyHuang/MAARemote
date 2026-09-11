// insert-task.js —— 自测辅助：向指定 mock 设备插入一条 queued 任务并打印任务 id。
// 用法：node tools/insert-task.js <type> [params] [--device D]
//   <type>    任务类型，如 LinkStart、CaptureImageNow、Settings-Stage1 等
//   [params]  可选，Settings 类任务的 params（协议层为字符串，原样入库）
//   --device  目标设备名，默认 mock-device
// 直接读写 SQLite 与 config，不走 HTTP。
import crypto from 'node:crypto';
import { loadOrCreateConfig } from '../src/config.js';
import { openDb, deviceIdOf } from '../src/db.js';

function usage() {
  console.error('用法：node tools/insert-task.js <type> [params] [--device D]');
  process.exit(1);
}

const args = process.argv.slice(2);
const positional = [];
let device = 'mock-device';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--device') {
    device = args[++i];
    if (!device) usage();
  } else {
    positional.push(args[i]);
  }
}
if (positional.length < 1 || positional.length > 2) usage();

const [type, params] = positional;
const config = loadOrCreateConfig();
const db = openDb();

const user = config.maaUserToken;
const deviceId = deviceIdOf(user, device);
const dev = db.prepare('SELECT id, approved FROM devices WHERE id = ?').get(deviceId);
if (!dev) {
  console.error(`[警告] 设备 ${device}（id=${deviceId}）尚未登记：该设备需先以相同 user+device 发起过一次 getTask（会以 401 登记）。任务仍将插入，但批准前不会被下发。`);
} else if (!dev.approved) {
  console.error(`[警告] 设备 ${device} 尚未批准（approved=0），任务已插入但不会被下发；请先运行 tools/approve-device.js。`);
}

const id = crypto.randomUUID();
db.prepare(
  "INSERT INTO tasks (id, device_id, type, params, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)"
).run(id, deviceId, type, params ?? null, Date.now());

console.log(`已插入任务：id=${id} type=${type}${params !== undefined ? ` params=${params}` : ''} device=${device}`);
db.close();
