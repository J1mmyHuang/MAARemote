const DEFAULT_TIMEOUT_MS = 15_000;
const SSE_EVENT_TYPES = [
  'online',
  'offline',
  'task_started',
  'task_stale',
  'task_finished',
  'screenshot_saved',
  'device_approved',
];
const SSE_RECONNECT_DELAY_MS = 1000;
const SSE_MAX_BUFFER_CHARS = 1024 * 1024;
const SSE_MAX_EVENT_CHARS = 256 * 1024;

/** 将后端已定义的错误码转换为界面可直接呈现的中文反馈。 */
export function mapApiError(error = {}) {
  const status = Number(error.status);
  const code = error.error ?? error.code;

  if (status === 401 || code === 'unauthorized') return 'Token 无效或已过期，请重新设置';
  if (status === 429 || code === 'too_many_requests') return '操作过于频繁，稍后再试';
  if (code === 'device_not_found') return '未找到该设备，请重新选择设备';
  if (code === 'device_not_approved') return '该设备尚未批准，请先在设备管理中批准';
  if (code === 'screenshot_not_found') return '截图不存在或已被清理';
  if (code === 'screenshot_file_missing') return '截图文件已丢失，请重新截图';
  if (code === 'device_required') return '请选择要操作的设备';
  if (code === 'confirm_required') return '此操作需要确认后才能发送';
  if (code === 'params_required') return '请填写所需参数';
  if (code === 'invalid_params') return '参数格式无效';
  if (code === 'invalid_type') return '不支持此操作';
  if (code === 'already_in_flight') return '同类任务尚未结束，请先 Stop 或等待完成';
  if (code === 'bad_limit' || code === 'bad_id') return '请求参数无效';
  return '请求失败，请稍后再试';
}

