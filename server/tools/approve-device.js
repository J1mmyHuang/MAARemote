// approve-device.js —— 备用工具：直接改库将设备 approved 置 1。
// 【M4 起正常流程走仪表盘正式 API：POST /api/devices/:id/approve（待批准列表见
//   GET /api/devices/pending；正式 API 会写 device_approved 事件并广播 SSE）】。
// 本工具不写任何事件，仅适合无 curl/网络的本地维护或主控验收时快速批准。
// 用法：node tools/approve-device.js [--device D]
// 直接读写 SQLite 与 config，不走 HTTP。仅对已登记（发起过 getTask、被 401 登记）的设备生效。
import { loadOrCreateConfig } from '../src/config.js';
import { openDb, deviceIdOf } from '../src/db.js';

const args = process.argv.slice(2);
let device = 'mock-device';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--device') {
    device = args[++i];
    if (!device) {
      console.error('用法：node tools/approve-device.js [--device D]');
      process.exit(1);
    }
  } else {
    console.error(`未知参数：${args[i]}`);
    console.error('用法：node tools/approve-device.js [--device D]');
    process.exit(1);
  }
}

const config = loadOrCreateConfig();
const db = openDb();

const deviceId = deviceIdOf(config.maaUserToken, device);
const dev = db.prepare('SELECT id, approved FROM devices WHERE id = ?').get(deviceId);
if (!dev) {
  console.error(`[失败] 设备 ${device}（id=${deviceId}）不存在：该设备需先以相同 user+device 发起一次 getTask 完成 401 登记，再批准。`);
  db.close();
  process.exit(1);
}

db.prepare('UPDATE devices SET approved = 1 WHERE id = ?').run(deviceId);
console.log(`已批准设备：${device}（id=${deviceId}，approved 0 → 1）`);
db.close();
