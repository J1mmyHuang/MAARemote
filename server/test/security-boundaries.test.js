// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import apiRoutes from '../src/routes/api.js';
import staticWeb from '../src/static-web.js';
import { deviceIdOf } from '../src/db.js';
import { createEventBus } from '../src/eventbus.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
// 复制源码到项目内隔离目录，使截图模块的派生 DATA_DIR 也远离真实运行数据。
const isolatedRoot = path.join(root, 'server/test-results');
await fs.mkdir(isolatedRoot, { recursive: true });
const isolatedServer = await fs.mkdtemp(path.join(isolatedRoot, 'security-'));
await fs.cp(path.join(root, 'server/src'), path.join(isolatedServer, 'src'), { recursive: true });
const { pathToFileURL } = await import('node:url');
const { default: maaRoutes } = await import(pathToFileURL(path.join(isolatedServer, 'src/routes/maa.js')));
after(() => fs.rm(isolatedServer, { recursive: true, force: true }));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const config = { maaUserToken: 'isolated-maa-test-secret', dashboardToken: 'isolated-dashboard-test-secret', offlineAfterSec: 5, screenshotKeepCount: 2 };

async function fixture(t) {
  // 使用实际建表 SQL，但绝不调用会打开真实运行数据库的 openDb。
  const source = await fs.readFile(new URL('../src/db.js', import.meta.url), 'utf8');
  const db = new Database(':memory:');
  db.exec(source.match(/const SCHEMA_SQL = `([\s\S]*?)`;/)[1]);
  const events = [];
  const app = Fastify({ bodyLimit: 100 * 1024 * 1024 });
  await app.register(maaRoutes, { config, db, recordEvent: (event) => events.push(event) });
  await app.register(apiRoutes, { prefix: '/api', config, db, bus: createEventBus() });
  await app.register(staticWeb, { webRoot: path.join(root, 'web') });
  t.after(async () => { await app.close(); db.close(); });
  const devices = ['device-a', 'device-b'].map((device) => ({ device, id: deviceIdOf(config.maaUserToken, device) }));
  for (const device of devices) db.prepare('INSERT INTO devices (id, user, device, approved) VALUES (?, ?, ?, 1)').run(device.id, config.maaUserToken, device.device);
  const headers = { authorization: `Bearer ${config.dashboardToken}` };
  return { app, db, events, devices, headers };
}

