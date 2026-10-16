import { readFileSync } from 'node:fs';
import { ReadCache, RequestBudget } from './read-cache.mjs';

export class ServiceError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export const plain = value => (value || []).map(x => x.plain_text ?? x.text?.content ?? '').join('');
export const property = (page, name) => page.properties?.[name];
export const alive = page => !page.in_trash && !page.archived;
export const validSlug = slug => typeof slug === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(slug);

/** 读取运行时秘密；输入环境变量名称，输出秘密值，不写日志。 */
export function secret(name) {
  return process.env[`${name}_FILE`] ? readFileSync(process.env[`${name}_FILE`], 'utf8').trim() : (process.env[name] || '');
}

/** 全实例串行限速；输入请求函数，输出限速后的响应。 */
export class FlowUs {
  constructor({ token, tokenProvider, fetchImpl = fetch, interval = 0, base = 'https://api.flowus.cn' }) {
    this.token = token; this.fetch = fetchImpl; this.interval = interval; this.base = base;
    this.tokenProvider = tokenProvider;
    this.queue = Promise.resolve(); this.next = 0;
    this.reads = new ReadCache(); this.budget = new RequestBudget();
  }
  readView(work, fresh = false) { return this.reads.run(work, fresh); }
  async request(method, path, body, revision, idempotencyKey) {
    if (method === 'GET') return this.reads.get(path, () => this.requestFresh(method, path, body, revision, idempotencyKey));
    this.reads.invalidate();
    try { return await this.requestFresh(method, path, body, revision, idempotencyKey); }
    finally { this.reads.invalidate(); } // 请求结果不明也不得保留写前缓存。
  }
  async requestFresh(method, path, body, revision, idempotencyKey) {
    const task = async () => {
      let token = this.tokenProvider ? await this.tokenProvider.getToken() : this.token;
      let refreshed = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise(r => setTimeout(r, Math.max(0, this.next - Date.now(), this.budget.delay(Date.now()))));
        this.budget.record(Date.now()); // 重试也计入每分钟90次预算。
        this.next = Date.now() + this.interval;
        let response;
        try {
          response = await this.fetch(`${this.base}/v2${path}`, {
            method, signal: AbortSignal.timeout(20000),
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(revision ? { 'If-Match': revision } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        } catch { throw new ServiceError(503, 'FlowUs 暂时无法连接，请稍后重试'); }
        if (response.status === 401 && this.tokenProvider && !refreshed) {
          token = await this.tokenProvider.getToken(true); refreshed = true;
          continue; // 只让官方 CLI 重验一次，避免两个刷新实现竞争。
        }
        if (response.status === 429 && attempt < 2) {
          const seconds = Number(response.headers.get('retry-after'));
          this.next = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 120) * 1000 : 2000 * 2 ** attempt);
          continue;
        }
        if (!response.ok) {
          const status = [409, 412].includes(response.status) ? 409 : response.status === 404 ? 404 : 503;
          const failure = new ServiceError(status, status === 409 ? '数据已被其他窗口修改，请刷新后重试' : status === 404 ? 'FlowUs 内容不存在或无权访问' : 'FlowUs 请求失败，请检查授权或稍后重试');
          failure.upstreamStatus = response.status; throw failure;
        }
        return { data: await response.json(), etag: response.headers.get('etag') };
      }
      throw new ServiceError(503, 'FlowUs 请求过于频繁，请稍后重试');
    };
    const pending = this.queue.then(task, task);
    this.queue = pending.catch(() => {});
    return pending;
  }
  /** 完整读取游标分页；输入接口参数，输出全部记录，拒绝不完整数据。 */
  async all(method, path, body = {}) {
    const values = []; let cursor; const seen = new Set();
    do {
      const params = { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
      const url = method === 'GET' ? `${path}?${new URLSearchParams(params)}` : path;
      const { data } = await this.request(method, url, method === 'GET' ? undefined : params);
      if (!Array.isArray(data.results)) throw new ServiceError(503, 'FlowUs 分页响应不完整');
      values.push(...data.results);
      if (!data.has_more) break;
      cursor = data.next_cursor;
      if (!cursor || seen.has(cursor) || values.length > 10000) throw new ServiceError(503, 'FlowUs 分页异常');
      seen.add(cursor);
    } while (true);
    return values;
  }
}
