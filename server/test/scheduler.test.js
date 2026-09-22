import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import Database from 'better-sqlite3';
import { recycleStaleTasks } from '../src/scheduler.js';

async function memoryDb() {
  const source = await fs.readFile(new URL('../src/db.js', import.meta.url), 'utf8');
  const db = new Database(':memory:');
  db.exec(source.match(/const SCHEMA_SQL = `([\s\S]*?)`;/)[1]);
  return db;
}

function insertTask(db, { id, type = 'LinkStart', status, createdAt, dispatchedAt }) {
  db.prepare(
    'INSERT INTO tasks (id, device_id, type, status, created_at, dispatched_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, 'device-a', type, status, createdAt, dispatchedAt);
}

test('recycleStaleTasks 回收超时的 dispatched 与 running，但不动未超时或已终结任务', async () => {
  const db = await memoryDb();
  const events = [];
  const now = 1_000_000;
  const staleMinutes = 10;
  const oldTs = now - 11 * 60 * 1000;
  const freshTs = now - 2 * 60 * 1000;

  insertTask(db, { id: 'old-dispatched', status: 'dispatched', createdAt: oldTs, dispatchedAt: oldTs });
  insertTask(db, { id: 'old-running', status: 'running', createdAt: oldTs, dispatchedAt: oldTs });
  insertTask(db, { id: 'running-no-dispatch', status: 'running', createdAt: oldTs, dispatchedAt: null });
  insertTask(db, { id: 'fresh-running', status: 'running', createdAt: freshTs, dispatchedAt: freshTs });
  insertTask(db, { id: 'queued-old', status: 'queued', createdAt: oldTs, dispatchedAt: null });
  insertTask(db, { id: 'already-success', status: 'success', createdAt: oldTs, dispatchedAt: oldTs });
  insertTask(db, { id: 'heartbeat-running', type: 'HeartBeat', status: 'running', createdAt: oldTs, dispatchedAt: oldTs });

  const recycled = recycleStaleTasks({
    db,
    staleMinutes,
    now,
    recordEvent: (event) => events.push(event),
  });

  assert.equal(recycled, 4);
  const statusOf = (id) => db.prepare('SELECT status FROM tasks WHERE id = ?').get(id).status;
  assert.equal(statusOf('old-dispatched'), 'stale');
  assert.equal(statusOf('old-running'), 'stale');
  assert.equal(statusOf('running-no-dispatch'), 'stale');
  assert.equal(statusOf('fresh-running'), 'running');
  assert.equal(statusOf('queued-old'), 'queued');
  assert.equal(statusOf('already-success'), 'success');
  assert.equal(statusOf('heartbeat-running'), 'stale');
  assert.deepEqual(events.map((event) => event.detail.task_id).sort(), [
    'old-dispatched',
    'old-running',
    'running-no-dispatch',
  ]);
  assert.ok(!events.some((event) => event.detail.task_id === 'heartbeat-running'));
  db.close();
});

test('recycleStaleTasks 对已终结任务的竞态 UPDATE 不计事件', async () => {
  const db = await memoryDb();
  const events = [];
  const now = 1_000_000;
  const oldTs = now - 11 * 60 * 1000;
  insertTask(db, { id: 'race', status: 'success', createdAt: oldTs, dispatchedAt: oldTs });

  const recycled = recycleStaleTasks({
    db,
    staleMinutes: 10,
    now,
    recordEvent: (event) => events.push(event),
  });

  assert.equal(recycled, 0);
  assert.equal(events.length, 0);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get('race').status, 'success');
  db.close();
});