for (const type of ['LinkStart', 'HeartBeat', 'CaptureImageNow']) {
  for (const status of ['queued', 'dispatched', 'running', 'success', 'stale']) {
  test(`任务回报必须绑定所属设备：${type}/${status}`, async (t) => {
    const { app, db, events, devices } = await fixture(t);
    db.prepare('INSERT INTO tasks (id, device_id, type, status) VALUES (?, ?, ?, ?)').run('foreign-task', devices[1].id, type, status);
    const response = await app.inject({ method: 'POST', url: '/maa/reportStatus', payload: { user: config.maaUserToken, device: devices[0].device, task: 'foreign-task', status: 'SUCCESS', payload: type === 'CaptureImageNow' ? png : 'private-job' } });
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get('foreign-task').status, status);
    assert.equal(events.length, 0);
    assert.deepEqual(response.json(), { ok: false, error: 'task_not_found' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM screenshots').get().n, 0);
    assert.equal(db.prepare('SELECT current_task_id FROM devices WHERE id = ?').get(devices[0].id).current_task_id, null);
    await assert.rejects(fs.stat(path.join(isolatedServer, 'data/screenshots/foreign-task.png')), { code: 'ENOENT' });
  });
  }
}

test('正常截图回报保存 PNG，重复回报不会覆写文件或重复发布事件', async (t) => {
  const { app, db, events, devices } = await fixture(t);
  db.prepare("INSERT INTO tasks (id, device_id, type, status) VALUES (?, ?, 'CaptureImageNow', 'dispatched')").run('own-image', devices[0].id);
  const report = { method: 'POST', url: '/maa/reportStatus', payload: { user: config.maaUserToken, device: devices[0].device, task: 'own-image', status: 'SUCCESS', payload: png } };
  assert.equal((await app.inject(report)).json().ok, true);
  const row = db.prepare('SELECT * FROM screenshots').get();
  assert.ok(row.path.startsWith(isolatedServer + path.sep));
  assert.deepEqual(await fs.readFile(row.path), Buffer.from(png, 'base64'));
  report.payload.payload = 'different-content';
  assert.equal((await app.inject(report)).json().ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM screenshots').get().n, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'screenshot_saved');
  assert.deepEqual(await fs.readFile(row.path), Buffer.from(png, 'base64'));
});

test('正常回报仍可终结任务，重复回报保持幂等', async (t) => {
  const { app, db, events, devices } = await fixture(t);
  db.prepare("INSERT INTO tasks (id, device_id, type, status, created_at) VALUES (?, ?, 'LinkStart', 'queued', ?)").run('own-task', devices[0].id, Date.now() - 15_000);
  const polling = { method: 'POST', url: '/maa/getTask', payload: { user: config.maaUserToken, device: devices[0].device } };
  assert.deepEqual((await app.inject(polling)).json(), (await app.inject(polling)).json());
  const report = { method: 'POST', url: '/maa/reportStatus', payload: { ...polling.payload, task: 'own-task', status: 'SUCCESS' } };
  assert.equal((await app.inject(report)).json().ok, true);
  const eventCount = events.length;
  const finishEvent = events.at(-1);
  assert.equal(finishEvent.kind, 'task_finished');
  assert.ok(Number.isInteger(finishEvent.detail.duration_ms));
  assert.ok(finishEvent.detail.duration_ms >= 15_000);
  assert.equal((await app.inject(report)).json().ok, true);
  assert.equal(events.length, eventCount);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get('own-task').status, 'success');
  assert.deepEqual((await app.inject(polling)).json(), { tasks: [] });
});

test('大截图通道不能用于登记超大设备标识或存储超大心跳', async (t) => {
  const { app, db, devices } = await fixture(t);
  const tooLong = '设'.repeat(24 * 1024);
  const unknown = await app.inject({ method: 'POST', url: '/maa/reportStatus', payload: { user: config.maaUserToken, device: tooLong, task: 'unknown', status: 'SUCCESS' } });
  assert.equal(unknown.statusCode, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM devices').get().n, 2);
  db.prepare("INSERT INTO tasks (id, device_id, type, status) VALUES (?, ?, 'HeartBeat', 'dispatched')").run('heartbeat', devices[0].id);
  const heartbeat = await app.inject({ method: 'POST', url: '/maa/reportStatus', payload: { user: config.maaUserToken, device: devices[0].device, task: 'heartbeat', status: 'SUCCESS', payload: tooLong } });
  assert.equal(heartbeat.statusCode, 400);
  assert.equal(db.prepare('SELECT current_task_id FROM devices WHERE id = ?').get(devices[0].id).current_task_id, null);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get('heartbeat').status, 'dispatched');
});

test('普通任务的多余 payload 不进入任务记录或事件，解析预算另行评估', async (t) => {
  const { app, db, events, devices } = await fixture(t);
  const unusedPayload = 'private-unused-payload'.repeat(8192);
  for (const type of ['LinkStart', 'StopTask', 'Settings-Stage1']) {
    const taskId = 'unused-' + type;
    db.prepare("INSERT INTO tasks (id, device_id, type, status) VALUES (?, ?, ?, 'dispatched')").run(taskId, devices[0].id, type);
    const result = await app.inject({ method: 'POST', url: '/maa/reportStatus', payload: { user: config.maaUserToken, device: devices[0].device, task: taskId, status: 'SUCCESS', payload: unusedPayload } });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(events.at(-1).detail, { task_id: taskId, type, status: 'success', duration_ms: null });
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    assert.equal(row.payload_path, null);
    assert.ok(!JSON.stringify(row).includes(unusedPayload));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM screenshots').get().n, 0);
});

test('仪表盘私密响应和错误响应禁止缓存，截图禁止内容嗅探', async (t) => {
  const { app, db, devices, headers } = await fixture(t);
  // 文件只用已有公开测试文件，避免写入真实截图目录。
  db.prepare('INSERT INTO screenshots (device_id, task_id, path, size, created_at) VALUES (?, ?, ?, 1, 1)').run(devices[0].id, 'test-image', fileURLToPath(import.meta.url));
  for (const url of ['/api/overview', '/api/tasks', '/api/screenshots', '/api/screenshots/1', '/api/screenshots/999', '/api/devices/pending']) {
    const response = await app.inject({ url, headers });
    assert.match(response.headers['cache-control'] || '', /no-store/, url);
    assert.equal(response.headers['referrer-policy'], 'no-referrer', url);
    assert.equal(response.headers['x-content-type-options'], 'nosniff', url);
  }
  const rejected = await app.inject({ url: '/api/overview' });
  assert.equal(rejected.statusCode, 401);
  assert.match(rejected.headers['cache-control'] || '', /no-store/);
});

test('仪表盘页面禁止被第三方框架嵌入以防点击劫持', async (t) => {
  const { app } = await fixture(t);
  for (const url of ['/', '/index.html', '/tasks/detail']) {
  const response = await app.inject({ url });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-security-policy'] || '', /frame-ancestors 'none'/);
  assert.equal(response.headers['x-frame-options'], 'DENY');
  }
});
