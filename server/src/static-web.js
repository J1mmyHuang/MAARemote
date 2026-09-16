// 仪表盘同源静态托管：不增加依赖，并且永不接管 API 或 MAA 协议路径。
import fs from 'node:fs/promises';
import path from 'node:path';

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
  ['.ttf', 'font/ttf'],
]);

const isWithinRoot = (candidate, root) => candidate === root || candidate.startsWith(`${root}${path.sep}`);

function decodePathname(rawUrl) {
  let pathname = rawUrl.split('?', 1)[0];
  try {
    // 浏览器正常请求只需解码一层；多层编码也必须在进入文件系统前显形并受校验。
    for (let depth = 0; depth < 4; depth += 1) {
      const decoded = decodeURIComponent(pathname);
      if (decoded === pathname) break;
      pathname = decoded;
    }
    return pathname;
  } catch {
    return null;
  }
}

async function readStaticFile(webRoot, requestedPath) {
  const relativePath = requestedPath.replace(/^[/\\]+/, '');
  const candidate = path.resolve(webRoot, relativePath);
  if (!isWithinRoot(candidate, webRoot)) return null;

  try {
    const realCandidate = await fs.realpath(candidate);
    if (!isWithinRoot(realCandidate, webRoot)) return null;
    const stat = await fs.stat(realCandidate);
    if (!stat.isFile()) return null;
    return { body: await fs.readFile(realCandidate), extension: path.extname(realCandidate).toLowerCase() };
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export default async function staticWeb(fastify, options) {
  const webRoot = await fs.realpath(options.webRoot);
  const indexPath = path.join(webRoot, 'index.html');

  // 仪表盘可执行远程操作，禁止外站套框诱导点击；不影响既有脚本和样式。
  fastify.addHook('onRequest', async (_request, reply) => {
    reply.header('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
  });

  async function sendIndex(reply) {
    const index = await readStaticFile(webRoot, indexPath);
    if (!index) return reply.code(404).send();
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .type('text/html; charset=utf-8')
      .send(index.body);
  }

  async function serveWeb(request, reply) {
    const pathname = decodePathname(request.raw.url);
    if (pathname === null || pathname.includes('\0') || pathname.split(/[\\/]+/).includes('..')) {
      return reply.code(400).send();
    }
    if (pathname === '/api' || pathname.startsWith('/api/') || pathname === '/maa' || pathname.startsWith('/maa/')) {
      return reply.callNotFound();
    }

    const file = await readStaticFile(webRoot, pathname);
    if (file) {
      return reply
        .header('X-Content-Type-Options', 'nosniff')
        .type(MIME_TYPES.get(file.extension) || 'application/octet-stream')
        .send(file.body);
    }
    return sendIndex(reply);
  }

  fastify.get('/*', serveWeb);
}
