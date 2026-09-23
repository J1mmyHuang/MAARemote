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
  const now = 1_000_000;
  const saved = [
    { id: 'queued-1', type: 'LinkStart', status: 'queued', device: 'emulator-a' },
    { id: 'unknown-1', type: 'LinkStart-Combat', status: 'pending_confirmation', device: 'emulator-a', created_at: now - 1000 },
    { id: 'done-1', type: 'LinkStart', status: 'success', device: 'emulator-a' },
  ];

  const restored = restoreInFlightTasks(saved, now);
  assert.deepEqual(restored.map((task) => task.id), ['queued-1', 'unknown-1']);
  assert.equal(restored.find((task) => task.id === 'unknown-1').pendingConfirmation, true);
});

test('restoreInFlightTasks 丢弃超龄或缺少创建时间的幽灵 pending_confirmation', async (t) => {
  const { restoreInFlightTasks, PENDING_CONFIRMATION_MAX_AGE_MS } = await loadModel(t);
  const now = 10_000_000;
  const restored = restoreInFlightTasks([
    { id: 'pending:old', type: 'LinkStart', status: 'pending_confirmation', device: 'emulator-a', created_at: now - PENDING_CONFIRMATION_MAX_AGE_MS - 1 },
    { id: 'pending:no-ts', type: 'LinkStart', status: 'pending_confirmation', device: 'emulator-a' },
    { id: 'queued-1', type: 'LinkStart', status: 'queued', device: 'emulator-a' },
  ], now);

  assert.deepEqual(restored.map((task) => task.id), ['queued-1']);
});

test('reconcilePendingConfirmationTasks 能用服务端同类型在途或邻近任务清掉幽灵 pending', async (t) => {
  const { reconcilePendingConfirmationTasks } = await loadModel(t);
  const now = 5_000_000;
  const ghost = {
    id: 'pending:1:LinkStart:emulator-a',
    type: 'LinkStart',
    device: 'emulator-a',
    status: 'pending_confirmation',
    created_at: now - 20_000,
    pendingConfirmation: true,
  };
  const otherGhost = {
    id: 'pending:2:LinkStart:emulator-b',
    type: 'LinkStart',
    device: 'emulator-b',
    status: 'pending_confirmation',
    created_at: now - 10_000,
    pendingConfirmation: true,
  };

  const againstRunning = reconcilePendingConfirmationTasks(
    [ghost, otherGhost],
    [{ id: 'real-1', type: 'LinkStart', device: 'emulator-a', status: 'running', created_at: now - 15_000 }],
    now,
  );
  assert.deepEqual(againstRunning.map((task) => task.id), ['pending:2:LinkStart:emulator-b']);

  const againstFinishedNearby = reconcilePendingConfirmationTasks(
    [ghost],
    [{ id: 'real-2', type: 'LinkStart', device: 'emulator-a', status: 'success', created_at: now - 18_000 }],
    now,
  );
  assert.equal(againstFinishedNearby.length, 0);

  const againstUnrelatedOldSuccess = reconcilePendingConfirmationTasks(
    [ghost],
    [{ id: 'old-success', type: 'LinkStart', device: 'emulator-a', status: 'success', created_at: now - 3_600_000 }],
    now,
  );
  assert.equal(againstUnrelatedOldSuccess.length, 1);

  const againstAlreadyMergedRunning = reconcilePendingConfirmationTasks(
    [
      ghost,
      { id: 'real-merged', type: 'LinkStart', device: 'emulator-a', status: 'queued', created_at: now - 5_000 },
    ],
    [],
    now,
  );
  assert.deepEqual(againstAlreadyMergedRunning.map((task) => task.id), ['real-merged']);
});

