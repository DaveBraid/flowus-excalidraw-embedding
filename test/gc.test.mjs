import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NATIVE_LIMIT, nativeContent, nativeDocument, plainText } from '../server/native.mjs';
import { Canvases } from '../server/storage.mjs';
import { activeFileIds, GC_GRACE_MS } from '../server/gc.mjs';

const id = number => `30000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const nativeIds = { root: id(1), upload: id(2), settingsPage: id(3), registry: id(4), settings: id(5), folder: id(6), page: id(7), scene: id(8) };
const emptyScene = () => ({ elements: [], appState: {}, files: {} });
const textScene = text => ({ elements: [{ id: 't', type: 'text', text }], appState: {}, files: {} });
const metaCaption = metadata => [{ type: 'text', text: { content: `excalidraw-flowus:${JSON.stringify(metadata)}` } }];

/** 模拟真实folder内JSON数据页；输出服务、固定ID、附件对象及全部API调用，不产生远端内容。 */
function folderNativeFixture({ state = 'ready' } = {}) {
  const n = nativeIds, blocks = new Map(), objects = new Map(), requests = [], transfers = []; let clock = 0;
  const put = (block, parent) => { const value = { ...structuredClone(block), last_edited_time: `v${++clock}`, ...(parent && { parent: { type: 'page_id', page_id: parent } }) }; blocks.set(value.id, value); return value; };
  const children = parent => [...blocks.values()].filter(block => block.parent?.page_id === parent);
  const addCode = (blockId, parent, doc) => put({ id: blockId, ...nativeContent(doc) }, parent);
  const addPage = (pageId, parent, title) => put({ id: pageId, type: 'child_page', child_page: { title }, properties: { title: { type: 'title', title: [{ text: { content: title } }] } } }, parent);
  put({ id: n.root, type: 'folder', folder: { title: '画布根' } });
  put({ id: n.folder, type: 'folder', folder: { title: '原生画布' } }, n.root);
  addPage(n.settingsPage, n.root, 'general settings'); addPage(n.page, n.folder, 'JSON 数据');
  addCode(n.registry, n.settingsPage, { schemaVersion: 2, kind: 'registry', state, legacyRootId: n.root, maxSceneBytes: NATIVE_LIMIT, canvases: { review: { pageId: n.page, blockId: n.scene, folderId: n.folder } } });
  addCode(n.settings, n.settingsPage, { schemaVersion: 2, kind: 'settings', settings: { autoSave: true } });
  addCode(n.scene, n.page, { schemaVersion: 2, kind: 'scene', slug: 'review', title: '原生画布', assetFolderId: n.folder, scene: emptyScene(), assets: {}, uploadedBytes: 0 });
  const api = {
    async all(method, path) { return structuredClone(children(path.match(/^\/blocks\/([^/]+)\/children$/)[1])); },
    async request(method, path, body) {
      requests.push({ method, path, body: structuredClone(body) });
      await api.beforeRequest?.(method, path, body);
      if (method === 'POST' && path === '/files/upload-url') { const name = `image/${randomUUID()}`; return { data: { oss_name: name, upload_url: `https://upload.cos.myqcloud.com/${encodeURIComponent(name)}`, headers: {} } }; }
      if (method === 'POST' && path === '/pages') {
        const page = addPage(randomUUID(), body.parent.page_id, plainText(body.properties.title.title));
        for (const child of body.children || []) put({ ...child, id: randomUUID() }, page.id);
        return { data: structuredClone(page) };
      }
      const markdown = path.match(/^\/pages\/([^/]+)\/content\/markdown$/);
      if (markdown) return { data: { markdown: children(markdown[1]).filter(b => b.type === 'file').map(b => `[file](https://cdn2.flowus.cn/${encodeURIComponent(b.file.file.oss_name)}?token=test-only)`).join('\n') } };
      const append = path.match(/^\/blocks\/([^/]+)\/children$/);
      if (append && method === 'PATCH') return { data: { results: body.children.map(child => structuredClone(put({ ...child, id: randomUUID() }, append[1]))) } };
      const one = path.match(/^\/(?:blocks|pages)\/([^/]+)$/);
      if (one && method === 'DELETE') return { data: structuredClone(put({ ...blocks.get(one[1]), in_trash: true })) };
      if (one && method === 'GET') return { data: structuredClone(blocks.get(one[1])) };
      if (one && method === 'PATCH') return { data: structuredClone(put({ ...blocks.get(one[1]), ...body })) };
      throw new Error(`未模拟接口：${method} ${path}`);
    },
  };
  async function fetchImpl(input, options = {}) {
    const name = decodeURIComponent(new URL(input).pathname.slice(1)); transfers.push({ name, method: options.method || 'GET' });
    if (options.method === 'PUT') { objects.set(name, Buffer.from(options.body)); return new Response('', { status: 200 }); }
    return objects.has(name) ? new Response(objects.get(name), { status: 200 }) : new Response('', { status: 404 });
  }
  const service = (gcOptions) => new Canvases(api, { rootId: n.root, uploadPageId: n.upload, nativeRootId: n.settingsPage, fetchImpl, gcOptions });
  return { ids: n, api, blocks, objects, requests, transfers, service, children, put, addCode, fetchImpl };
}

