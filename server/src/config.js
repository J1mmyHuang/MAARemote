// 配置加载与首次运行生成。
// 字段与默认值严格对齐 README.md「配置项」表（8 个字段，不得增删）；
// maaUserToken / dashboardToken 仅在运行时用 Node crypto 随机生成，源码中不得出现任何可用凭据字面量。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// server/ 根目录（本文件位于 src/ 下，上一级即 server/）
export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = path.join(SERVER_ROOT, 'config.json');
export const DATA_DIR = path.join(SERVER_ROOT, 'data');
export const SCREENSHOT_DIR = path.join(DATA_DIR, 'screenshots');

// 随机令牌：32 字节（256 位熵）编码为 43 位 base64url，不可预测
function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// README.md 配置表中的默认值（token 字段默认随机生成）
const DEFAULTS = {
  port: 24325,
  maaUserToken: null, // 运行时生成
  dashboardToken: null, // 运行时生成
  heartbeatIntervalSec: 30,
  screenshotIntervalSec: 300,
  staleMinutes: 10,
  screenshotKeepCount: 50,
  offlineAfterSec: 5,
};

/**
 * 读取 server/config.json；文件不存在时按默认值生成（token 随机）。
 * 已存在但缺少字段/字段非法时，补齐默认值并回写。
 * 同时确保 data/ 与 data/screenshots/ 目录存在。
 */
export function loadOrCreateConfig() {
  let raw = {};
  const existed = fs.existsSync(CONFIG_PATH);
  if (existed) {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  const cfg = { ...DEFAULTS, ...raw };
  let changed = !existed;

  if (typeof cfg.maaUserToken !== 'string' || cfg.maaUserToken.length < 32) {
    cfg.maaUserToken = randomToken();
    changed = true;
  }
  if (typeof cfg.dashboardToken !== 'string' || cfg.dashboardToken.length < 32) {
    cfg.dashboardToken = randomToken();
    changed = true;
  }
  if (!Number.isInteger(cfg.port) || cfg.port <= 0 || cfg.port > 65535) {
    cfg.port = DEFAULTS.port;
    changed = true;
  }
  // 监控闭环三字段（M3）：非正整数一律回落默认值，风格与 port 校验一致
  if (!Number.isInteger(cfg.heartbeatIntervalSec) || cfg.heartbeatIntervalSec <= 0) {
    cfg.heartbeatIntervalSec = DEFAULTS.heartbeatIntervalSec;
    changed = true;
  }
  if (!Number.isInteger(cfg.screenshotIntervalSec) || cfg.screenshotIntervalSec <= 0) {
    cfg.screenshotIntervalSec = DEFAULTS.screenshotIntervalSec;
    changed = true;
  }
  if (!Number.isInteger(cfg.screenshotKeepCount) || cfg.screenshotKeepCount <= 0) {
    cfg.screenshotKeepCount = DEFAULTS.screenshotKeepCount;
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  }

  // 运行时数据目录（maa.db 与 screenshots/）
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  return cfg;
}
