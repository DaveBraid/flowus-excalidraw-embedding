import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { folderNativeFixture, imageScene, textScene, emptyScene } from './fixture.mjs';
import { nativeDocument, blockVersion } from '../server/native.mjs';
import { ThumbnailCache } from '../server/thumbnail.mjs';

const op = () => randomUUID();
const failure = () => Object.assign(new Error('模拟断网'), { status: 503 });

test('写入已成功但回读断网：重启可查询，同一操作重试零重复写；换内容拒绝', async () => {
  const f = folderNativeFixture(), store = f.service(), canvas = (await store.load('review')).canvas;
  const input = { operationId: op(), revision: canvas.revision, scene: textScene('提交成功') };
  const raw = f.api.request; let patched = false;
  f.api.request = async (method, path, body, ...rest) => { const result = await raw(method, path, body, ...rest); if (path === `/blocks/${f.ids.scene}` && method === 'PATCH') { patched = true; throw failure(); } if (patched && path === `/blocks/${f.ids.scene}` && method === 'GET') throw failure(); return result; };
  await assert.rejects(store.save('review', input), { status: 503 }); f.api.request = raw;
  const restarted = f.service(), state = await restarted.operationStatus('review', input.operationId);
  assert.equal(state.status, 'committed'); assert.equal(state.superseded, false);
  const before = f.requests.filter(r => r.method === 'PATCH').length;
  assert.equal((await restarted.save('review', input)).canvas.revision, state.canvas.revision);
  assert.equal(f.requests.filter(r => r.method === 'PATCH').length, before);
  await assert.rejects(restarted.save('review', { ...input, scene: textScene('恶意复用') }), { status: 409 });
});

test('标题同步失败不影响提交；确认较早的操作不能冒充当前版本继续覆盖', async () => {
  const f = folderNativeFixture(), store = f.service(), canvas = (await store.load('review')).canvas;
  f.api.beforeRequest = (method, path) => { if (method === 'PATCH' && path === `/blocks/${f.ids.folder}`) throw failure(); };
  const first = { operationId: op(), revision: canvas.revision, title: '异步标题' };
  const saved = (await store.save('review', first)).canvas; assert.equal(saved.title, '异步标题');
  const next = (await store.save('review', { operationId: op(), revision: saved.revision, scene: textScene('后续') })).canvas;
  assert.notEqual(next.revision, saved.revision); assert.equal((await store.operationStatus('review', first.operationId)).superseded, true);
});

test('新建folder响应丢失：同操作仅续建一份folder和page', async () => {
  const f = folderNativeFixture(), store = f.service(), raw = f.api.request; let lost = false;
  f.api.request = async (method, path, body, ...rest) => { const result = await raw(method, path, body, ...rest); if (!lost && method === 'PATCH' && path === `/blocks/${f.ids.root}/children`) { lost = true; throw failure(); } return result; };
  const input = { slug: 'resume-create', title: '恢复创建', operationId: op() };
  await assert.rejects(store.create(input), { status: 503 });
  const saved = (await f.service().create(input)).canvas; assert.equal(saved.slug, input.slug);
  assert.equal(f.requests.filter(r => r.method === 'PATCH' && r.path === `/blocks/${f.ids.root}/children`).length, 1);
  assert.equal(f.requests.filter(r => r.method === 'POST' && r.path === '/pages').length, 1);
  await f.service().create(input); assert.equal(f.requests.filter(r => r.method === 'POST' && r.path === '/pages').length, 1);
});

test('数据页创建响应丢失：扫描原folder恢复，不覆盖已存在场景', async () => {
  const f = folderNativeFixture(), raw = f.api.request; let lost = false;
  f.api.request = async (method, path, body, ...rest) => { const result = await raw(method, path, body, ...rest); if (!lost && method === 'POST' && path === '/pages') { lost = true; throw failure(); } return result; };
  const input = { slug: 'resume-page', title: '数据页恢复', operationId: op() };
  await assert.rejects(f.service().create(input)); const canvas = (await f.service().create(input)).canvas;
  assert.equal(canvas.slug, input.slug); assert.equal(f.requests.filter(r => r.path === '/pages' && r.method === 'POST').length, 1);
});

test('一张数据页被删除不影响其他卡片，GC严格暂停；恢复后修复原链接', async () => {
  const f = folderNativeFixture(), store = f.service(); await store.create({ slug: 'healthy', title: '正常' });
  f.blocks.get(f.ids.page).in_trash = true;
  const list = await store.list(); assert.equal(list.canvases.find(c => c.slug === 'healthy').status, 'ready'); assert.equal(list.canvases.find(c => c.slug === 'review').status, 'unavailable'); assert.equal(list.gcPaused, true);
  await assert.rejects(store.collectGarbage()); assert.equal(f.requests.filter(r => r.method === 'DELETE').length, 0);
  f.blocks.get(f.ids.page).in_trash = false;
  await store.manage('review', { action: 'repair', operationId: op() }); assert.equal((await store.list()).canvases.find(c => c.slug === 'review').status, 'ready');
});

