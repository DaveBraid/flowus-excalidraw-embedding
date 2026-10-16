import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadCache, RequestBudget } from '../server/read-cache.mjs';
import { FlowUs } from '../server/flowus.mjs';
import { Canvases } from '../server/storage.mjs';
import { nativeDocument } from '../server/native.mjs';
import { folderNativeFixture, imageScene, textScene } from './fixture.mjs';
import { createApp } from '../server/index.mjs';
import { Auth, hashPassword } from '../server/auth.mjs';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';

/** 用真实API调度器连接内存FlowUs；输出调用计数，测试不访问网络。 */
function fixture() {
  const f = folderNativeFixture(); let requests = 0;
  const api = new FlowUs({ token: 'test-only', fetchImpl: async (url, options) => {
    requests++; const path = new URL(url).pathname.replace('/v2', '');
    const value = options.method === 'GET' && path.endsWith('/children')
      ? { results: await f.api.all('GET', path), has_more: false }
      : (await f.api.request(options.method, path, options.body && JSON.parse(options.body))).data;
    return new Response(JSON.stringify(value), { status: 200 });
  } });
  const store = new Canvases(api, { rootId: f.ids.root, uploadPageId: f.ids.root, nativeRootId: f.ids.settingsPage, fetchImpl: f.fetchImpl });
  return { ...f, store, api, count: () => requests };
}

test('只读缓存合并并发、隔离对象，普通调用及过期缓存始终回源', async () => {
  let now = 0, calls = 0; const cache = new ReadCache({ now: () => now, ttl: 10 });
  const load = async () => ({ n: ++calls });
  const [a, b] = await Promise.all([cache.run(() => cache.get('x', load)), cache.run(() => cache.get('x', load))]);
  a.n = 999; assert.equal(b.n, 1); assert.equal(calls, 1);
  assert.equal((await cache.get('x', load)).n, 2); // 保存/GC默认路径不得使用显示缓存。
  assert.equal((await cache.run(() => cache.get('x', load))).n, 1);
  now = 11; assert.equal((await cache.run(() => cache.get('x', load))).n, 3);
  assert.equal((await cache.run(() => cache.get('x', load), true)).n, 4);
});

test('写入时失效在途旧读，错误不缓存，内存有界', async () => {
  const cache = new ReadCache({ limit: 1 }); let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = cache.run(() => cache.get('x', async () => { calls++; if (calls === 1) await gate; return calls; }));
  await Promise.resolve(); cache.invalidate(); release(); assert.equal(await pending, 2);
  await assert.rejects(cache.run(() => cache.get('bad', async () => { throw Error('网络失败'); })));
  assert.equal(await cache.run(() => cache.get('bad', async () => 3)), 3);
  assert.equal(cache.values.size, 1); assert.equal(cache.pending.size, 0);
});

test('列表后打开画布只增一次附件目录读取，再读画布和空缩略图零API调用', async () => {
  const f = fixture(); const list = await f.store.readOnly(() => f.store.list());
  assert.equal(list.canvases[0].empty, true);
  const before = f.count(); const canvas = (await f.store.readOnly(() => f.store.load('review', true))).canvas;
  assert.equal(f.count() - before, 1);
  const warm = f.count(); await f.store.readOnly(() => f.store.load('review', true));
  assert.equal((await f.store.readOnly(() => f.store.thumbnail('review', canvas.revision))).thumbnail.empty, true);
  assert.equal(f.count(), warm);
});

test('缓存有旧版本时保存仍拒绝冲突，强制刷新能看见外部修改', async () => {
  const f = fixture(); const old = (await f.store.readOnly(() => f.store.load('review', true))).canvas;
  const doc = nativeDocument(f.blocks.get(f.ids.scene)); doc.scene = textScene('外部修改'); f.addCode(f.ids.scene, f.ids.page, doc);
  await assert.rejects(f.store.save('review', { operationId: crypto.randomUUID(), revision: old.revision, scene: textScene('旧窗口') }), { status: 409 });
  const fresh = (await f.store.readOnly(() => f.store.load('review', true), true)).canvas;
  assert.equal(fresh.scene.elements[0].text, '外部修改'); assert.notEqual(fresh.revision, old.revision);
});

