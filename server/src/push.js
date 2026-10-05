// P4b Web Push：VAPID、RFC 8291 aes128gcm、订阅存储与 task_finished 投递。
// 只使用 Node 内置模块；推送失败不会改变 MAA 任务状态，也不会阻塞主请求。
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const PUSH_TTL_SEC = 300;
export const PUSH_RETRY_LIMIT = 2;
export const PUSH_RETRY_BASE_MS = 150;
export const PUSH_TIMEOUT_MS = 8_000;
export const PUSH_MAX_SUBSCRIPTIONS = 16;
export const PUSH_MAX_SENT_EVENTS = 200;
export const PUSH_RECORD_SIZE = 4096;

const TASK_LABELS = new Map([
  ['LinkStart-WakeUp', '开始唤醒'],
  ['LinkStart-Recruiting', '自动公招'],
  ['LinkStart-Base', '基建换班'],
  ['LinkStart-Combat', '理智作战'],
  ['LinkStart-Mall', '信用收支'],
  ['LinkStart-Mission', '领取奖励'],
  ['LinkStart-AutoRoguelike', '自动肉鸽'],
  ['LinkStart-Reclamation', '生息演算'],
  ['LinkStart', '一键除草'],
  ['StopTask', '停止任务'],
  ['CaptureImageNow', '立即截图'],
  ['Toolbox-GachaOnce', '工具箱单抽'],
  ['Toolbox-GachaTenTimes', '工具箱十连'],
  ['Settings-ConnectAddress', '连接地址'],
  ['Settings-Stage1', '第一关卡'],
]);

const EMPTY_LOGGER = { info() {}, warn() {}, error() {} };

function loggerMethod(logger, method, ...args) {
  try {
    logger?.[method]?.(...args);
  } catch {
    // 日志失败不能影响推送或 MAA 主流程。
  }
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeBase64url(value, name) {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError(`${name} 必须是无填充 base64url`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length === 0 || decoded.toString('base64url') !== value) {
    throw new TypeError(`${name} 不是有效 base64url`);
  }
  return decoded;
}

function keyFromJwk(key) {
  if (key && typeof key === 'object' && key.type) return key;
  return crypto.createPrivateKey({ key, format: 'jwk' });
}

function publicKeyFromJwk(key) {
  if (key && typeof key === 'object' && key.type) return key;
  return crypto.createPublicKey({ key, format: 'jwk' });
}

function jwkPublicFromKey(key) {
  return publicKeyFromJwk(key).export({ format: 'jwk' });
}

export function publicKeyToUncompressed(publicKey) {
  const jwk = publicKey?.x && publicKey?.y ? publicKey : jwkPublicFromKey(publicKey);
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new TypeError('VAPID 公钥必须是 P-256 JWK');
  }
  const x = decodeBase64url(jwk.x, 'publicKey.x');
  const y = decodeBase64url(jwk.y, 'publicKey.y');
  if (x.length !== 32 || y.length !== 32) throw new TypeError('P-256 公钥坐标长度错误');
  return Buffer.concat([Buffer.from([4]), x, y]);
}

function privateScalarFromKey(key) {
  if (Buffer.isBuffer(key) || key instanceof Uint8Array) return Buffer.from(key);
  const jwk = key?.d ? key : keyFromJwk(key).export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string') {
    throw new TypeError('私钥必须是 P-256 JWK');
  }
  const d = decodeBase64url(jwk.d, 'privateKey.d');
  if (d.length !== 32) throw new TypeError('P-256 私钥长度错误');
  return d;
}

function generateVapidKeys() {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey: pair.privateKey.export({ format: 'jwk' }),
    publicKey: pair.publicKey.export({ format: 'jwk' }),
  };
}