export class ApiClientError extends Error {
  constructor(message, { status = 0, error = null, kind = 'api', cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ApiClientError';
    this.status = status;
    this.error = error;
    this.kind = kind;
  }
}

function normalizeOptions(tokenOrOptions, options) {
  if (typeof tokenOrOptions === 'object' && tokenOrOptions !== null) return { ...tokenOrOptions };
  return { ...options, token: tokenOrOptions ?? options.token ?? '' };
}

function attachAbortSignal(controller, signal) {
  if (!signal) return () => {};
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

async function parseResponseBody(response) {
  if (response.status === 204) return null;
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (text === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (typeof response.json === 'function') {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  return null;
}

function responseIsSuccessful(response) {
  return typeof response.ok === 'boolean'
    ? response.ok
    : response.status >= 200 && response.status < 300;
}

function createSseParser(dispatch) {
  const decoder = new TextDecoder();
  let buffer = '';
  let eventType = '';
  let dataLines = [];
  let eventChars = 0;

  const protocolError = () => new ApiClientError('实时事件数据超过缓存限制', { kind: 'protocol' });

  const resetEvent = () => {
    eventType = '';
    dataLines = [];
    eventChars = 0;
  };

  const processLine = (line) => {
    eventChars += line.length;
    if (eventChars > SSE_MAX_EVENT_CHARS) throw protocolError();

    if (line === '') {
      if (dataLines.length > 0) dispatch(dataLines.join('\n'), eventType || 'message');
      resetEvent();
      return;
    }
    if (line.startsWith(':')) return;

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') eventType = value;
    else if (field === 'data') dataLines.push(value);
  };

  const findLineEnd = (text, flush) => {
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === '\n') return { index, length: 1 };
      if (char === '\r') {
        if (index + 1 >= text.length && !flush) return null;
        return { index, length: text[index + 1] === '\n' ? 2 : 1 };
      }
    }
    return null;
  };

  const drain = (flush = false) => {
    while (true) {
      const lineEnd = findLineEnd(buffer, flush);
      if (!lineEnd) break;
      const line = buffer.slice(0, lineEnd.index);
      buffer = buffer.slice(lineEnd.index + lineEnd.length);
      processLine(line);
    }

    if (flush && buffer.length > 0) {
      const line = buffer;
      buffer = '';
      processLine(line);
    }
    if (buffer.length > SSE_MAX_BUFFER_CHARS || eventChars + buffer.length > SSE_MAX_EVENT_CHARS) {
      throw protocolError();
    }
  };

  const pushText = (text) => {
    if (!text) return;
    let offset = 0;
    while (offset < text.length) {
      const available = SSE_MAX_BUFFER_CHARS - buffer.length;
      if (available <= 0) throw protocolError();
      const end = Math.min(offset + available, text.length);
      buffer += text.slice(offset, end);
      offset = end;
      drain();
    }
  };

  return {
    push(chunk) {
      if (typeof chunk === 'string') pushText(chunk);
      else pushText(decoder.decode(chunk, { stream: true }));
    },
    finish() {
      pushText(decoder.decode());
      drain(true);
    },
  };
}

/** 同源仪表盘 API 客户端：请求统一走 Bearer，实际 URL 不携带长期 token。 */
export class ApiClient {
  constructor(tokenOrOptions = '', options = {}) {
    const normalized = normalizeOptions(tokenOrOptions, options);
    this.token = String(normalized.token ?? '');
    this.baseUrl = String(normalized.baseUrl ?? '').replace(/\/$/, '');
    const defaultFetch = globalThis.fetch;
    this.fetchImpl = normalized.fetchImpl ?? (
      typeof defaultFetch === 'function' ? defaultFetch.bind(globalThis) : defaultFetch
    );
    this.timeoutMs = normalized.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.reconnectDelayMs = Number.isFinite(normalized.reconnectDelayMs) && normalized.reconnectDelayMs >= 0
      ? normalized.reconnectDelayMs
      : SSE_RECONNECT_DELAY_MS;
  }

  setToken(token) {
    this.token = String(token ?? '');
  }

  url(path) {
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}${suffix}`;
  }

  async fetchRequest(path, {
    method = 'GET',
    body,
    headers = {},
    signal,
    timeoutMs = this.timeoutMs,
    accept = 'application/json',
    read = parseResponseBody,
  } = {}) {
    if (typeof this.fetchImpl !== 'function') {
      throw new ApiClientError('当前浏览器不支持网络请求', { kind: 'unsupported' });
    }

    const controller = new AbortController();
    const detachAbort = attachAbortSignal(controller, signal);
    let timedOut = false;
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
      : null;
    const requestHeaders = {
      Accept: accept,
      Authorization: `Bearer ${this.token}`,
      ...headers,
    };
    const encodedBody = body === undefined || body === null
      ? undefined
      : typeof body === 'string' ? body : JSON.stringify(body);
    if (encodedBody !== undefined && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'content-type')) {
      requestHeaders['Content-Type'] = 'application/json';
    }

    try {
      const response = await this.fetchImpl(this.url(path), {
        method,
        headers: requestHeaders,
        body: encodedBody,
        signal: controller.signal,
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      if (!responseIsSuccessful(response)) {
        const data = await parseResponseBody(response);
        const error = typeof data === 'object' && data !== null ? data.error : null;
        throw new ApiClientError(mapApiError({ status: response.status, error }), {
          status: response.status,
          error,
        });
      }
      return await read(response);
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      if (timedOut) {
        throw new ApiClientError('请求超时，请检查网络后重试', { kind: 'timeout', cause: error });
      }
      if (controller.signal.aborted) {
        throw new ApiClientError('请求已取消', { kind: 'aborted', cause: error });
      }
      throw new ApiClientError('网络连接失败，请检查服务是否启动', { kind: 'network', cause: error });
    } finally {
      if (timer !== null) clearTimeout(timer);
      detachAbort();
    }
  }

  async request(path, { method = 'GET', body, headers = {}, signal, timeoutMs = this.timeoutMs } = {}) {
    return this.fetchRequest(path, {
      method,
      body,
      headers,
      signal,
      timeoutMs,
      accept: 'application/json',
      read: parseResponseBody,
    });
  }

  getOverview(options) { return this.request('/api/overview', options); }
  getTasks(limit = 50, options) { return this.request(`/api/tasks?limit=${encodeURIComponent(limit)}`, options); }
  sendTask(task, options) { return this.request('/api/tasks', { ...options, method: 'POST', body: task }); }
  getScreenshots(limit = 50, options) { return this.request(`/api/screenshots?limit=${encodeURIComponent(limit)}`, options); }
  getPendingDevices(options) { return this.request('/api/devices/pending', options); }
  approveDevice(id, options) { return this.request(`/api/devices/${encodeURIComponent(id)}/approve`, { ...options, method: 'POST' }); }
  getPushVapidPublicKey(options) { return this.request('/api/push/vapid-public-key', options); }
  savePushSubscription(subscription, options) {
    return this.request('/api/push/subscriptions', { ...options, method: 'POST', body: subscription });
  }
  deletePushSubscription(endpoint, options) {
    return this.request('/api/push/subscriptions', { ...options, method: 'DELETE', body: { endpoint } });
  }

  getScreenshotBlob(id, options = {}) {
    return this.fetchRequest(`/api/screenshots/${encodeURIComponent(id)}`, {
      ...options,
      method: 'GET',
      body: undefined,
      accept: 'image/png',
      read: (response) => {
        if (typeof response.blob !== 'function') {
          throw new ApiClientError('当前浏览器不支持读取截图', { kind: 'unsupported' });
        }
        return response.blob();
      },
    });
  }

  openEvents({
    onEvent,
    onError,
    onOpen,
    eventTypes = SSE_EVENT_TYPES,
    signal,
    reconnectDelayMs = this.reconnectDelayMs,
  } = {}) {
    if (typeof this.fetchImpl !== 'function') {
      throw new ApiClientError('当前浏览器不支持实时事件', { kind: 'unsupported' });
    }
    const allowedEventTypes = new Set(eventTypes ?? SSE_EVENT_TYPES);
    const reconnectDelay = Number.isFinite(reconnectDelayMs) && reconnectDelayMs >= 0
      ? reconnectDelayMs
      : this.reconnectDelayMs;
    let closed = false;
    let stopped = false;
    let reconnectTimer = null;
    let activeController = null;
    let activeReader = null;
    let removeExternalAbort = () => {};

    const notifyError = (error) => {
      if (closed || typeof onError !== 'function') return;
      try {
        onError(error);
      } catch {
        // 回调异常不得破坏连接清理与重连状态机。
      }
    };

    const close = () => {
      if (closed) return;
      closed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      removeExternalAbort();
      removeExternalAbort = () => {};
      const controller = activeController;
      activeController = null;
      controller?.abort();
      const reader = activeReader;
      activeReader = null;
      if (reader && typeof reader.cancel === 'function') {
        Promise.resolve(reader.cancel()).catch(() => {});
      }
    };

    const scheduleReconnect = () => {
      if (closed || stopped || reconnectTimer !== null) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, reconnectDelay);
    };

    const handleFailure = (error) => {
      if (closed || stopped) return;
      notifyError(error);
      scheduleReconnect();
    };

    const connect = async () => {
      if (closed || stopped) return;
      const controller = new AbortController();
      activeController = controller;
      let reader = null;
      try {
        const response = await this.fetchImpl(this.url('/api/events'), {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${this.token}`,
          },
          signal: controller.signal,
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        });
        if (closed || controller.signal.aborted) return;

        if (!responseIsSuccessful(response)) {
          const data = await parseResponseBody(response);
          const error = new ApiClientError(mapApiError({
            status: response.status,
            error: typeof data === 'object' && data !== null ? data.error : null,
          }), {
            status: response.status,
            error: typeof data === 'object' && data !== null ? data.error : null,
          });
          if (response.status === 401) {
            stopped = true;
            notifyError(error);
          } else {
            handleFailure(error);
          }
          return;
        }
        if (!response.body || typeof response.body.getReader !== 'function') {
          throw new ApiClientError('实时事件响应不支持流式读取', { kind: 'network' });
        }

        onOpen?.();
        if (closed || controller.signal.aborted) return;
        reader = response.body.getReader();
        activeReader = reader;
        const parser = createSseParser((data, type) => {
          if (closed || controller.signal.aborted) return;
          if (!allowedEventTypes.has(type)) return;
          let payload;
          try {
            payload = JSON.parse(data);
          } catch {
            return;
          }
          if (closed || controller.signal.aborted) return;
          onEvent?.(payload, type);
        });

        while (!closed && !controller.signal.aborted) {
          const result = await reader.read();
          if (result.done) {
            parser.finish();
            break;
          }
          parser.push(result.value);
        }
        if (!closed && !stopped) {
          handleFailure(new ApiClientError('实时事件连接已断开', { kind: 'network' }));
        }
      } catch (error) {
        if (closed || controller.signal.aborted) return;
        if (reader && typeof reader.cancel === 'function') {
          try {
            await reader.cancel();
          } catch {
            // 忽略已失败流的取消错误，继续走统一重连路径。
          }
        }
        const normalized = error instanceof ApiClientError
          ? error
          : new ApiClientError('实时事件连接失败，请检查服务是否启动', { kind: 'network', cause: error });
        if (normalized.status === 401) {
          stopped = true;
          notifyError(normalized);
        } else {
          handleFailure(normalized);
        }
      } finally {
        if (activeReader === reader) activeReader = null;
        if (activeController === controller) activeController = null;
      }
    };

    if (signal) {
      const abort = () => close();
      if (signal.aborted) close();
      else {
        signal.addEventListener('abort', abort, { once: true });
        removeExternalAbort = () => signal.removeEventListener('abort', abort);
      }
    }
    connect();
    return { close };
  }
}

export { DEFAULT_TIMEOUT_MS, SSE_EVENT_TYPES };