test('clearPendingConfirmationTasks 只清除指定的幽灵 pending', async (t) => {
  const { clearPendingConfirmationTasks } = await loadModel(t);
  const tasks = [
    { id: 'pending:1', type: 'LinkStart', device: 'emulator-a', status: 'pending_confirmation' },
    { id: 'real-1', type: 'LinkStart', device: 'emulator-a', status: 'running' },
    { id: 'pending:2', type: 'LinkStart-AutoRoguelike', device: 'emulator-a', status: 'pending_confirmation' },
  ];

  const cleared = clearPendingConfirmationTasks(tasks, { type: 'LinkStart', device: 'emulator-a' });
  assert.deepEqual(cleared.map((task) => task.id), ['real-1', 'pending:2']);
});

test('长任务白名单仅覆盖一键除草与自动肉鸽，短 LinkStart-* 仍锁定', async (t) => {
  const {
    canQueueAgainWhileInFlight,
    isLongRunningCommandType,
    isActionControlDisabled,
    shouldOfferInFlightConfirm,
  } = await loadModel(t);

  assert.equal(isLongRunningCommandType('LinkStart'), true);
  assert.equal(isLongRunningCommandType('LinkStart-AutoRoguelike'), true);
  assert.equal(isLongRunningCommandType('LinkStart-Recruiting'), false);
  assert.equal(isLongRunningCommandType('LinkStart-Base'), false);
  assert.equal(isLongRunningCommandType('LinkStart-Mall'), false);
  assert.equal(isLongRunningCommandType('CaptureImageNow'), false);
  assert.equal(isActionControlDisabled({ type: 'LinkStart', inFlight: true }), false);
  assert.equal(isActionControlDisabled({ type: 'LinkStart-AutoRoguelike', inFlight: true }), false);
  assert.equal(isActionControlDisabled({ type: 'LinkStart', sending: true, inFlight: true }), true);
  assert.equal(isActionControlDisabled({ type: 'LinkStart-Recruiting', inFlight: true }), true);
  assert.equal(isActionControlDisabled({ type: 'CaptureImageNow', inFlight: true }), true);

  assert.equal(shouldOfferInFlightConfirm({ type: 'LinkStart', inFlight: true }), true);
  assert.equal(shouldOfferInFlightConfirm({ type: 'LinkStart-Recruiting', inFlight: true }), false);
  assert.equal(shouldOfferInFlightConfirm({
    type: 'LinkStart-AutoRoguelike',
    inFlight: false,
    device: { current_task_id: 'job-1' },
  }), true);
  assert.equal(shouldOfferInFlightConfirm({
    type: 'LinkStart-AutoRoguelike',
    inFlight: false,
    device: { current_task_id: '' },
  }), false);
  assert.equal(canQueueAgainWhileInFlight({
    device: { current_task_id: '' },
    task: { status: 'running' },
  }), false);
  assert.equal(canQueueAgainWhileInFlight({
    device: { current_task_id: '' },
    task: { status: 'queued' },
  }), false);
  assert.equal(canQueueAgainWhileInFlight({
    device: { current_task_id: '' },
    task: { status: 'dispatched' },
  }), false);
  assert.equal(canQueueAgainWhileInFlight({ device: { current_task_id: 'job-1' } }), false);
  assert.equal(canQueueAgainWhileInFlight({
    device: { current_task_id: '' },
    task: { status: 'pending_confirmation' },
  }), true);
  assert.equal(canQueueAgainWhileInFlight({ device: { current_task_id: '' } }), true);
  assert.equal(canQueueAgainWhileInFlight({ sending: true, device: { current_task_id: '' } }), false);
});

test('isStopTaskStopped 仅在 StopTask success 且 overview 观测为空闲时返回 true', async (t) => {
  const { isStopTaskStopped } = await loadModel(t);
  const stopSuccess = { id: 'stop-1', type: 'StopTask', status: 'success', device: 'emulator-a' };

  assert.equal(isStopTaskStopped(stopSuccess, { devices: [{ device: 'emulator-a', current_task_id: 'job-1' }] }), false);
  assert.equal(isStopTaskStopped(stopSuccess, { devices: [{ device: 'emulator-a', current_task_id: '' }] }), true);
  assert.equal(isStopTaskStopped({ ...stopSuccess, status: 'queued' }, { devices: [{ device: 'emulator-a', current_task_id: '' }] }), false);
});
