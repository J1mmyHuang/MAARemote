// 服务端入口：加载/生成配置 → 打开 SQLite → 创建事件总线 → 注册 MAA 协议路由与仪表盘 API →
// 启动后台协程（离线检测器 + stale 回收器）→ 监听。
// 说明：监听地址固定 127.0.0.1（安全默认，不向局域网暴露）；
// 本机 mock 联调足够用，日后 cloudflared Tunnel 也是在本机回源（localhost 指向本服务），无需改为 0.0.0.0。
import fs from 'node:fs';
import Fastify from 'fastify';
import { loadOrCreateConfig, SCREENSHOT_DIR } from './config.js';
import { openDb } from './db.js';
import { createEventBus, recordAndPublishEvent } from './eventbus.js';
import maaRoutes from './routes/maa.js';
import apiRoutes from './routes/api.js';
import { startSchedulers } from './scheduler.js';

// 1. 配置：首次运行自动生成 server/config.json（含随机 token）
const config = loadOrCreateConfig();

// 2. 数据库：server/data/maa.db（四表）与 server/data/screenshots/ 运行时目录
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
const db = openDb();

// 3. 事件总线：所有写 events 表处统一经 recordEvent（入库 + 广播一次完成）
const bus = createEventBus();
const recordEvent = (eventOpts) => recordAndPublishEvent(db, bus, eventOpts);

// 4. HTTP 服务：bodyLimit 100MB —— 截图 Base64 可达数十 MB
// [中A] 日志脱敏：dashboardToken 支持经 ?token= 通道出现（浏览器 <img>/SSE 无法自定义 header），
// 而 Fastify 默认 req 序列化器会把完整 URL（含 query）写进「incoming request」日志 → token 落盘。
// 这里自定义 req 序列化器：url 剥离 query，其余字段（method/version/host/remoteAddress/remotePort）
// 与 Fastify 默认实现保持同构；日志仍保留方法 / 无 query 路径 / 状态码（res 序列化器不变）。
const stripUrlQuery = (rawUrl) => {
  if (typeof rawUrl !== 'string') return rawUrl;
  const q = rawUrl.indexOf('?');
  return q === -1 ? rawUrl : rawUrl.slice(0, q);
};
const fastify = Fastify({
  logger: {
    level: 'info',
    serializers: {
      req: (req) => ({
        method: req.method,
        url: stripUrlQuery(req.url),
        version: req.headers && req.headers['accept-version'],
        host: req.host,
        remoteAddress: req.ip,
        remotePort: req.socket ? req.socket.remotePort : undefined,
      }),
    },
  },
  bodyLimit: 100 * 1024 * 1024,
});

// /maa/*：MAA 协议端点（匿名可达，按协议红线自行校验 user/device）
await fastify.register(maaRoutes, { config, db, recordEvent });
// /api/*：仪表盘 API（插件内部注册 dashboardToken 鉴权钩子，仅作用于该前缀）
await fastify.register(apiRoutes, { prefix: '/api', config, db, bus });

// 5. 后台协程：离线检测器 + stale 回收器（含事件写入与广播）
const stopSchedulers = startSchedulers({ config, db, bus, log: fastify.log, recordEvent });

// 6. 优雅退出：停协程 → 关 HTTP → 关数据库
async function shutdown() {
  try {
    stopSchedulers();
    await fastify.close();
    db.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGBREAK', shutdown); // Windows Ctrl+Break / 控制台关闭

// 7. 启动：host 固定 127.0.0.1，端口读 config.port（默认 24325）
try {
  await fastify.listen({ port: config.port, host: '127.0.0.1' });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
