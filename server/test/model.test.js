import assert from 'node:assert/strict';
import test from 'node:test';

async function loadModel(t) {
  try {
    return await import('../../web/js/model.js');
  } catch (error) {
    t.assert.fail(`缺少计划中的 web/js/model.js：${error.message}`);
  }
}

test('parseEventDetail 容错解析有效 JSON 与无效 detail', async (t) => {
  const { parseEventDetail } = await loadModel(t);

  assert.deepEqual(parseEventDetail('{"task":"t-1","ok":true}'), { task: 't-1', ok: true });
  assert.equal(parseEventDetail('not-json'), null);
  assert.equal(parseEventDetail(null), null);
});

test('mergeEvents 按真实 id 去重并将新事件置顶', async (t) => {
  const { mergeEvents } = await loadModel(t);
  const previous = [
    { id: 9, kind: 'old' },
    { id: 8, kind: 'older' },
  ];

  const merged = mergeEvents(previous, { id: 10, kind: 'new' });
  assert.deepEqual(merged.map((event) => event.id), [10, 9, 8]);

  const replayed = mergeEvents(merged, { id: 9, kind: 'old-replay' });
  assert.deepEqual(replayed.map((event) => event.id), [10, 9, 8]);
  assert.equal(replayed[1].kind, 'old-replay');
});

test('mergeTaskSnapshots 以真实任务 id 合并且允许 queued 直接跳转 success', async (t) => {
  const { mergeTaskSnapshots } = await loadModel(t);
  const previous = [
    { id: 'task-1', type: 'LinkStart', status: 'queued', created_at: 100 },
    { id: 'task-2', type: 'LinkStart-Base', status: 'running', created_at: 90 },
  ];
  const snapshot = [
    { id: 'task-1', type: 'LinkStart', status: 'success', created_at: 100, finished_at: 200 },
    { id: 'task-3', type: 'CaptureImageNow', status: 'queued', created_at: 110 },
  ];

  const merged = mergeTaskSnapshots(previous, snapshot);
  assert.deepEqual(merged.map((task) => task.id), ['task-3', 'task-1', 'task-2']);
  assert.equal(merged.find((task) => task.id === 'task-1').status, 'success');
  assert.equal(merged.find((task) => task.id === 'task-2').status, 'running');
});

test('restoreInFlightTasks 保留在途任务并将 POST 结果丢失标记为待确认', async (t) => {
  const { restoreInFlightTasks } = await loadModel(t);
  const saved = [
    { id: 'queued-1', type: 'LinkStart', status: 'queued', device: 'emulator-a' },
    { id: 'unknown-1', type: 'LinkStart-Combat', status: 'pending_confirmation', device: 'emulator-a' },
    { id: 'done-1', type: 'LinkStart', status: 'success', device: 'emulator-a' },
  ];

  const restored = restoreInFlightTasks(saved);
  assert.deepEqual(restored.map((task) => task.id), ['queued-1', 'unknown-1']);
  assert.equal(restored.find((task) => task.id === 'unknown-1').pendingConfirmation, true);
});

test('isStopTaskStopped 仅在 StopTask success 且 overview 观测为空闲时返回 true', async (t) => {
  const { isStopTaskStopped } = await loadModel(t);
  const stopSuccess = { id: 'stop-1', type: 'StopTask', status: 'success', device: 'emulator-a' };

  assert.equal(isStopTaskStopped(stopSuccess, { devices: [{ device: 'emulator-a', current_task_id: 'job-1' }] }), false);
  assert.equal(isStopTaskStopped(stopSuccess, { devices: [{ device: 'emulator-a', current_task_id: '' }] }), true);
  assert.equal(isStopTaskStopped({ ...stopSuccess, status: 'queued' }, { devices: [{ device: 'emulator-a', current_task_id: '' }] }), false);
});