/** 创建仅驻留内存的图片场景；输入文件ID，输出带独立字节的测试场景。 */
function imageScene(fileId = 'f') {
  const bytes = Buffer.from(`gc fixture ${fileId}`);
  return { elements: [{ id: `img-${fileId}`, type: 'image', fileId }], appState: {}, files: { [fileId]: { id: fileId, mimeType: 'image/png', dataURL: `data:image/png;base64,${bytes.toString('base64')}`, created: 1 } } };
}

/** 真正走保存链路生成已登记图片，再成功保存移除；返回可控制时钟的隔离仓库。 */
async function unusedFixture({ graceMs = 1000, scanIntervalMs = 100, batchLimit = 10 } = {}) {
  const f = folderNativeFixture(); let time = 10000;
  const options = { now: () => time, graceMs, scanIntervalMs, batchLimit };
  const store = f.service(options), original = (await store.load('review')).canvas;
  const scene = imageScene(), withImage = (await store.save('review', { revision: original.revision, scene })).canvas;
  const doc = nativeDocument(f.blocks.get(f.ids.scene)), assetId = doc.assets.f.blockId;
  const removed = (await store.save('review', { revision: withImage.revision, scene: emptyScene() })).canvas;
  return { ...f, store, options, assetId, scene, removed, advance: delta => { time += delta; }, metadata: () => store.gc.metadata(f.blocks.get(assetId)), deleted: () => f.requests.filter(r => r.method === 'DELETE') };
}

test('默认宽限24小时；活跃引用忽略tombstone及files残留，损坏引用拒绝回收', () => {
  assert.equal(GC_GRACE_MS, 86400000);
  const doc = { scene: { elements: [{ type: 'image', fileId: 'live' }, { type: 'image', fileId: 'deleted', isDeleted: true }], files: { stale: {} } }, assets: { live: { blockId: id(90) } } };
  assert.deepEqual([...activeFileIds(doc)], ['live']);
  assert.throws(() => activeFileIds({ ...doc, assets: {} }), { status: 409 });
  assert.throws(() => activeFileIds({ ...doc, scene: { elements: [null] } }), { status: 409 });
});

test('仅持久化成功后登记候选，宽限未满不删；跨实例恢复同caption后软删', async () => {
  const f = await unusedFixture();
  assert.equal(f.metadata().committed, true); assert.ok(f.metadata().gc); assert.equal(f.deleted().length, 0);
  f.advance(200); await f.store.collectGarbage();
  assert.equal(f.deleted().length, 0); assert.ok(f.metadata().gc.scans >= 2);
  f.advance(1000); const restarted = f.service(f.options), result = await restarted.collectGarbage();
  assert.equal(result.trashed, 1); assert.equal(f.deleted().length, 1);
  assert.equal(f.deleted()[0].path, `/blocks/${f.assetId}`); assert.equal(f.blocks.get(f.assetId).in_trash, true);
  assert.equal((await restarted.load('review')).canvas.scene.elements.length, 0);
  assert.equal(f.requests.filter(r => r.path === '/files/upload-url').length, 1);
});

