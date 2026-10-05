// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import test from 'node:test';

async function loadTheme(t) {
  try {
    return await import('../../web/js/theme.js');
  } catch (error) {
    t.assert.fail(`缺少计划中的 web/js/theme.js：${error.message}`);
  }
}

test('主题偏好只接受 system/light/dark，并按系统状态解析实际主题', async (t) => {
  const { normalizeThemePreference, resolveTheme } = await loadTheme(t);

  assert.equal(normalizeThemePreference('light'), 'light');
  assert.equal(normalizeThemePreference('dark'), 'dark');
  assert.equal(normalizeThemePreference('unknown'), 'system');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
});

test('主题读取和写入能容错 localStorage 不可用的环境', async (t) => {
  const { readThemePreference, writeThemePreference } = await loadTheme(t);
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };

  assert.equal(readThemePreference(storage), 'system');
  assert.equal(writeThemePreference(storage, 'dark'), 'dark');
  assert.equal(readThemePreference(storage), 'dark');
  assert.equal(readThemePreference({ getItem() { throw new Error('blocked'); } }), 'system');
});
