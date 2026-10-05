// SPDX-License-Identifier: AGPL-3.0-or-later
const MIN_CLOSE_DISTANCE_PX = 128;
const MAX_CLOSE_DISTANCE_PX = 224;
const CLOSE_DISTANCE_RATIO = 0.45;
const CLOSE_VELOCITY_PX_PER_MS = 0.8;
const SHEET_TRANSITION_MS = 150;

export function closeDistanceForPanel(panelHeight) {
  const height = Number.isFinite(panelHeight) && panelHeight > 0 ? panelHeight : 536;
  return Math.max(MIN_CLOSE_DISTANCE_PX, Math.min(MAX_CLOSE_DISTANCE_PX, height * CLOSE_DISTANCE_RATIO));
}

/** 根据真实指针位移和速度判断关闭或回弹；只有向下拖拽允许关闭。 */
export function resolveSheetRelease({ deltaY = 0, elapsedMs = 1, panelHeight = 536 } = {}) {
  const downwardDistance = Math.max(0, Number(deltaY) || 0);
  const duration = Math.max(1, Number(elapsedMs) || 1);
  const velocity = downwardDistance / duration;
  if (downwardDistance >= closeDistanceForPanel(panelHeight) || velocity >= CLOSE_VELOCITY_PX_PER_MS) {
    return 'close';
  }
  return 'snap';
}

export function clampSheetOffset(deltaY, panelHeight) {
  const height = Number.isFinite(panelHeight) && panelHeight > 0 ? panelHeight : 536;
  return Math.min(height, Math.max(0, Number(deltaY) || 0));
}

export function captureSheetContext({ trigger = null, scrollY = 0 } = {}) {
  return { trigger, scrollY: Number.isFinite(scrollY) ? scrollY : 0 };
}

export function restoreSheetFocus(context) {
  const trigger = context?.trigger;
  if (!trigger || typeof trigger.focus !== 'function') return false;
  trigger.focus({ preventScroll: true });
  return true;
}

/** 保留弹层节点直到关闭动画完成，并允许新弹层打断尚未完成的关闭。 */
export function startSheetCloseTransition({
  layer,
  panel,
  reducedMotion = false,
  onComplete,
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (id) => cancelAnimationFrame(id),
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancelSchedule = (id) => clearTimeout(id),
} = {}) {
  if (!layer || !panel || typeof onComplete !== 'function') {
    onComplete?.();
    return () => {};
  }

  let active = true;
  let frameId = null;
  let timerId = null;
  const height = Math.max(0, Math.ceil(Number(panel.getBoundingClientRect?.().height) || Number(panel.offsetHeight) || 0));

  layer.classList.add('is-closing');
  panel.classList.remove('is-dragging');
  panel.style.animation = 'none';

  const finish = () => {
    if (!active) return;
    active = false;
    onComplete();
  };

  if (reducedMotion) {
    finish();
    return () => {};
  }

  frameId = requestFrame(() => {
    if (!active) return;
    frameId = null;
    panel.style.transform = `translateY(${height}px)`;
    panel.style.opacity = '0';
    timerId = schedule(finish, SHEET_TRANSITION_MS);
  });

  return () => {
    if (!active) return;
    active = false;
    if (frameId !== null) cancelFrame(frameId);
    if (timerId !== null) cancelSchedule(timerId);
    layer.classList.remove('is-closing');
    panel.style.animation = '';
    panel.style.transform = '';
    panel.style.opacity = '';
  };
}
