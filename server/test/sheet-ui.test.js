import assert from 'node:assert/strict';
import test from 'node:test';

async function loadSheet(t) {
  try {
    return await import('../../web/js/sheet.js');
  } catch (error) {
    t.assert.fail(`缺少计划中的 web/js/sheet.js：${error.message}`);
  }
}

test('短下拉和上拉回弹，足够距离或速度的下拉关闭面板', async (t) => {
  const { resolveSheetRelease } = await loadSheet(t);

  assert.equal(resolveSheetRelease({ deltaY: 14, elapsedMs: 180, panelHeight: 536 }), 'snap');
  assert.equal(resolveSheetRelease({ deltaY: -20, elapsedMs: 80, panelHeight: 536 }), 'snap');
  assert.equal(resolveSheetRelease({ deltaY: 352, elapsedMs: 500, panelHeight: 536 }), 'close');
  assert.equal(resolveSheetRelease({ deltaY: 42, elapsedMs: 40, panelHeight: 536 }), 'close');
});

test('拖拽上下文保留触发元素并在关闭时恢复焦点', async (t) => {
  const { captureSheetContext, restoreSheetFocus } = await loadSheet(t);
  const trigger = { id: 'open-task', focusCalls: 0, focus() { this.focusCalls += 1; } };
  const context = captureSheetContext({ trigger, scrollY: 240 });

  assert.equal(context.scrollY, 240);
  assert.equal(restoreSheetFocus(context), true);
  assert.equal(trigger.focusCalls, 1);
  assert.equal(restoreSheetFocus(captureSheetContext({ trigger: null, scrollY: 0 })), false);
});

test('关闭过渡先保留弹层，完成 150ms 动画后再移除', async (t) => {
  const { startSheetCloseTransition } = await loadSheet(t);
  const layerClasses = new Set();
  const panelClasses = new Set(['is-dragging']);
  let frameCallback = null;
  let timerCallback = null;
  let scheduledDelay = null;
  let completed = 0;
  const layer = {
    classList: {
      add(value) { layerClasses.add(value); },
      remove(value) { layerClasses.delete(value); },
    },
  };
  const panel = {
    classList: {
      add(value) { panelClasses.add(value); },
      remove(value) { panelClasses.delete(value); },
    },
    getBoundingClientRect() { return { height: 420 }; },
    style: { animation: '', opacity: '', transform: '' },
  };

  startSheetCloseTransition({
    layer,
    panel,
    onComplete() { completed += 1; },
    requestFrame(callback) { frameCallback = callback; return 11; },
    cancelFrame() {},
    schedule(callback, delay) { timerCallback = callback; scheduledDelay = delay; return 12; },
    cancelSchedule() {},
  });

  assert.equal(layerClasses.has('is-closing'), true);
  assert.equal(panelClasses.has('is-dragging'), false);
  assert.equal(panel.style.animation, 'none');
  assert.equal(completed, 0);
  assert.equal(panel.style.transform, '');

  frameCallback();
  assert.equal(panel.style.transform, 'translateY(420px)');
  assert.equal(panel.style.opacity, '0');
  assert.equal(scheduledDelay, 150);
  assert.equal(completed, 0);

  timerCallback();
  assert.equal(completed, 1);
});

test('新弹层打断关闭动画时取消旧回调并清理临时样式', async (t) => {
  const { startSheetCloseTransition } = await loadSheet(t);
  const layerClasses = new Set();
  let cancelledFrame = null;
  let completed = 0;
  const layer = {
    classList: {
      add(value) { layerClasses.add(value); },
      remove(value) { layerClasses.delete(value); },
    },
  };
  const panel = {
    classList: { remove() {} },
    getBoundingClientRect() { return { height: 360 }; },
    style: { animation: '', opacity: '', transform: '' },
  };

  const cancel = startSheetCloseTransition({
    layer,
    panel,
    onComplete() { completed += 1; },
    requestFrame() { return 21; },
    cancelFrame(id) { cancelledFrame = id; },
    schedule() { throw new Error('取消发生在下一帧前，不应创建完成计时器'); },
    cancelSchedule() {},
  });

  cancel();

  assert.equal(cancelledFrame, 21);
  assert.equal(layerClasses.has('is-closing'), false);
  assert.equal(panel.style.animation, '');
  assert.equal(panel.style.transform, '');
  assert.equal(panel.style.opacity, '');
  assert.equal(completed, 0);
});
