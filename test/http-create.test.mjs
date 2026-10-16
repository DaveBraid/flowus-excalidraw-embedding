import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.mjs';
import { Auth, hashPassword } from '../server/auth.mjs';
import { ServiceError } from '../server/flowus.mjs';
import { Readable } from 'node:stream';

/** 启动隔离HTTP夹具；只模拟授权后的存储调用，返回清理函数，绝不连接FlowUs。 */
async function fixture() {
  const origin = 'http://127.0.0.1'; const auth = new Auth('a'.repeat(32), hashPassword('test-password'), { secure: false });
  const issued = auth.issue(); const writes = []; const scenes = new Map();
  const canvases = {
    async load(slug) { if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(slug)) throw new ServiceError(404, '画布不存在'); if (!scenes.has(slug)) throw new ServiceError(404, '画布不存在', 'CANVAS_NOT_FOUND'); return { canvas: scenes.get(slug) }; },
    async create(body) { writes.push(body); if (scenes.has(body.slug)) throw new ServiceError(409, '已有画布'); const canvas = { slug: body.slug, title: body.title, scene: {} }; scenes.set(body.slug, canvas); return { canvas }; },
  };
  const server = createApp({ auth, canvases, origin });
  const call = (path, options = {}) => new Promise(done => {
    const req = Readable.from(options.body ? [Buffer.from(options.body)] : []);
    Object.assign(req, { url: path, method: options.method || 'GET', headers: Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value])), socket: { remoteAddress: '127.0.0.1' } });
    const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(body) { done({ status: this.status, json: async () => JSON.parse(body) }); } };
    server.emit('request', req, res); // 直接驱动真实HTTP处理器，测试不监听端口。
  });
  const headers = { Cookie: `draw-dev=${issued.token}` };
  return { call, writes, headers, post: { ...headers, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': issued.csrfToken }, close: async () => {} };
}

test('合法缺失画布GET只返回明确404，确认POST才创建；重复POST不覆盖', async () => {
  const f = await fixture();
  try {
    const missing = await f.call(`/api/canvases/direct-create`, { headers: f.headers });
    assert.equal(missing.status, 404); assert.equal((await missing.json()).code, 'CANVAS_NOT_FOUND'); assert.equal(f.writes.length, 0);
    const bad = await f.call(`/api/canvases/%E4%B8%AD%E6%96%87`, { headers: f.headers });
    assert.equal(bad.status, 404); assert.equal((await bad.json()).code, undefined); assert.equal(f.writes.length, 0);
    const created = await f.call(`/api/canvases`, { method: 'POST', headers: f.post, body: JSON.stringify({ slug: 'direct-create', title: '确认创建' }) });
    assert.equal(created.status, 201); assert.equal((await created.json()).canvas.slug, 'direct-create');
    const existing = await f.call(`/api/canvases/direct-create`, { headers: f.headers }); assert.equal((await existing.json()).canvas.title, '确认创建');
    const duplicate = await f.call(`/api/canvases`, { method: 'POST', headers: f.post, body: JSON.stringify({ slug: 'direct-create', title: '不可覆盖' }) }); assert.equal(duplicate.status, 409);
    const same = await f.call(`/api/canvases/direct-create`, { headers: f.headers }); assert.equal((await same.json()).canvas.title, '确认创建');
  } finally { await f.close(); }
});
