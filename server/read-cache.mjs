import { AsyncLocalStorage } from 'node:async_hooks';

/** 只为前台GET共享短期快照；默认路径始终回源，写入和GC不会命中缓存。 */
export class ReadCache {
  constructor({ ttl = 10000, limit = 128, maxBytes = 8 * 1024 ** 2, now = Date.now } = {}) {
    Object.assign(this, { ttl, limit, maxBytes, now, epoch: 0, bytes: 0 });
    this.scope = new AsyncLocalStorage(); this.values = new Map(); this.pending = new Map();
  }
  run(work, fresh = false) { if (fresh) this.invalidate(); return this.scope.run(true, work); }
  invalidate() { this.epoch++; this.values.clear(); this.pending.clear(); this.bytes = 0; }
  async get(key, load) {
    if (!this.scope.getStore()) return load();
    const cached = this.values.get(key);
    if (cached && cached.until > this.now()) return structuredClone(cached.value);
    if (cached) { this.bytes -= cached.bytes; this.values.delete(key); }
    const epoch = this.epoch;
    let pending = this.pending.get(key);
    if (!pending) {
      const until = this.now() + this.ttl; // 网络耗时不延长快照的最大寿命。
      pending = Promise.resolve().then(load).then(value => {
        const bytes = Buffer.byteLength(JSON.stringify(value));
        if (epoch === this.epoch && until > this.now() && bytes <= this.maxBytes) {
          this.values.set(key, { value: structuredClone(value), bytes, until }); this.bytes += bytes;
          while (this.values.size > this.limit || this.bytes > this.maxBytes) {
            const [old, item] = this.values.entries().next().value; this.values.delete(old); this.bytes -= item.bytes;
          }
        }
        return value;
      }).finally(() => { if (this.pending.get(key) === pending) this.pending.delete(key); });
      this.pending.set(key, pending);
    }
    const value = await pending;
    if (epoch !== this.epoch) return this.get(key, load); // 写入期间完成的旧读不能重新填充缓存。
    return structuredClone(value);
  }
}

/** 按滚动窗口限制真实请求数；允许短时快速读取，仍给同账号其它工具保留额度。 */
export class RequestBudget {
  constructor({ limit = 90, windowMs = 60000 } = {}) { this.limit = limit; this.windowMs = windowMs; this.starts = []; }
  delay(now) { this.starts = this.starts.filter(t => t > now - this.windowMs); return this.starts.length < this.limit ? 0 : Math.max(0, this.starts[0] + this.windowMs - now); }
  record(now) { this.starts.push(now); }
}
