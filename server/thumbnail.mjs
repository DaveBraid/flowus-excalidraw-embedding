import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ServiceError, validSlug } from './flowus.mjs';

/** 缩略图仅为可丢弃派生缓存；每画布保留最新一张，总数64、总量8MiB，重启可恢复。 */
export class ThumbnailCache {
  constructor({ directory = process.env.THUMBNAIL_CACHE_DIR, limit = 64, maxBytes = 8 * 1024 ** 2 } = {}) {
    this.directory = directory; this.limit = limit; this.maxBytes = maxBytes; this.items = new Map(); this.queue = Promise.resolve();
    this.ready = this.restore();
  }
  /** 读取受管缓存文件；损坏条目删除，原始画布不受影响。 */
  async restore() {
    if (!this.directory) return;
    await mkdir(this.directory, { recursive: true });
    for (const name of await readdir(this.directory)) {
      if (/^[a-z0-9][a-z0-9_-]{0,79}\.json\.tmp$/.test(name)) { await unlink(join(this.directory, name)).catch(() => {}); continue; }
      if (!/^[a-z0-9][a-z0-9_-]{0,79}\.json$/.test(name)) continue;
      try { const value = JSON.parse(await readFile(join(this.directory, name), 'utf8')); this.validate(value); this.items.set(name.slice(0, -5), value); }
      catch { await unlink(join(this.directory, name)).catch(() => {}); }
    }
    this.items = new Map([...this.items].sort((a, b) => a[1].at - b[1].at)); await this.trim();
  }
  validate(value) {
    if (!value || !/^[a-f0-9]{64}$/.test(value.revision || '') || typeof value.dataURL !== 'string' || !/^data:image\/(png|webp);base64,[A-Za-z0-9+/=]+$/.test(value.dataURL) || Buffer.byteLength(value.dataURL) > 128 * 1024) throw new ServiceError(400, '缩略图格式或大小无效');
  }
  async get(slug, revision) { await this.ready; const value = this.items.get(slug); return value?.revision === revision ? value : null; }
  async set(slug, value) {
    if (!validSlug(slug)) throw new ServiceError(400, '画布标识无效'); this.validate(value);
    const work = async () => {
      await this.ready; const record = { revision: value.revision, dataURL: value.dataURL, at: Date.now() };
      if (this.directory) { const file = join(this.directory, `${slug}.json`); await writeFile(`${file}.tmp`, JSON.stringify(record)); await rename(`${file}.tmp`, file); }
      this.items.delete(slug); this.items.set(slug, record); await this.trim();
    };
    const pending = this.queue.then(work, work); this.queue = pending.catch(() => {}); return pending;
  }
  async remove(slug) { this.items.delete(slug); if (this.directory) await unlink(join(this.directory, `${slug}.json`)).catch(() => {}); }
  async trim() {
    let bytes = [...this.items.values()].reduce((n, v) => n + Buffer.byteLength(v.dataURL), 0);
    while (this.items.size > this.limit || bytes > this.maxBytes) { const [slug, item] = this.items.entries().next().value; bytes -= Buffer.byteLength(item.dataURL); await this.remove(slug); }
  }
}
