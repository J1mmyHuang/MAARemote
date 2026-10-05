// SPDX-License-Identifier: MPL-2.0
// 仪表盘鉴权：/api/* 全部要求 dashboardToken。
// 支持两种携带方式，任一匹配即放行：
//   1. Authorization: Bearer <dashboardToken>
//   2. ?token=<dashboardToken>（为 SSE / 浏览器 EventSource 无法自定义 header 而设）
// token 只从 config 读取，源码不含任何凭据字面量；比较使用 timingSafeEqual 防时序侧信道。
// 安全修复轮（Mr-sec1）：① safeEqual 导出，供 maaUserToken 校验复用（低1：非常量时间比较加固）；
// ② buildDashboardAuth 增加可选 onAuthFailure 回调（低2：鉴权失败按来源 IP 限频，超限 429）；
//   不传回调时行为与 M2 契约完全一致（401 {"error":"unauthorized"}）。
import crypto from 'node:crypto';

/** 等长安全比较（长度不同直接 false；不匹配/不足长度一律视为校验失败） */
export function safeEqual(a, b) {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** 从请求中提取候选 token：优先 Bearer header，其次 ?token= 查询参数 */
function extractCandidate(request) {
  const header = request.headers?.authorization;
  if (typeof header === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m) return m[1].trim();
  }
  const q = request.query?.token;
  if (typeof q === 'string' && q.length > 0) return q;
  return null;
}

/** 纯判定：候选 token 与 dashboardToken 是否匹配（不发送响应；供钩子与限流组合使用） */
export function checkDashboardToken(config, request) {
  const expected = String(config.dashboardToken ?? '');
  const candidate = extractCandidate(request);
  return candidate !== null && safeEqual(candidate, expected);
}

/**
 * 生成 Fastify onRequest 鉴权钩子。
 * opts.onAuthFailure: 可选 (request) => boolean，仅在与 token 不匹配时调用；
 *   返回 true 表示该来源已超限流阈值 → 429，否则 401。
 * 401 响应体保持 M2 契约：{"error":"unauthorized"}；429 响应体：{"error":"too_many_requests"}。
 */
export function buildDashboardAuth(config, { onAuthFailure } = {}) {
  return async function dashboardAuth(request, reply) {
    if (checkDashboardToken(config, request)) return;
    if (onAuthFailure && onAuthFailure(request)) {
      return reply.code(429).send({ error: 'too_many_requests' });
    }
    return reply.code(401).send({ error: 'unauthorized' });
  };
}
