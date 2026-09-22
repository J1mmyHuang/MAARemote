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