test('旧图按引用保存：文字修改0图片上传、0图片下载、响应无base64', async () => {
  const f = folderNativeFixture(), store = f.service(); const first = (await store.load('review')).canvas;
  const saved = (await store.save('review', { operationId: op(), revision: first.revision, scene: imageScene() })).canvas;
  const scene = { ...imageScene(), elements: [...imageScene().elements, ...textScene('文字变化').elements], files: { f: { id: 'f', hash: saved.assets.f.hash, mimeType: 'image/png' } } };
  const before = f.transfers.length;
  const result = await store.save('review', { operationId: op(), revision: saved.revision, scene });
  assert.equal(f.transfers.length, before); assert.ok(!JSON.stringify(result).includes('base64'));
  const block = f.blocks.get(saved.assets.f.blockId); block.in_trash = true;
  const loaded = (await store.load('review', true)).canvas; assert.deepEqual(loaded.missingAssets, ['f']);
  await assert.rejects(store.save('review', { operationId: op(), revision: result.canvas.revision, scene }), { code: 'ASSET_MISSING' });
});

test('图片挂载已成功但响应丢失：重启重试复用对象，上传总次数为1', async () => {
  const f = folderNativeFixture(), store = f.service(), first = (await store.load('review')).canvas, raw = f.api.request; let lost = false;
  f.api.request = async (method, path, body, ...rest) => { const result = await raw(method, path, body, ...rest); if (!lost && path === `/blocks/${f.ids.folder}/children` && method === 'PATCH') { lost = true; throw failure(); } return result; };
  const input = { operationId: op(), revision: first.revision, scene: imageScene() };
  await assert.rejects(store.save('review', input)); await f.service().save('review', input);
  assert.equal(f.transfers.filter(r => r.method === 'PUT').length, 1); assert.equal(f.children(f.ids.folder).filter(b => b.type === 'file').length, 1);
});

test('场景提交失败的有凭证附件满7天并双扫描后回收，无凭证文件不动', async () => {
  const f = folderNativeFixture(), store = f.service(), first = (await store.load('review')).canvas;
  f.api.beforeRequest = (method, path) => { if (method === 'PATCH' && path === `/blocks/${f.ids.scene}`) throw failure(); };
  await assert.rejects(store.save('review', { operationId: op(), revision: first.revision, scene: imageScene() })); f.api.beforeRequest = undefined;
  const entry = await store.resolve('review');
  await store.native.tasks(entry, doc => { for (const task of Object.values(doc.uploads)) { task.at = Date.now() - 8 * 86400000; task.checkedAt = Date.now() - 120000; task.checkedRevision = blockVersion(entry.block); } });
  const file = f.children(f.ids.folder).find(b => b.type === 'file');
  await store.collectGarbage(); assert.equal(f.blocks.get(file.id).in_trash, true); assert.equal(Object.keys((await store.native.tasks(entry)).uploads).length, 0);
});

test('删除以整个folder为单位，旧窗口不能保存或同名重建；回收站恢复可接回原链接', async () => {
  const f = folderNativeFixture(), store = f.service(), canvas = (await store.load('review')).canvas;
  await store.manage('review', { action: 'delete', operationId: op(), revision: canvas.revision });
  assert.equal(f.blocks.get(f.ids.folder).in_trash, true); assert.equal((await store.list()).canvases[0].status, 'deleted');
  await assert.rejects(store.save('review', { operationId: op(), revision: canvas.revision, scene: emptyScene() }), { status: 410 });
  await assert.rejects(store.create({ slug: 'review', title: '误建' }), { status: 409 });
  f.blocks.get(f.ids.folder).in_trash = false;
  await store.manage('review', { action: 'repair', operationId: op() }); assert.equal((await store.list()).canvases[0].status, 'ready');
});

test('从列表移除只改索引，修复重复候选必须拒绝', async () => {
  const f = folderNativeFixture(), store = f.service(); await store.manage('review', { action: 'detach', operationId: op() });
  assert.equal(f.requests.filter(r => r.method === 'DELETE').length, 0); assert.equal((await store.list()).canvases[0].status, 'detached');
  f.addCode(randomUUID(), f.ids.page, nativeDocument(f.blocks.get(f.ids.scene)));
  await assert.rejects(store.manage('review', { action: 'repair', operationId: op() }), { status: 409 });
});

