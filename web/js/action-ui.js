// SPDX-License-Identifier: AGPL-3.0-or-later
// 快捷操作与卡住状态的纯 HTML 片段（无 DOM），供 app.js 与单测共用。

export function renderStuckClearButtonHtml(type, { id, attr } = {}) {
  if (!type || typeof attr !== 'function') return '';
  const idAttr = id ? ` data-id="${attr(id)}"` : '';
  return `<button class="text-button" type="button" data-action="clear-pending" data-type="${attr(type)}"${idAttr} data-focus-id="clear-pending-${attr(id || type)}">清除卡住状态</button>`;
}

export function renderQuickActionWrapHtml({
  action,
  feedback,
  pending,
  disabled,
  running,
  attr,
  escapeHtml,
}) {
  const classNames = ['quick-action'];
  if (running) classNames.push('is-running');
  if (pending) classNames.push('is-pending');
  const stateText = feedback || action.detail;
  const ariaLabel = feedback ? `${action.label}，${feedback}` : action.label;
  return `
      <div class="quick-action-wrap">
        <button class="${classNames.join(' ')}" type="button" data-action="run-quick" data-type="${attr(action.type)}" data-focus-id="quick-${attr(action.type)}" aria-label="${attr(ariaLabel)}" ${disabled ? 'disabled' : ''}>
          <span class="quick-action-title">${escapeHtml(action.label)}</span>
          <span class="quick-action-state">${escapeHtml(stateText)}</span>
        </button>
        ${pending ? renderStuckClearButtonHtml(action.type, { attr }) : ''}
      </div>
    `;
}

export function renderInFlightSheetHtml({
  type,
  label,
  pending,
  sending,
  queueAgainEnabled,
  stopDisabled,
  observedCurrent,
  realInFlight,
  attr,
  escapeHtml,
  stuckClearButtonHtml = '',
}) {
  const stopFirst = observedCurrent || realInFlight || !queueAgainEnabled;
  const caption = observedCurrent
    ? '请先停止当前远程任务'
    : stopFirst
      ? '请先 Stop 或等待结束'
      : '上次结果待确认';
  const copy = observedCurrent
    ? `${label}仍在进行，心跳还观测到设备占用。请先 Stop，不要再下一单。`
    : stopFirst
      ? `${label}仍在进行。请先 Stop，或等当前任务结束，不要再下一单。`
      : `${label}上次结果待确认。确认尚未入队后可以再下一单；已在途则请先 Stop。`;
  const queueDisabled = sending || !queueAgainEnabled;
  return `
    <div class="sheet-heading"><div><h2 class="sheet-title">任务进行中</h2><p class="sheet-caption">${escapeHtml(caption)}</p></div></div>
    <p class="sheet-copy">${escapeHtml(copy)}</p>
    <p class="sheet-note">停止命令回报后仍需等待心跳确认空闲；队列中后续任务可能继续执行。</p>
    ${pending ? `<p class="feedback-line feedback-pending"><span>结果待确认</span>${stuckClearButtonHtml}</p>` : ''}
    <div class="sheet-actions">
      <button class="secondary-button" type="button" data-action="queue-again" data-type="${attr(type)}" ${queueDisabled ? 'disabled' : ''}>再下一单</button>
      <button class="danger-button" type="button" data-action="stop-current" ${stopDisabled ? 'disabled' : ''}>先 Stop</button>
    </div>
    <div class="sheet-actions single"><button class="secondary-button" type="button" data-action="close-sheet">取消</button></div>
  `;
}
