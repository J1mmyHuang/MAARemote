import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appSource = () => fs.readFile(fileURLToPath(new URL('../../web/js/app.js', import.meta.url)), 'utf8');
const schedulerSource = () => fs.readFile(fileURLToPath(new URL('../src/scheduler.js', import.meta.url)), 'utf8');

test('快捷操作在途保持可点，并提供进行中确认与清除卡住状态', async () => {
  const source = await appSource();
  assert.match(source, /清除卡住状态/);
  assert.match(source, /再下一单/);
  assert.match(source, /先 Stop/);
  assert.match(source, /kind: 'inflight'/);
  assert.match(source, /isActionDisabled\(action\.type\)/);
  assert.doesNotMatch(source, /isActionBusy\(action\.type\) \? 'disabled'/);
  assert.match(source, /renderStuckClearButton/);
});

test('stale 回收 SQL 覆盖 dispatched 与 running', async () => {
  const source = await schedulerSource();
  assert.match(source, /status IN \('dispatched', 'running'\)/);
  assert.match(source, /export function recycleStaleTasks/);
  assert.match(source, /COALESCE\(dispatched_at, created_at\)/);
});