test('短间隔不累计稳定扫描；其它绘图改动保留firstSeenAt但重置scans', async () => {
  const f = await unusedFixture(); const firstSeen = f.metadata().gc.firstSeenAt;
  await f.store.collectGarbage(); assert.equal(f.metadata().gc.scans, 1);
  f.advance(200);
  const before = (await f.store.load('review')).canvas;
  await f.store.save('review', { revision: before.revision, scene: textScene('正常继续编辑') });
  assert.equal(f.metadata().gc.firstSeenAt, firstSeen); assert.equal(f.metadata().gc.scans, 1);
  f.advance(1000); await f.store.collectGarbage(); assert.equal(f.deleted().length, 1);
});

test('宽限内撤销恢复活跃图片清候选，重启和过期扫描均不能删', async () => {
  const f = await unusedFixture(); f.advance(200);
  const before = (await f.store.load('review')).canvas;
  await f.store.save('review', { revision: before.revision, scene: f.scene });
  assert.equal(f.metadata().gc, undefined);
  f.advance(10000); await f.service(f.options).collectGarbage();
  assert.equal(f.deleted().length, 0); assert.equal((await f.store.load('review')).canvas.scene.elements[0].fileId, 'f');
});

test('失败保存不候选；未提交的新图片和手工附件永不自动认领', async () => {
  const f = folderNativeFixture(), store = f.service({ now: () => 100000, graceMs: 0, scanIntervalMs: 0 });
  const before = (await store.load('review')).canvas;
  f.api.beforeRequest = (method, path) => { if (method === 'PATCH' && path === `/blocks/${f.ids.scene}`) throw new Error('模拟提交失败'); };
  await assert.rejects(store.save('review', { revision: before.revision, scene: imageScene() }), /模拟提交失败/);
  f.api.beforeRequest = undefined;
  const orphan = f.children(f.ids.folder).find(block => block.type === 'file'); assert.equal(store.gc.metadata(orphan).committed, false);
  const manual = id(91); f.put({ id: manual, type: 'file', file: { type: 'file', file: { oss_name: 'manual.png', content_type: 'image/png' }, caption: [{ text: { content: '用户手动附件' } }] } }, f.ids.folder);
  await store.collectGarbage(); await store.collectGarbage();
  assert.equal(f.requests.filter(r => r.method === 'DELETE').length, 0); assert.equal(store.gc.metadata(f.blocks.get(orphan.id)).gc, undefined);
  assert.equal(store.gc.metadata(f.blocks.get(manual)), null);
});

test('任一其它场景读取失败则整轮fail closed，不删除本画布候选', async () => {
  const f = await unusedFixture(); const other = (await f.store.create({ slug: 'other', title: '另一图' })).canvas;
  const ref = nativeDocument(f.blocks.get(f.ids.registry)).canvases[other.slug];
  f.api.beforeRequest = (method, path) => { if (method === 'GET' && path === `/blocks/${ref.blockId}`) throw new Error('网络失败'); };
  f.advance(2000); await assert.rejects(f.store.collectGarbage(), /网络失败/); assert.equal(f.deleted().length, 0);
});

