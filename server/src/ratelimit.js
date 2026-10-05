// SPDX-License-Identifier: MPL-2.0
// 进程内滑动窗口限流器（安全修复轮 Mr-sec1 低2，自实现零依赖，禁止新增 npm 依赖）。
//
// 设计：
//   - 只统计「失败流量」：调用方仅在鉴权失败（403/401）路径上调用 hit()，成功流量完全不进入
//     限流器，因此 MAA 正常 1s 轮询与合法仪表盘请求不受任何影响。
//   - 滑动窗口：每 key（来源 IP）维护命中时间戳数组，hit() 时先剔除窗口外旧时间戳再追加，
//     返回是否超限（数组长度 > max）。连续失败会持续占位，停止失败并静默一个窗口后自动恢复。
//   - 内存防膨胀：定期清理定时器删除空/全过期 key；清理定时器 unref，不阻止进程退出。
//
// 限流阈值常量分散在使用方文件顶部（getTask/reportStatus 403 见 routes/maa.js、/api 401 见 routes/api.js，
// 同 M2/M3 协程常量惯例，不添加 config 字段）。

// 清理周期默认与一个窗口对齐（60s），调用方无需感知
const CLEANUP_INTERVAL_MS = 60000;

/**
 * 创建滑动窗口限流器。
 * @param {object} opts
 * @param {number} opts.windowMs 窗口长度（毫秒）
 * @param {number} opts.max      窗口内允许的最大失败次数，第 max+1 次起超限
 * @param {number} [opts.cleanupMs] 清理定时器周期（默认 60s）
 * @returns {{ hit: (key: string, now?: number) => boolean }}
 *   hit(key, now)：记录一次失败并返回是否超限（true = 已超限，应回 429）。
 */
export function createSlidingWindowLimiter({ windowMs, max, cleanupMs = CLEANUP_INTERVAL_MS }) {
  if (!Number.isFinite(windowMs) || windowMs <= 0 || !Number.isFinite(max) || max <= 0) {
    throw new Error('createSlidingWindowLimiter：windowMs 与 max 必须为正数');
  }
  /** Map<key, 时间戳数组（升序）> */
  const hits = new Map();

  // 周期清理：删除空/全过期的 key，防止长期运行下 Map 无限膨胀。
  // 静默失败（清理只是内存卫生，不参与业务正确性）。
  const cleanupTimer = setInterval(() => {
    try {
      const now = Date.now();
      for (const [key, arr] of hits) {
        let i = 0;
        while (i < arr.length && arr[i] <= now - windowMs) i++;
        if (i >= arr.length) hits.delete(key);
        else if (i > 0) hits.set(key, arr.slice(i));
      }
    } catch {
      // 忽略：下一周期重试
    }
  }, cleanupMs);
  cleanupTimer.unref?.(); // 不阻止进程优雅退出

  return {
    hit(key, now = Date.now()) {
      let arr = hits.get(key);
      if (!arr) {
        arr = [];
        hits.set(key, arr);
      }
      const cutoff = now - windowMs;
      // 原地剔除窗口外旧时间戳
      let i = 0;
      while (i < arr.length && arr[i] <= cutoff) i++;
      if (i > 0) arr.splice(0, i);
      arr.push(now);
      return arr.length > max;
    },
  };
}
