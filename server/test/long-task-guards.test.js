// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import apiRoutes from '../src/routes/api.js';
import maaRoutes from '../src/routes/maa.js';
import { deviceIdOf } from '../src/db.js';
import { createEventBus } from '../src/eventbus.js';
import { recycleStaleTasks } from '../src/scheduler.js';

const config = {
  maaUserToken: 'long-task-maa-test-secret-value-32chars',
  dashboardToken: 'long-task-dashboard-test-secret-32ch',
  offlineAfterSec: 5,
  screenshotKeepCount: 2,
};

async function fixture(t) {
  const source = await fs.readFile(new URL('../src/db.js', import.meta.url), 'utf8');
  const db = new Database(':memory:');
  db.exec(source.match(/const SCHEMA_SQL = `([\s\S]*?)`;/)[1]);
  const events = [];
  const app = Fastify({ bodyLimit: 100 * 1024 * 1024 });
  await app.register(maaRoutes, { config, db, recordEvent: (event) => events.push(event) });
  await app.register(apiRoutes, { prefix: '/api', config, db, bus: createEventBus() });
  t.after(async () => {
    await app.close();
    db.close();
  });
  const device = { device: 'device-a', id: deviceIdOf(config.maaUserToken, 'device-a') };
  db.prepare('INSERT INTO devices (id, user, device, approved, last_seen, current_task_id, first_seen) VALUES (?, ?, ?, 1, ?, NULL, ?)')
    .run(device.id, config.maaUserToken, device.device, Date.now(), Date.now());
  const headers = { authorization: `Bearer ${config.dashboardToken}` };
  return { app, db, events, device, headers };
}

async function postTask(app, headers, payload) {
  return app.inject({ method: 'POST', url: '/api/tasks', headers, payload });
}

test('用户 LinkStart* 同类型未终结时拒绝叠单，其他类型与 Stop 仍可下发', async (t) => {
  const { app, db, device, headers } = await fixture(t);

  const first = await postTask(app, headers, { type: 'LinkStart', device: device.device });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().status, 'queued');

  const duplicate = await postTask(app, headers, { type: 'LinkStart', device: device.device });
  assert.equal(duplicate.statusCode, 400);
  assert.deepEqual(duplicate.json(), { error: 'already_in_flight' });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE type = 'LinkStart'").get().n, 1);

  const otherType = await postTask(app, headers, { type: 'LinkStart-AutoRoguelike', device: device.device });
  assert.equal(otherType.statusCode, 200);

  const stop = await postTask(app, headers, { type: 'StopTask', device: device.device, confirm: true });
  assert.equal(stop.statusCode, 200);

  const shot = await postTask(app, headers, { type: 'CaptureImageNow', device: device.device });
  assert.equal(shot.statusCode, 200);

  db.prepare("UPDATE tasks SET status = 'success' WHERE id = ?").run(first.json().id);
  const afterSuccess = await postTask(app, headers, { type: 'LinkStart', device: device.device });
  assert.equal(afterSuccess.statusCode, 200);
});

test('心跳仍观测到同类型占用时，即使任务已 stale 也拒绝再下发', async (t) => {
  const { app, db, device, headers } = await fixture(t);
  const staleId = 'stale-roguelike';
  db.prepare("INSERT INTO tasks (id, device_id, type, status, created_at) VALUES (?, ?, 'LinkStart-AutoRoguelike', 'stale', ?)")
    .run(staleId, device.id, Date.now() - 20 * 60 * 1000);
  db.prepare('UPDATE devices SET current_task_id = ? WHERE id = ?').run(staleId, device.id);

  const blocked = await postTask(app, headers, { type: 'LinkStart-AutoRoguelike', device: device.device });
  assert.equal(blocked.statusCode, 400);
  assert.deepEqual(blocked.json(), { error: 'already_in_flight' });

  const other = await postTask(app, headers, { type: 'LinkStart', device: device.device });
  assert.equal(other.statusCode, 200);

  db.prepare('UPDATE devices SET current_task_id = ? WHERE id = ?').run('unknown-maa-job', device.id);
  const unknown = await postTask(app, headers, { type: 'LinkStart-Recruiting', device: device.device });
  assert.equal(unknown.statusCode, 400);
  assert.deepEqual(unknown.json(), { error: 'already_in_flight' });

  db.prepare('UPDATE devices SET current_task_id = NULL WHERE id = ?').run(device.id);
  const cleared = await postTask(app, headers, { type: 'LinkStart-Recruiting', device: device.device });
  assert.equal(cleared.statusCode, 200);
});

test('HeartBeat 观测长任务会刷新 dispatched_at，回收器不再按首次下发时间误标', async (t) => {
  const { app, db, device } = await fixture(t);
  const now = Date.now();
  const oldTs = now - 12 * 60 * 1000;
  const jobId = 'roguelike-long';
  db.prepare("INSERT INTO tasks (id, device_id, type, status, created_at, dispatched_at) VALUES (?, ?, 'LinkStart-AutoRoguelike', 'running', ?, ?)")
    .run(jobId, device.id, oldTs, oldTs);
  db.prepare("INSERT INTO tasks (id, device_id, type, status, created_at, dispatched_at) VALUES (?, ?, 'HeartBeat', 'dispatched', ?, ?)")
    .run('hb-1', device.id, now, now);

  const report = await app.inject({
    method: 'POST',
    url: '/maa/reportStatus',
    payload: {
      user: config.maaUserToken,
      device: device.device,
      task: 'hb-1',
      status: 'SUCCESS',
      payload: jobId,
    },
  });
  assert.equal(report.statusCode, 200);
  assert.equal(report.json().ok, true);

  const observed = db.prepare('SELECT status, dispatched_at FROM tasks WHERE id = ?').get(jobId);
  assert.equal(observed.status, 'running');
  assert.ok(observed.dispatched_at >= now);
  assert.equal(db.prepare('SELECT current_task_id FROM devices WHERE id = ?').get(device.id).current_task_id, jobId);

  const recycled = recycleStaleTasks({
    db,
    staleMinutes: 10,
    now: now + 1000,
    recordEvent: () => {
      throw new Error('仍被心跳确认的长任务不应被标 stale');
    },
  });
  assert.equal(recycled, 0);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(jobId).status, 'running');
});