function validVapidKeys(value) {
  try {
    if (!value || !value.privateKey || !value.publicKey) return false;
    const privateKey = keyFromJwk(value.privateKey);
    const publicKey = publicKeyFromJwk(value.publicKey);
    const publicJwk = publicKey.export({ format: 'jwk' });
    const privatePublic = publicKeyToUncompressed(privateKey);
    const storedPublic = publicKeyToUncompressed(value.publicKey);
    return privateKey.asymmetricKeyType === 'ec'
      && publicKey.asymmetricKeyType === 'ec'
      && publicJwk.crv === 'P-256'
      && privatePublic.length === 65
      && storedPublic.length === 65
      && crypto.timingSafeEqual(privatePublic, storedPublic);
  } catch {
    return false;
  }
}

function makeEmptyStore() {
  return { version: 1, vapid: generateVapidKeys(), subscriptions: {} };
}

function fileOwnerHardening(filePath, logger) {
  if (process.platform !== 'win32') return;
  const owner = process.env.USERNAME || process.env.USER;
  if (!owner) return;
  try {
    const result = spawnSync(
      'icacls',
      [filePath, '/inheritance:r', '/grant:r', `${owner}:(F)`],
      { windowsHide: true, stdio: 'ignore' },
    );
    if (!result || result.status !== 0) throw new Error('icacls 返回非零');
  } catch {
    loggerMethod(logger, 'warn', '推送存储文件权限收紧失败，继续使用当前文件权限');
  }
}

function writeStoreAtomic(filePath, store, logger) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    fileOwnerHardening(filePath, logger);
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* 临时文件清理失败不覆盖主结果。 */ }
  }
}

function validateEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2048) {
    throw new TypeError('endpoint 必须是非空 HTTPS 地址');
  }
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw new TypeError('endpoint 不是有效 URL'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
    throw new TypeError('endpoint 必须是 HTTPS 地址');
  }
  return endpoint;
}

export function validateSubscription(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('订阅必须是对象');
  const endpoint = validateEndpoint(input.endpoint);
  if (!input.keys || typeof input.keys !== 'object' || Array.isArray(input.keys)) throw new TypeError('keys 缺失');
  const p256dh = decodeBase64url(input.keys.p256dh, 'p256dh');
  const auth = decodeBase64url(input.keys.auth, 'auth');
  if (p256dh.length !== 65 || p256dh[0] !== 4) throw new TypeError('p256dh 必须是 65 字节 P-256 公钥');
  if (auth.length !== 16) throw new TypeError('auth 必须是 16 字节');
  try {
    const spkiPrefix = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
    crypto.createPublicKey({ key: Buffer.concat([spkiPrefix, p256dh]), format: 'der', type: 'spki' });
  } catch {
    throw new TypeError('p256dh 不是有效的 P-256 公钥');
  }
  return { endpoint, keys: { p256dh: p256dh.toString('base64url'), auth: auth.toString('base64url') } };
}

function subscriptionFingerprint(subscription) {
  return crypto.createHash('sha256')
    .update(subscription.endpoint)
    .update('\0')
    .update(subscription.keys.p256dh)
    .update('\0')
    .update(subscription.keys.auth)
    .digest('hex');
}

function readStore(filePath, logger) {
  if (!fs.existsSync(filePath)) {
    const store = makeEmptyStore();
    writeStoreAtomic(filePath, store, logger);
    return store;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (raw?.version !== 1 || !validVapidKeys(raw.vapid) || !raw.subscriptions || typeof raw.subscriptions !== 'object') {
      throw new Error('push.json 结构无效');
    }
    const store = { version: 1, vapid: raw.vapid, subscriptions: {} };
    for (const [fingerprint, value] of Object.entries(raw.subscriptions)) {
      try {
        const subscription = validateSubscription(value);
        const actual = subscriptionFingerprint(subscription);
        if (actual !== fingerprint) continue;
        store.subscriptions[fingerprint] = {
          ...subscription,
          createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
          sent: Array.isArray(value.sent) ? value.sent.map(String).slice(-PUSH_MAX_SENT_EVENTS) : [],
        };
      } catch {
        // 损坏的单条订阅只丢弃该条，不能阻止其他订阅工作。
      }
    }
    return store;
  } catch {
    loggerMethod(logger, 'warn', '推送存储损坏，已安全重建；旧订阅作废且 VAPID 密钥已更新');
    const store = makeEmptyStore();
    writeStoreAtomic(filePath, store, logger);
    return store;
  }
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '';
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
}

