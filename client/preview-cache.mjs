/** 生成已保存版本的缓存键；标题或临时编辑不参与预览。 */
export function previewKey(slug, revision) { return JSON.stringify([slug, revision]); }

/**
 * 按受限并发生成缩略图，并按最近使用顺序保留少量位图。
 * 输入任务和存活检查；输出缩略 Blob，不保留原始 scene。
 */
export class PreviewCache {
  constructor(limit = 32, concurrency = 1) {
    this.limit = limit; // 缩略图内存上限，避免长列表无限增长。
    this.cache = new Map();
    this.pending = new Map();
    this.queue = [];
    this.running = 0; this.concurrency = concurrency;
  }
  /** 同版本复用位图或进行中的任务；滚出页面的未启动任务会跳过。 */
  get(key, create, needed = () => true) {
    if (this.cache.has(key)) {
      const value = this.cache.get(key);
      this.cache.delete(key); this.cache.set(key, value);
      return Promise.resolve(value);
    }
    const existing = this.pending.get(key);
    if (existing) { existing.needed.push(needed); return existing.promise; }
    let resolve; let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const job = { key, create, needed: [needed], promise, resolve, reject };
    this.pending.set(key, job); this.queue.push(job); this.drain();
    return promise;
  }
  /** 限制读取与渲染的并发任务数；失败不入缓存，允许用户显式重试。 */
  async drain() {
    if (this.running >= this.concurrency) return;
    this.running++;
    while (this.queue.length) {
      const job = this.queue.shift();
      try {
        if (!job.needed.some(check => check())) throw Object.assign(new Error('预览任务已离开视区'), { name: 'AbortError' });
        const value = await job.create();
        this.cache.set(job.key, value);
        while (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value);
        job.resolve(value);
      } catch (failure) { job.reject(failure); }
      finally { this.pending.delete(job.key); }
    }
    this.running--;
  }
}
