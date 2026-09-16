import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Fastify from 'fastify';

const fixtureRoot = fileURLToPath(new URL('../../test-results/static/', import.meta.url));

async function loadStaticWeb(t) {
  try {
    return (await import('../src/static-web.js')).default;
  } catch (error) {
    t.assert.fail(`缺少计划中的 server/src/static-web.js：${error.message}`);
  }
}

async function buildApp(t) {
  const staticWeb = await loadStaticWeb(t);
  await fs.mkdir(fixtureRoot, { recursive: true });
  const webRoot = await fs.mkdtemp(path.join(fixtureRoot, 'web-'));
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>MAARemote</title>');
  await fs.writeFile(path.join(webRoot, 'app.js'), 'export const ready = true;');
  await fs.writeFile(path.join(webRoot, 'app.css'), 'body { color: black; }');
  const app = Fastify();
  await app.register(staticWeb, { webRoot });
  t.after(async () => {
    await app.close();
    await fs.rm(webRoot, { recursive: true, force: true });
  });
  return app;
}

test('静态插件将根路径与 SPA 路径返回 index.html', async (t) => {
  const app = await buildApp(t);

  const root = await app.inject({ method: 'GET', url: '/' });
  const spa = await app.inject({ method: 'GET', url: '/tasks/detail' });
  assert.equal(root.statusCode, 200);
  assert.match(root.headers['content-type'], /^text\/html/);
  assert.equal(root.body, '<!doctype html><title>MAARemote</title>');
  assert.equal(spa.statusCode, 200);
  assert.equal(spa.body, root.body);
});

test('静态插件为 JavaScript 与 CSS 返回正确 MIME 类型', async (t) => {
  const app = await buildApp(t);

  const js = await app.inject({ method: 'GET', url: '/app.js' });
  const css = await app.inject({ method: 'GET', url: '/app.css' });
  assert.equal(js.statusCode, 200);
  assert.match(js.headers['content-type'], /^application\/javascript/);
  assert.equal(css.statusCode, 200);
  assert.match(css.headers['content-type'], /^text\/css/);
});

test('静态插件不会以 SPA fallback 截获 API 或 MAA 路径', async (t) => {
  const app = await buildApp(t);

  const api = await app.inject({ method: 'GET', url: '/api/overview' });
  const maa = await app.inject({ method: 'POST', url: '/maa/getTask' });
  assert.equal(api.statusCode, 404);
  assert.equal(maa.statusCode, 404);
});

test('静态插件拒绝编码路径穿越且不泄露根目录外文件', async (t) => {
  const app = await buildApp(t);
  const secretPath = path.join(fixtureRoot, 'maaremote-static-secret.txt');
  await fs.writeFile(secretPath, 'must-not-leak');
  t.after(() => fs.rm(secretPath, { force: true }));

  // light-my-request 会在进入 Fastify 路由前规范化单层 %2e%2e；双重编码才能覆盖插件的拒绝分支。
  const response = await app.inject({ method: 'GET', url: '/%252e%252e/maaremote-static-secret.txt' });
  assert.ok([400, 403, 404].includes(response.statusCode));
  assert.doesNotMatch(response.body, /must-not-leak/);
});
