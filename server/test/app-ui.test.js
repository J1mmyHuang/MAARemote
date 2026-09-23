import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appSource = () => fs.readFile(fileURLToPath(new URL('../../web/js/app.js', import.meta.url)), 'utf8');
const schedulerSource = () => fs.readFile(fileURLToPath(new URL('../src/scheduler.js', import.meta.url)), 'utf8');

test('快捷操作在途保持可点，并提供进行中确认与清除卡住状态', async () => {
  const source = await appSource();
  assert.match(source, /清除卡住状态/);
  assert.match(source, /kind: 'inflight'/);
  assert.match(source, /isActionDisabled\(action\.type\)/);
  assert.doesNotMatch(source, /isActionBusy\(action\.type\) \? 'disabled'/);
  assert.match(source, /renderStuckClearButtonHtml/);
  assert.match(source, /renderQuickActionWrapHtml/);
  assert.match(source, /renderInFlightSheetHtml/);
  assert.match(source, /canQueueAgainWhileInFlight/);
  assert.match(source, /shouldOfferInFlightConfirm/);
});

test('幽灵 pending 的快捷操作 HTML 含清除卡住状态且不 disabled', async () => {
  const { renderQuickActionWrapHtml } = await import('../../web/js/action-ui.js');
  const html = renderQuickActionWrapHtml({
    action: { type: 'LinkStart-AutoRoguelike', label: '自动肉鸽', detail: '执行已保存的肉鸽流程' },
    feedback: '结果待确认',
    pending: true,
    disabled: false,
    running: false,
    attr: (value) => String(value ?? ''),
    escapeHtml: (value) => String(value ?? ''),
  });
  assert.match(html, /data-action="clear-pending"/);
  assert.match(html, /清除卡住状态/);
  assert.match(html, /结果待确认/);
  assert.match(html, /is-pending/);
  assert.doesNotMatch(html, /\sdisabled/);
});

test('心跳仍占用时进行中面板禁用再下一单并要求先 Stop', async () => {
  const { renderInFlightSheetHtml } = await import('../../web/js/action-ui.js');
  const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  const observed = renderInFlightSheetHtml({
    type: 'LinkStart-AutoRoguelike',
    label: '自动肉鸽',
    pending: false,
    sending: false,
    queueAgainEnabled: false,
    stopDisabled: false,
    observedCurrent: true,
    attr: escapeHtml,
    escapeHtml,
  });
  assert.match(observed, /请先停止当前远程任务/);
  assert.match(observed, /请先 Stop，不要再下一单/);
  assert.match(observed, /data-action="queue-again"[^>]*\sdisabled/);
  assert.match(observed, /data-action="stop-current"/);
  assert.doesNotMatch(observed, /data-action="stop-current"[^>]*\sdisabled/);

  const idle = renderInFlightSheetHtml({
    type: 'LinkStart',
    label: '一键除草',
    pending: false,
    sending: false,
    queueAgainEnabled: true,
    stopDisabled: false,
    observedCurrent: false,
    attr: escapeHtml,
    escapeHtml,
  });
  assert.match(idle, /再下一单会排队等待/);
  assert.doesNotMatch(idle, /data-action="queue-again"[^>]*\sdisabled/);

  const xss = renderInFlightSheetHtml({
    type: 'LinkStart"><img>',
    label: '<b>除草</b>',
    pending: false,
    sending: false,
    queueAgainEnabled: true,
    stopDisabled: false,
    observedCurrent: false,
    attr: escapeHtml,
    escapeHtml,
  });
  assert.match(xss, /&lt;b&gt;除草&lt;\/b&gt;/);
  assert.match(xss, /data-type="LinkStart&quot;&gt;&lt;img&gt;"/);
  assert.doesNotMatch(xss, /<b>除草<\/b>/);
});

test('stale 回收 SQL 覆盖 dispatched 与 running，并说明心跳刷新锚点', async () => {
  const source = await schedulerSource();
  assert.match(source, /status IN \('dispatched', 'running'\)/);
  assert.match(source, /export function recycleStaleTasks/);
  assert.match(source, /COALESCE\(dispatched_at, created_at\)/);
  assert.match(source, /刷新 dispatched_at/);
});