export function taskLabel(type) {
  return TASK_LABELS.get(type) ?? String(type || '未知任务');
}

export function buildNotificationPayload(event) {
  if (!event || event.kind !== 'task_finished') return null;
  let detail;
  try { detail = typeof event.detail === 'string' ? JSON.parse(event.detail) : event.detail; } catch { return null; }
  if (!detail || (detail.status !== 'success' && detail.status !== 'failed')) return null;
  if (event.id === undefined || event.id === null || typeof detail.task_id !== 'string' || detail.task_id.length === 0) return null;
  const result = detail.status === 'success' ? '成功' : '失败';
  const duration = formatDuration(detail.duration_ms);
  return {
    event_id: String(event.id),
    task_id: detail.task_id,
    title: `${taskLabel(detail.type)}：${result}`,
    body: `耗时 ${duration || '未知'}`,
    url: '/',
  };
}

function hkdfExpand(prk, info, length) {
  const output = [];
  let previous = Buffer.alloc(0);
  for (let counter = 1; Buffer.concat(output).length < length; counter += 1) {
    previous = crypto.createHmac('sha256', prk).update(previous).update(info).update(Buffer.from([counter])).digest();
    output.push(previous);
  }
  return Buffer.concat(output).subarray(0, length);
}

function deriveContentKeys(ecdhSecret, authSecret, salt, uaPublic, asPublic) {
  const prkKey = crypto.createHmac('sha256', authSecret).update(ecdhSecret).digest();
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'ascii'), uaPublic, asPublic]);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0', 'ascii'), 12);
  return { cek, nonce };
}

function senderEcdh(options) {
  const ecdh = crypto.createECDH('prime256v1');
  if (options?.senderPrivateKey) ecdh.setPrivateKey(privateScalarFromKey(options.senderPrivateKey));
  else ecdh.generateKeys();
  return ecdh;
}

export function encryptWebPushPayload(payload, subscription, options = {}) {
  const normalized = validateSubscription(subscription);
  const uaPublic = decodeBase64url(normalized.keys.p256dh, 'p256dh');
  const authSecret = options.authSecret ? Buffer.from(options.authSecret) : decodeBase64url(normalized.keys.auth, 'auth');
  if (authSecret.length !== 16) throw new TypeError('auth secret 必须是 16 字节');
  const salt = options.salt ? Buffer.from(options.salt) : crypto.randomBytes(16);
  if (salt.length !== 16) throw new TypeError('salt 必须是 16 字节');
  const ecdh = senderEcdh(options);
  const asPublic = ecdh.getPublicKey(undefined, 'uncompressed');
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const { cek, nonce } = deriveContentKeys(ecdhSecret, authSecret, salt, uaPublic, asPublic);
  const plaintext = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const padded = Buffer.concat([plaintext, Buffer.from([2])]);
  if (padded.length + 16 >= PUSH_RECORD_SIZE) throw new RangeError('推送载荷过大');
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(16 + 4 + 1 + 65);
  salt.copy(header, 0);
  header.writeUInt32BE(PUSH_RECORD_SIZE, 16);
  header[20] = 65;
  asPublic.copy(header, 21);
  return { body: Buffer.concat([header, ciphertext]), salt, serverPublicKey: asPublic, recordSize: PUSH_RECORD_SIZE };
}