test('限量缩略缓存每画布只保留最新版本，重启恢复，旧图淘汰', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'draw-thumbs-'));
  try {
    const cache = new ThumbnailCache({ directory, limit: 2 }); const image = 'data:image/png;base64,YQ==';
    await cache.set('a', { revision: 'a'.repeat(64), dataURL: image }); await cache.set('a', { revision: 'b'.repeat(64), dataURL: image });
    assert.equal(cache.items.size, 1); assert.equal(await cache.get('a', 'a'.repeat(64)), null);
    await cache.set('b', { revision: 'b'.repeat(64), dataURL: image }); await cache.set('c', { revision: 'c'.repeat(64), dataURL: image });
    const restored = new ThumbnailCache({ directory, limit: 2 }); await restored.ready;
    assert.equal(restored.items.size, 2); assert.equal(await restored.get('a', 'b'.repeat(64)), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('创建失败的空文件夹满7天可清理，手工加入内容后必须保留', async () => {
  const f = folderNativeFixture(), store = f.service(); const input = { slug: 'abandoned', title: '失败测试', operationId: op() };
  f.api.beforeRequest = (method, path) => { if (method === 'POST' && path === '/pages') throw failure(); };
  await assert.rejects(store.create(input)); f.api.beforeRequest = undefined;
  await store.native.editRegistry(doc => { const job = doc.creations[input.operationId]; job.at = Date.now() - 8 * 86400000; job.checkedAt = Date.now() - 120000; });
  const job = (await store.native.registry()).document.creations[input.operationId];
  const custom = f.put({ id: op(), type: 'paragraph', paragraph: { rich_text: [] } }, job.folderId);
  await store.collectGarbage(); assert.equal(f.requests.filter(r => r.method === 'DELETE').length, 0);
  f.blocks.delete(custom.id); await store.collectGarbage(); assert.equal(f.blocks.get(job.folderId).in_trash, true);
});

test('删除响应丢失后保持停写，未知权限错误不能被当成已删除', async () => {
  const f = folderNativeFixture(), store = f.service(), canvas = (await store.load('review')).canvas, raw = f.api.request; let deleted = false;
  f.api.request = async (method, path, body) => { if (deleted && path === `/blocks/${f.ids.folder}`) throw failure(); const result = await raw(method, path, body); if (method === 'DELETE') { deleted = true; throw failure(); } return result; };
  await assert.rejects(store.manage('review', { action: 'delete', operationId: op(), revision: canvas.revision }));
  assert.equal((await store.list()).canvases[0].status, 'deleting');
  await assert.rejects(store.manage('review', { action: 'delete', operationId: op() }));
  await assert.rejects(store.save('review', { operationId: op(), revision: canvas.revision, scene: emptyScene() }), { status: 410 });
});

test('上传意图已保存而字节尚未发送：空对象仍受管理，后续重试可补传', async () => {
  const f = folderNativeFixture(), store = f.service(), canvas = (await store.load('review')).canvas, raw = f.api.request;
  let lost = false;
  f.api.request = async (method, path, body) => { const result = await raw(method, path, body); if (!lost && method === 'PATCH' && path === `/blocks/${f.ids.page}/children`) { lost = true; throw failure(); } return result; };
  const input = { operationId: op(), revision: canvas.revision, scene: imageScene() };
  await assert.rejects(store.save('review', input)); assert.equal(f.transfers.filter(r => r.method === 'PUT').length, 0);
  const restarted = f.service(); await assert.rejects(restarted.save('review', input), { code: 'OPERATION_PENDING' });
  const result = (await restarted.save('review', input)).canvas; assert.ok(result.assets.f); assert.equal(f.transfers.filter(r => r.method === 'PUT').length, 1);
  const tasks = await restarted.native.tasks(await restarted.resolve('review')); assert.equal(Object.values(tasks.uploads)[0].state, 'empty');
});

test('只有已确认删除的画布可永久释放标识，释放后同名新建仍拒绝旧revision', async () => {
  const f = folderNativeFixture(), store = f.service(), old = (await store.load('review')).canvas;
  await assert.rejects(store.manage('review', { action: 'release', operationId: op() }), { status: 409 });
  await store.manage('review', { action: 'delete', operationId: op(), revision: old.revision });
  await store.manage('review', { action: 'release', operationId: op() });
  await store.create({ slug: 'review', title: '新生命周期', operationId: op() });
  await assert.rejects(store.save('review', { operationId: op(), revision: old.revision, scene: textScene('旧窗口') }), { status: 409 });
});

test('损坏其他原生数据页时，未使用的新链接仍准确返回CANVAS_NOT_FOUND', async () => {
  const f = folderNativeFixture(), store = f.service(); f.blocks.get(f.ids.page).in_trash = true;
  await assert.rejects(store.load('brand-new', true), { status: 404, code: 'CANVAS_NOT_FOUND' });
  assert.equal(f.requests.filter(r => r.method !== 'GET').length, 0);
});

test('无目录的失败创建任务过期只收敛记录，绝不删除未知目录', async () => {
  const f = folderNativeFixture(), store = f.service(), id = op();
  await store.native.editRegistry(doc => { doc.creations = { [id]: { id,slug:'never-created',title:'未创建',marker:'⏳ 未创建 [test]',at:Date.now()-8*86400000,checkedAt:Date.now()-120000,state:'folder-requested' } }; });
  await store.collectGarbage(); assert.equal((await store.native.registry()).document.creations[id].state,'cleaned'); assert.equal(f.requests.filter(r=>r.method==='DELETE').length,0);
  await assert.rejects(store.create({operationId:'__proto__',slug:'invalid',title:'拒绝'}),{status:400});
});