test('保存和删除立即失效前台快照；图片与已命中的预览复用校验结果', async () => {
  const f = fixture(); const old = (await f.store.readOnly(() => f.store.load('review', true))).canvas;
  const saved = (await f.store.save('review', { operationId: crypto.randomUUID(), revision: old.revision, scene: imageScene() })).canvas;
  const canvas = (await f.store.readOnly(() => f.store.load('review', true))).canvas;
  assert.equal(canvas.revision, saved.revision); const before = f.count();
  const image = await f.store.readOnly(() => f.store.asset('review', 'f', saved.assets.f.hash));
  assert.equal(image.file.dataURL, imageScene().files.f.dataURL); assert.equal(f.count() - before, 1); // 仅需取得图片下载签名。
  await f.store.thumbnails.set('review', { revision: saved.revision, dataURL: 'data:image/png;base64,YQ==' });
  const warm = f.count(); assert.ok((await f.store.readOnly(() => f.store.thumbnail('review', saved.revision))).thumbnail); assert.equal(f.count(), warm);
  await f.store.manage('review', { action: 'delete', operationId: crypto.randomUUID(), revision: saved.revision });
  await assert.rejects(f.store.readOnly(() => f.store.load('review', true)), { status: 410 });
  assert.equal((await f.store.readOnly(() => f.store.list())).canvases[0].status, 'deleted');
});

test('GC不使用前台缓存，外部删除数据页后停止回收', async () => {
  const f = fixture(); await f.store.readOnly(() => f.store.list());
  f.blocks.get(f.ids.page).in_trash = true;
  await assert.rejects(f.store.collectGarbage()); assert.equal(f.requests.filter(r => r.method === 'DELETE').length, 0);
});

test('干净画布的GC提前结束，闲置附件仍进入原有回收流程', async () => {
  const f = fixture();
  f.api.budget.limit = 1000; // 本项验证读取数量；滚动限流由独立时钟测试覆盖。
  await f.store.collectGarbage();
  assert.ok(f.count() <= 15, `空画布回收读取过多：${f.count()}`);
  const initial = (await f.store.load('review', true)).canvas;
  const saved = (await f.store.save('review', { operationId: crypto.randomUUID(), revision: initial.revision, scene: imageScene() })).canvas;
  const before = f.count(); await f.store.collectGarbage();
  assert.ok(f.count() - before <= 15, `已登记活跃图片重复读取：${f.count() - before}`);
  await f.store.save('review', { operationId: crypto.randomUUID(), revision: saved.revision, scene: textScene('删除图片') });
  await f.store.collectGarbage();
  const file = f.blocks.get(saved.assets.f.blockId);
  assert.ok(f.store.gc.metadata(file).gc, '闲置图片仍须登记回收候选');
});

test('滚动预算允许短时读取，达到窗口额度后等待直到旧请求过期', () => {
  const budget = new RequestBudget({ limit: 2, windowMs: 1000 });
  assert.equal(budget.delay(0), 0); budget.record(0); assert.equal(budget.delay(10), 0); budget.record(10);
  assert.equal(budget.delay(20), 980); assert.equal(budget.delay(1000), 0); budget.record(1000);
  assert.equal(budget.delay(1001), 9);
});

test('HTTP鉴权后才使用读缓存；强制检查回源，静态资源协商压缩且HTML不长缓存', async () => {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), 'draw-http-cache-'));
  const auth = new Auth('t'.repeat(32), hashPassword('test'), { secure: false }), session = auth.issue();
  const server = createApp({ auth, canvases: f.store, origin: 'http://127.0.0.1', dist: directory });
  const call = (url, headers = { cookie: `draw-dev=${session.token}` }) => new Promise(resolve => {
    const req = Readable.from([]); Object.assign(req, { url, method: 'GET', headers, socket: {} });
    const result = { headers: {} };
    server.emit('request', req, { setHeader(k, v) { result.headers[k] = v; }, writeHead(status, headers) { result.status = status; Object.assign(result.headers, headers); }, end(body) { resolve({ ...result, body }); } });
  });
  try {
    await mkdir(join(directory, 'assets')); await writeFile(join(directory, 'index.html'), '<main>test</main>');
    const js = Buffer.from('export const value = 1;'); const path = join(directory, 'assets/index-abcdefgh.js');
    await writeFile(path, js); await writeFile(path + '.br', brotliCompressSync(js));
    assert.equal((await call('/api/canvases')).status, 200); const warm = f.count();
    assert.equal((await call('/api/canvases?fresh=1', {})).status, 401);
    await call('/api/canvases'); assert.equal(f.count(), warm);
    await call('/api/canvases?fresh=1'); assert.ok(f.count() > warm);
    const compressed = await call('/assets/index-abcdefgh.js', { 'accept-encoding': 'br, gzip' });
    assert.equal(compressed.headers['Content-Encoding'], 'br'); assert.deepEqual(brotliDecompressSync(compressed.body), js);
    assert.match(compressed.headers['Cache-Control'], /immutable/);
    const identity = await call('/assets/index-abcdefgh.js', { 'accept-encoding': 'br;q=0' });
    assert.equal(identity.headers['Content-Encoding'], undefined); assert.deepEqual(identity.body, js);
    assert.equal((await call('/')).headers['Cache-Control'], 'no-store');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