export function decryptWebPushPayload(body, receiverPrivateKey, authSecretInput) {
  const bytes = Buffer.from(body);
  if (bytes.length < 86 + 17 || bytes[20] !== 65) throw new Error('aes128gcm 记录头无效');
  const salt = bytes.subarray(0, 16);
  const senderPublic = bytes.subarray(21, 86);
  const ciphertext = bytes.subarray(86);
  const receiver = crypto.createECDH('prime256v1');
  receiver.setPrivateKey(privateScalarFromKey(receiverPrivateKey));
  const uaPublic = receiver.getPublicKey(undefined, 'uncompressed');
  const authSecret = Buffer.isBuffer(authSecretInput) ? authSecretInput : decodeBase64url(authSecretInput, 'auth');
  if (authSecret.length !== 16) throw new TypeError('auth secret 必须是 16 字节');
  const { cek, nonce } = deriveContentKeys(receiver.computeSecret(senderPublic), authSecret, salt, uaPublic, senderPublic);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  if (padded[padded.length - 1] !== 2) throw new Error('aes128gcm padding delimiter 无效');
  return padded.subarray(0, -1);
}

export function buildVapidJwt(endpoint, keys, options = {}) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') throw new TypeError('VAPID endpoint 必须是 HTTPS');
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const exp = nowSeconds + 12 * 60 * 60;
  const header = { typ: 'JWT', alg: 'ES256' };
  const body = { aud: url.origin, exp };
  if (options.subject !== undefined) {
    if (typeof options.subject !== 'string' || !/^(mailto:|https:)/.test(options.subject)) throw new TypeError('VAPID sub 必须是 mailto 或 https URI');
    body.sub = options.subject;
  }
  const encodedHeader = encodeJson(header);
  const encodedBody = encodeJson(body);
  const signingInput = `${encodedHeader}.${encodedBody}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'ascii'), {
    key: keyFromJwk(keys.privateKey),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return { token: `${signingInput}.${signature}`, publicKey: publicKeyToUncompressed(keys.publicKey).toString('base64url'), exp };
}

export function verifyVapidJwt(token, publicKey) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const signature = decodeBase64url(parts[2], 'signature');
    if (signature.length !== 64) return false;
    return crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), {
      key: publicKeyFromJwk(publicKey),
      dsaEncoding: 'ieee-p1363',
    }, signature);
  } catch {
    return false;
  }
}

function defaultSendRequest({ endpoint, body, headers, timeoutMs = PUSH_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const request = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers,
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => {
        if (Buffer.concat(chunks).length < 4096) chunks.push(Buffer.from(chunk));
      });
      response.once('end', () => resolve({
        status: Number(response.statusCode ?? 0),
        body: Buffer.concat(chunks).toString('utf8').slice(0, 4096),
      }));
    });
    request.once('timeout', () => request.destroy(new Error('推送请求超时')));
    request.once('error', reject);
    request.end(body);
  });
}

function endpointHost(endpoint) {
  try { return new URL(endpoint).host; } catch { return 'invalid-host'; }
}

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createPushService(options = {}) {
  const storagePath = options.storagePath ?? path.join(DATA_DIR, 'push.json');
  const logger = options.logger ?? EMPTY_LOGGER;
  const sleep = options.sleep ?? sleepDefault;
  const sendRequest = options.sendRequest ?? defaultSendRequest;
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? PUSH_TIMEOUT_MS;
  let store = readStore(storagePath, logger);
  let closed = false;
  let queue = Promise.resolve();

  const save = () => writeStoreAtomic(storagePath, store, logger);
  const publicKey = () => publicKeyToUncompressed(store.vapid.publicKey).toString('base64url');

  function listSubscriptions() {
    return Object.values(store.subscriptions).map((item) => ({
      endpoint: item.endpoint,
      keys: { ...item.keys },
      fingerprint: subscriptionFingerprint(item),
    }));
  }

  async function addSubscription(input) {
    const subscription = validateSubscription(input);
    const fingerprint = subscriptionFingerprint(subscription);
    if (!store.subscriptions[fingerprint] && Object.keys(store.subscriptions).length >= PUSH_MAX_SUBSCRIPTIONS) {
      throw new Error('推送订阅数量已达上限');
    }
    const old = store.subscriptions[fingerprint];
    store.subscriptions[fingerprint] = {
      ...subscription,
      createdAt: old?.createdAt ?? now(),
      sent: old?.sent ?? [],
    };
    save();
    return { ok: true, fingerprint: fingerprint.slice(0, 12) };
  }

  async function removeSubscription(input) {
    const endpoint = typeof input === 'string' ? input : input?.endpoint;
    validateEndpoint(endpoint);
    let removed = false;
    for (const [fingerprint, subscription] of Object.entries(store.subscriptions)) {
      if (subscription.endpoint === endpoint) {
        delete store.subscriptions[fingerprint];
        removed = true;
      }
    }
    if (removed) save();
    return { ok: true, removed };
  }

  async function sendOne(subscription, eventId, payload) {
    const encrypted = encryptWebPushPayload(JSON.stringify(payload), subscription);
    const vapid = buildVapidJwt(subscription.endpoint, store.vapid, { now: now() });
    const headers = {
      'content-type': 'application/octet-stream',
      'content-encoding': 'aes128gcm',
      'content-length': String(encrypted.body.length),
      ttl: String(PUSH_TTL_SEC),
      urgency: 'normal',
      topic: `maaremote-${String(eventId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20)}`,
      authorization: `vapid t=${vapid.token}, k=${vapid.publicKey}`,
      'crypto-key': `p256ecdsa=${vapid.publicKey}`,
    };
    const request = { endpoint: subscription.endpoint, body: encrypted.body, headers, payload, timeoutMs };
    for (let attempt = 0; attempt <= PUSH_RETRY_LIMIT; attempt += 1) {
      let response;
      try {
        response = await sendRequest(request);
      } catch (error) {
        loggerMethod(logger, 'warn', { host: endpointHost(subscription.endpoint), fingerprint: subscriptionFingerprint(subscription).slice(0, 12) }, 'Web Push 请求失败');
        return { accepted: false, retryable: false, error };
      }
      const status = Number(response?.status ?? 0);
      if (status >= 200 && status < 300) return { accepted: true };
      if (status === 404 || status === 410) return { gone: true };
      if ((status === 429 || status >= 500) && attempt < PUSH_RETRY_LIMIT) {
        await sleep(PUSH_RETRY_BASE_MS * (attempt + 1));
        continue;
      }
      loggerMethod(logger, 'warn', { host: endpointHost(subscription.endpoint), fingerprint: subscriptionFingerprint(subscription).slice(0, 12), status }, 'Web Push 被推送服务拒绝');
      return { accepted: false, status };
    }
    return { accepted: false };
  }

  async function handleEvent(event) {
    if (closed) return { ignored: true, reason: 'closed' };
    const payload = buildNotificationPayload(event);
    if (!payload) return { ignored: true, reason: 'not_task_finished' };
    const run = async () => {
      const eventId = String(payload.event_id);
      for (const [fingerprint, subscription] of Object.entries({ ...store.subscriptions })) {
        if (subscription.sent?.includes(eventId)) continue;
        const result = await sendOne(subscription, eventId, payload);
        if (result.gone) {
          delete store.subscriptions[fingerprint];
          save();
          continue;
        }
        if (result.accepted) {
          const current = store.subscriptions[fingerprint];
          if (!current) continue;
          current.sent = [...(current.sent ?? []).filter((id) => id !== eventId), eventId].slice(-PUSH_MAX_SENT_EVENTS);
          save();
        }
      }
      return { sent: true };
    };
    queue = queue.then(run, run);
    return queue;
  }

  async function close() {
    closed = true;
    await queue;
  }

  return {
    addSubscription,
    removeSubscription,
    listSubscriptions,
    getVapidPublicKey: publicKey,
    handleEvent,
    close,
    storagePath,
  };
}
