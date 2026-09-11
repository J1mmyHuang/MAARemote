// SQLite 建库与四表结构。
// 表结构严格按《实现报告.md》§4.2：devices / tasks / events / screenshots，字段不得增删改名。
// 全部 SQL 均为静态语句 + prepare 参数绑定，禁止任何字符串拼接/模板串拼 SQL。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { DATA_DIR } from './config.js';

export const DB_PATH = path.join(DATA_DIR, 'maa.db');

/**
 * devices.id 的确定性派生：sha256(user + ':' + device)，小写十六进制。
 * 用 ':' 作分隔符避免 (user, device) 二义拼接；maaUserToken 与 MAA 设备标识符
 * 均不含 ':'，可复算。约定在此写明，tools 与后续阶段一律经本函数取 id。
 */
export function deviceIdOf(user, device) {
  return crypto.createHash('sha256').update(`${user}:${device}`, 'utf8').digest('hex');
}

// 建表语句：静态 DDL，IF NOT EXISTS 保证幂等
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS devices (
  id              TEXT PRIMARY KEY,   -- sha256(user + ':' + device)
  user            TEXT,
  device          TEXT,
  approved        INTEGER DEFAULT 0,  -- 0=待批准(401)，1=已放行
  last_seen       INTEGER,            -- 最后一次 getTask 时间戳 → 在线判定
  current_task_id TEXT,               -- 最近一次 HeartBeat 观测到的任务（M3 启用）
  first_seen      INTEGER
);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,     -- uuid（crypto.randomUUID）
  device_id     TEXT,
  type          TEXT,
  params        TEXT,                 -- 仅 Settings 类任务携带，协议层为字符串
  status        TEXT,                 -- queued / dispatched / running / success / failed / stale
  created_at    INTEGER,
  dispatched_at INTEGER,
  finished_at   INTEGER,
  payload_path  TEXT                  -- 截图等大 payload 落盘路径
);

CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY,      -- SQLite rowid 别名，插入时自动分配
  device_id TEXT,
  kind      TEXT,                     -- online/offline/task_started/task_finished/...
  detail    TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS screenshots (
  id         INTEGER PRIMARY KEY,     -- SQLite rowid 别名，插入时自动分配
  device_id  TEXT,
  task_id    TEXT,
  path       TEXT,
  size       INTEGER,
  created_at INTEGER
);
`;

/**
 * 打开（必要时创建）数据库，开启 WAL，确保四表存在。
 * 返回 better-sqlite3 的 Database 实例。
 */
export function openDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  return db;
}