test('跨folder引用保守跳过；原生JSON/备份/手工文件不进入删除候选', async () => {
  const f = await unusedFixture(); await f.store.create({ slug: 'other', title: '另一图' });
  const ref = nativeDocument(f.blocks.get(f.ids.registry)).canvases.other;
  const otherDoc = nativeDocument(f.blocks.get(ref.blockId)); otherDoc.assets.foreign = { blockId: f.assetId, hash: f.metadata().hash };
  f.addCode(ref.blockId, ref.pageId, otherDoc);
  const backupId = id(92); f.put({ id: backupId, type: 'file', file: { type: 'file', file: { oss_name: 'old.json', content_type: 'application/json' }, caption: metaCaption({ kind: 'scene-backup', slug: 'review' }) } }, f.ids.folder);
  f.advance(2000); await f.store.collectGarbage(); assert.equal(f.deleted().length, 0);
  assert.equal(f.blocks.get(backupId).in_trash, undefined); assert.equal(f.blocks.get(f.ids.scene).in_trash, undefined);
});

test('候选文件改父目录/owner或真实内容哈希异常时拒绝删除', async t => {
  for (const kind of ['parent', 'owner', 'bytes', 'committed', 'mime']) await t.test(kind, async () => {
    const f = await unusedFixture(); const block = f.blocks.get(f.assetId);
    if (kind === 'parent') block.parent.page_id = id(999);
    if (kind === 'owner' || kind === 'committed') { const meta = f.metadata(); if (kind === 'owner') meta.ownerSlug = 'foreign'; else meta.committed = false; block.file.caption = metaCaption(meta); }
    if (kind === 'bytes') f.objects.set(block.file.file.oss_name, Buffer.from('外部损坏内容'));
    if (kind === 'mime') block.file.file.content_type = 'application/json';
    f.advance(2000); try { await f.store.collectGarbage(); } catch (error) { assert.ok([409, 413].includes(error.status)); }
    assert.equal(f.deleted().length, 0);
  });
});

test('保存与GC共享画布锁；删除前scene改变或恢复引用必须跳过', async () => {
  const f = await unusedFixture(); f.advance(2000);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const held = f.store.locked('canvas:review', () => gate);
  const run = f.store.collectGarbage(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.deleted().length, 0); release(); await held; await run;
  assert.equal(f.deleted().length, 1);
  const g = await unusedFixture(); g.advance(2000); let scans = 0;
  const references = g.store.gc.references.bind(g.store.gc);
  g.store.gc.references = async () => {
    if (++scans === 2) { const doc = nativeDocument(g.blocks.get(g.ids.scene)); doc.scene = g.scene; doc.assets = { f: { blockId: g.assetId, hash: g.metadata().hash } }; g.addCode(g.ids.scene, g.ids.page, doc); }
    return references();
  };
  await g.store.collectGarbage(); assert.equal(g.deleted().length, 0);
});

test('删除API失败保留候选可重试，同次后台调用合并且每批有限', async () => {
  const f = await unusedFixture(); f.advance(2000); let attempts = 0;
  f.api.beforeRequest = method => { if (method === 'DELETE' && ++attempts === 1) throw new Error('FlowUs暂不可用'); };
  await assert.rejects(f.store.collectGarbage(), /FlowUs暂不可用/); assert.ok(f.metadata().gc); assert.equal(f.blocks.get(f.assetId).in_trash, undefined);
  const [a, b] = await Promise.all([f.store.collectGarbage(), f.store.collectGarbage()]);
  assert.deepEqual(a, b); assert.equal(attempts, 2); assert.equal(f.blocks.get(f.assetId).in_trash, true);
  const g = await unusedFixture({ batchLimit: 1 }); g.advance(2000);
  await g.store.collectGarbage(); assert.ok(g.deleted().length <= 1);
});

test('用户caption片段保持原样，重复应用marker不认领', async () => {
  const f = await unusedFixture(); const block = f.blocks.get(f.assetId), userCaption = { type: 'text', text: { content: '用户注释必须保留' } };
  block.file.caption.unshift(userCaption); f.advance(200); await f.store.collectGarbage();
  assert.deepEqual(f.blocks.get(f.assetId).file.caption[0], userCaption);
  const g = await unusedFixture(); g.blocks.get(g.assetId).file.caption.push(...metaCaption({ kind: 'asset', hash: g.metadata().hash }));
  g.advance(2000); await g.store.collectGarbage(); assert.equal(g.deleted().length, 0);
});

test('合法缺失GET只读且给明确code，同slug两个并发创建仅一个成功', async () => {
  const f = folderNativeFixture(), store = f.service();
  await assert.rejects(store.load('confirm-create'), { status: 404, code: 'CANVAS_NOT_FOUND' });
  assert.equal(f.requests.filter(r => r.method !== 'GET').length, 0);
  const results = await Promise.allSettled([store.create({ slug: 'confirm-create', title: '第一位' }), store.create({ slug: 'confirm-create', title: '第二位' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  assert.equal((await store.load('confirm-create')).canvas.title, '第一位');
  assert.equal(f.requests.filter(r => r.method === 'PATCH' && r.path === `/blocks/${f.ids.root}/children`).length, 1);
});

test('旧未登记图片仅凭本folder备份映射及真实哈希认领，缺少证明保持原状', async () => {
  const f = await unusedFixture(); const meta = f.metadata();
  delete meta.ownerSlug; delete meta.ownerFolderId; delete meta.committed; delete meta.gc; delete meta.mimeType;
  delete f.blocks.get(f.assetId).file.file.content_type;
  f.blocks.get(f.assetId).file.caption = metaCaption(meta); f.advance(2000);
  await f.store.collectGarbage(); assert.equal(f.metadata().ownerSlug, undefined); assert.equal(f.deleted().length, 0);
  const backupId = id(93), name = 'migration/backup.json';
  const bytes = Buffer.from(JSON.stringify({ slug: 'review', assets: { f: { blockId: f.assetId, hash: meta.hash, mimeType: 'image/png' } } }));
  f.objects.set(name, bytes);
  f.put({ id: backupId, type: 'file', file: { type: 'file', file: { oss_name: name, content_type: 'application/json', size: bytes.length }, caption: metaCaption({ kind: 'scene-backup', slug: 'review', nativeBlockId: f.ids.scene }) } }, f.ids.folder);
  const doc = nativeDocument(f.blocks.get(f.ids.scene)); doc.legacyBackupFileId = backupId; f.addCode(f.ids.scene, f.ids.page, doc);
  await f.store.collectGarbage(); assert.equal(f.metadata().ownerSlug, 'review'); assert.equal(f.metadata().committed, true); assert.ok(f.metadata().gc);
  f.advance(2000); await f.store.collectGarbage(); assert.equal(f.deleted().length, 1); assert.equal(f.blocks.get(backupId).in_trash, undefined);
});

test('官方file省略content_type时，从已校验scene登记MIME并完成软删；非图及冲突MIME不删', async () => {
  const f = folderNativeFixture(); let time = 10000;
  const store = f.service({ now: () => time, graceMs: 1000, scanIntervalMs: 100 });
  f.api.beforeRequest = (method, path, body) => {
    if (method === 'PATCH' && path.endsWith('/children')) for (const child of body.children || []) if (child.type === 'file') delete child.file.file.content_type; // 官方回读仅保留oss_name/size。
  };
  const before = (await store.load('review')).canvas;
  const saved = (await store.save('review', { revision: before.revision, scene: imageScene() })).canvas;
  const assetId = nativeDocument(f.blocks.get(f.ids.scene)).assets.f.blockId;
  assert.equal(f.blocks.get(assetId).file.file.content_type, undefined);
  assert.equal(store.gc.metadata(f.blocks.get(assetId)).mimeType, 'image/png');
  await store.save('review', { revision: saved.revision, scene: emptyScene() });
  assert.ok(store.gc.metadata(f.blocks.get(assetId)).gc);
  time += 2000; await store.collectGarbage(); assert.equal(f.blocks.get(assetId).in_trash, true);
  for (const kind of ['non-image', 'mismatch']) {
    const g = await unusedFixture(); const block = g.blocks.get(g.assetId), meta = g.metadata();
    if (kind === 'non-image') { delete block.file.file.content_type; meta.mimeType = 'application/json'; block.file.caption = metaCaption(meta); }
    else block.file.file.content_type = 'image/jpeg';
    g.advance(2000); await g.store.collectGarbage(); assert.equal(g.deleted().length, 0, kind);
  }
});

test('已committed旧caption缺少MIME时，重新校验活跃scene后补登记而不猜文件扩展名', async () => {
  const f = folderNativeFixture(), store = f.service(); const before = (await store.load('review')).canvas;
  await store.save('review', { revision: before.revision, scene: imageScene() });
  const assetId = nativeDocument(f.blocks.get(f.ids.scene)).assets.f.blockId, block = f.blocks.get(assetId), meta = store.gc.metadata(block);
  delete meta.mimeType; delete block.file.file.content_type; block.file.caption = metaCaption(meta);
  await f.service().collectGarbage();
  assert.equal(store.gc.metadata(f.blocks.get(assetId)).mimeType, 'image/png');
  assert.equal(f.requests.filter(r => r.method === 'DELETE').length, 0);
});


test('旧settings只读补GC默认；partial autoSave更新保留回收字段并同块持久化中文说明', async () => {
  const f=folderNativeFixture(),store=f.service();
  const initial=await store.settings();assert.equal(initial.settings.assetGcEnabled,true);assert.equal(initial.settings.assetGcGraceHours,24);
  assert.equal(f.requests.filter(r=>r.method!=='GET').length,0);
  const configured=await store.settings({revision:initial.revision,settings:{assetGcEnabled:false,assetGcGraceHours:0.5}});
  await store.settings({revision:configured.revision,settings:{autoSave:false}});
  const persisted=(await f.service().settings()).settings;assert.deepEqual(persisted,{autoSave:false,assetGcEnabled:false,assetGcGraceHours:0.5,failedTaskRetentionHours:168});
  const doc=nativeDocument(f.blocks.get(f.ids.settings));assert.match(doc.settingsHelp.assetGcGraceHours,/0–8760/);
  assert.ok(f.requests.filter(r=>r.method==='PATCH').every(r=>r.path===`/blocks/${f.ids.settings}`));
  assert.equal(f.requests.filter(r=>r.path==='/files/upload-url').length,0);
});

test('GC开关关闭使run和observe零候选写零删除，候选时间保留；重新开启使用原时间', async () => {
  const f=await unusedFixture();let settings=await f.store.settings();
  settings=await f.store.settings({revision:settings.revision,settings:{assetGcEnabled:false}});
  const candidate=structuredClone(f.metadata().gc);f.advance(10000);const before=f.requests.length;
  assert.deepEqual(await f.store.collectGarbage(),{marked:0,trashed:0});
  assert.deepEqual(await f.store.gc.observe('review'),{marked:0,trashed:0});
  assert.equal(f.requests.slice(before).filter(r=>r.method!=='GET').length,0);assert.deepEqual(f.metadata().gc,candidate);
  await f.store.settings({revision:settings.revision,settings:{assetGcEnabled:true}});
  await f.store.collectGarbage();assert.equal(f.deleted().length,1);
});

test('动态宽限从一小时改0于下一扫描生效，零小时仍需要两次扫描', async () => {
  const f=await unusedFixture();const store=f.service({now:f.options.now,scanIntervalMs:100});
  let settings=await store.settings();settings=await store.settings({revision:settings.revision,settings:{assetGcGraceHours:1}});
  f.advance(2000);await store.collectGarbage();assert.equal(f.deleted().length,0);const firstSeen=f.metadata().gc.firstSeenAt;
  await store.settings({revision:settings.revision,settings:{assetGcGraceHours:0}});
  f.advance(200);await store.collectGarbage();assert.equal(f.deleted().length,1);assert.equal(firstSeen,10000);
});

test('GC字段非法或读取失败时零回收；非法设置更新在PATCH前拒绝', async () => {
  const f=await unusedFixture();let settings=await f.store.settings();
  for(const value of [-1,8761,Infinity,NaN,'24',null])await assert.rejects(f.store.settings({revision:settings.revision,settings:{assetGcGraceHours:value}}),{status:400});
  for(const value of [0,'false',null])await assert.rejects(f.store.settings({revision:settings.revision,settings:{assetGcEnabled:value}}),{status:400});
  const doc=nativeDocument(f.blocks.get(f.ids.settings));doc.settings.assetGcGraceHours=-1;f.addCode(f.ids.settings,f.ids.settingsPage,doc);
  const before=f.requests.length;f.advance(10000);await assert.rejects(f.store.collectGarbage(),{status:409});
  assert.equal(f.requests.slice(before).filter(r=>r.method!=='GET').length,0);
  doc.settings.assetGcGraceHours=24;f.addCode(f.ids.settings,f.ids.settingsPage,doc);
  f.api.beforeRequest=(method,path)=>{if(method==='GET'&&path===`/blocks/${f.ids.settingsPage}/children`)throw Error('settings offline');};
  const all=f.api.all;f.api.all=async(method,path)=>{if(path===`/blocks/${f.ids.settingsPage}/children`)throw Error('settings offline');return all(method,path);};
  await assert.rejects(f.store.collectGarbage(),/settings offline/);assert.equal(f.deleted().length,0);
});

test('首扫后在候选PATCH前关闭须零候选写；DELETE前关闭或加长宽限须零删除', async () => {
  const f=await unusedFixture();const block=f.blocks.get(f.assetId),meta=f.metadata();delete meta.gc;block.file.caption=metaCaption(meta);
  const original=f.store.gc.policy.bind(f.store.gc);let reads=0;
  f.store.gc.policy=async()=>{if(++reads===2){const doc=nativeDocument(f.blocks.get(f.ids.settings));doc.settings.assetGcEnabled=false;f.addCode(f.ids.settings,f.ids.settingsPage,doc);}return original();};
  const before=f.requests.length;await f.store.gc.observe('review');assert.equal(f.metadata().gc,undefined);assert.equal(f.requests.slice(before).filter(r=>r.method==='PATCH').length,0);
  for(const change of ['disable','extend']){
    const g=await unusedFixture();const store=g.service({now:g.options.now,scanIntervalMs:100});let s=await store.settings();await store.settings({revision:s.revision,settings:{assetGcGraceHours:0}});g.advance(10000);
    const readPolicy=store.gc.policy.bind(store.gc);let calls=0;const candidate=structuredClone(g.metadata().gc);
    store.gc.policy=async()=>{if(++calls===2){const doc=nativeDocument(g.blocks.get(g.ids.settings));if(change==='disable')doc.settings.assetGcEnabled=false;else doc.settings.assetGcGraceHours=24;g.addCode(g.ids.settings,g.ids.settingsPage,doc);}return readPolicy();};
    await store.gc.observe('review');assert.equal(g.deleted().length,0);assert.equal(g.metadata().gc.firstSeenAt,candidate.firstSeenAt);
  }
});

test('后台readEntry期间关闭，补登记owner也须零PATCH；正常保存的归属登记独立保留', async () => {
  const f=folderNativeFixture(),store=f.service();const initial=(await store.load('review')).canvas;
  await store.save('review',{revision:initial.revision,scene:imageScene()});
  const asset=f.children(f.ids.folder).find(b=>b.type==='file'),meta=store.gc.metadata(asset);delete meta.committed;asset.file.caption=metaCaption(meta);
  const read=store.readEntry.bind(store);store.readEntry=async(entry)=>{const validated=await read(entry);const doc=nativeDocument(f.blocks.get(f.ids.settings));doc.settings.assetGcEnabled=false;f.addCode(f.ids.settings,f.ids.settingsPage,doc);return validated;};
  const before=f.requests.length;await store.collectGarbage();assert.equal(f.requests.slice(before).filter(r=>r.method!=='GET').length,0);
  assert.equal(store.gc.metadata(f.blocks.get(asset.id)).committed,undefined);
});
