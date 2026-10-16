import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NativeDocuments, NATIVE_LIMIT, nativeContent, nativeDocument, blockVersion, plainText } from '../server/native.mjs';
import { Canvases } from '../server/storage.mjs';
import { migrateNative } from '../ops/migrate-native.mjs';

const blockId = '20000000-0000-4000-8000-000000000001';
const document = text => ({ schemaVersion: 2, kind: 'scene', slug: 'native-review', scene: { text } });

/** 模拟一个可原位更新的代码块；输入初始JSON，输出API及请求记录，不连接FlowUs。 */
function nativeBlockFixture(initial = document('初始')) {
  let block = { id: blockId, last_edited_time: 'v1', ...nativeContent(initial) }; let clock = 1;
  const requests = []; const control = {};
  const api = {
    async request(method, path, body) {
      requests.push({ method, path, body: structuredClone(body) });
      assert.equal(path, `/blocks/${blockId}`);
      if (method === 'PATCH') {
        block = { ...block, ...structuredClone(body), last_edited_time: `v${++clock}` };
        control.afterPatch?.(block); // 只用于模拟异常上游回读。
      }
      return { data: structuredClone(block) };
    },
  };
  return { api, requests, control, read: () => structuredClone(block), native: new NativeDocuments(api) };
}

test('1 MiB完整JSON分段在单块中回读，中文及emoji不截断', () => {
  const doc = document('中文😀');
  doc.scene.text += 'a'.repeat(NATIVE_LIMIT - Buffer.byteLength(JSON.stringify(doc)));
  assert.equal(Buffer.byteLength(JSON.stringify(doc)), NATIVE_LIMIT);
  const content = nativeContent(doc);
  assert.ok(content.code.rich_text.length > 1);
  assert.ok(content.code.rich_text.every(value => Array.from(value.text.content).length <= 1800));
  assert.equal(Buffer.byteLength(plainText(content.code.rich_text)), NATIVE_LIMIT);
  assert.deepEqual(nativeDocument(content), doc);
  doc.scene.text += 'a';
  assert.throws(() => nativeContent(doc), { status: 413 });
});

test('原生块拒绝错误类型、损坏JSON及超过配置上限的内容', () => {
  assert.throws(() => nativeDocument({ type: 'file' }), { status: 409 });
  assert.throws(() => nativeDocument({ type: 'code', code: { rich_text: [{ text: { content: '{' } }] } }), { status: 409 });
  assert.throws(() => nativeDocument(nativeContent(document('内容')), 4), { status: 409 });
});

test('连续两次保存原位PATCH同一block，过期版本和超限在写前拒绝', async () => {
  const f = nativeBlockFixture(); const initial = f.read();
  const first = await f.native.write(initial, document('第一版'), blockVersion(initial));
  const second = await f.native.write(first, document('第二版'), blockVersion(first));
  assert.equal(first.id, blockId); assert.equal(second.id, blockId);
  assert.equal(nativeDocument(second).scene.text, '第二版');
  assert.equal(f.requests.filter(r => r.method === 'PATCH').length, 2);
  assert.ok(f.requests.every(r => r.path === `/blocks/${blockId}`));
  await assert.rejects(f.native.write(initial, document('旧版覆盖'), blockVersion(initial)), { status: 409 });
  const count = f.requests.length;
  await assert.rejects(f.native.write(second, document('a'.repeat(NATIVE_LIMIT))), { status: 413 });
  assert.equal(f.requests.length, count);
  assert.equal(f.requests.filter(r => r.method === 'PATCH').length, 2);
  assert.equal(nativeDocument(f.read()).scene.text, '第二版');
});

test('上游异常截断会明确报冲突，不假报保存成功', async () => {
  const f = nativeBlockFixture(); const before = f.read();
  f.control.afterPatch = block => { block.code.rich_text[0].text.content = '{}'; };
  await assert.rejects(f.native.write(before, document('待校验')), { status: 409 });
});

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
  const service = () => new Canvases(api, { rootId: n.root, uploadPageId: n.upload, nativeRootId: n.settingsPage, fetchImpl });
  return { ids: n, api, blocks, objects, requests, transfers, service, children, put, addCode, fetchImpl };
}

test('原生scene、改标题和settings均更新固定block，不申请uploadURL', async () => {
  const f = folderNativeFixture(), store = f.service(), first = (await store.load('review')).canvas;
  const second = (await store.save('review', { revision: first.revision, scene: textScene('第一版') })).canvas;
  const third = (await store.save('review', { revision: second.revision, scene: textScene('第二版') })).canvas;
  const renamed = (await store.save('review', { revision: third.revision, title: '新标题' })).canvas;
  const settings = await store.settings(); await store.settings({ revision: settings.revision, settings: { autoSave: false } });
  assert.equal(renamed.slug, 'review'); assert.deepEqual(renamed.scene, third.scene);
  assert.equal(f.blocks.get(f.ids.folder).folder.title, '新标题');
  assert.equal(f.blocks.get(f.ids.page).parent.page_id, f.ids.folder);
  assert.equal(f.blocks.get(f.ids.page).child_page.title, 'JSON 数据');
  assert.equal(f.requests.filter(r => r.method === 'PATCH' && r.path === `/blocks/${f.ids.scene}`).length, 3);
  assert.equal(f.requests.filter(r => r.path === '/files/upload-url').length, 0);
  assert.equal([...f.blocks.values()].filter(b => b.type === 'file').length, 0);
  assert.equal((await f.service().load('review')).canvas.scene.elements[0].text, '第二版');
  assert.equal((await f.service().settings()).settings.autoSave, false);
  await assert.rejects(store.save('review', { revision: first.revision, scene: textScene('过期') }), { status: 409 });
});

test('原生创建保留真实附件folder，JSON page与图片同级且0 JSON上传', async () => {
  const f = folderNativeFixture(), store = f.service(); const created = (await store.create({ slug: 'new-canvas', title: '新画布' })).canvas;
  assert.equal(created.slug, 'new-canvas');
  const registry = nativeDocument(f.blocks.get(f.ids.registry)), ref = registry.canvases['new-canvas'];
  assert.equal(f.blocks.get(ref.folderId).type, 'folder');
  assert.equal(f.blocks.get(ref.folderId).parent.page_id, f.ids.root);
  assert.equal(f.blocks.get(ref.pageId).parent.page_id, ref.folderId);
  assert.equal(f.blocks.get(ref.blockId).parent.page_id, ref.pageId);
  assert.equal(f.requests.filter(r => r.path === '/files/upload-url').length, 0);
});

test('只新增图片可上传，附件留原folder，后续保存和重启读取复用原hash', async () => {
  const f = folderNativeFixture(), store = f.service(), before = (await store.load('review')).canvas;
  const bytes = Buffer.from('native image fixture');
  const scene = { elements: [{ id: 'img', type: 'image', fileId: 'f' }], appState: {}, files: { f: { id: 'f', mimeType: 'image/png', dataURL: `data:image/png;base64,${bytes.toString('base64')}`, created: 123 } } };
  const saved = (await store.save('review', { revision: before.revision, scene })).canvas;
  const files = f.children(f.ids.folder).filter(b => b.type === 'file');
  assert.equal(files.length, 1); assert.equal(files[0].file.file.content_type, 'image/png');
  assert.equal(f.requests.filter(r => r.path === '/files/upload-url').length, 1);
  assert.equal(f.requests.find(r => r.path === '/files/upload-url').body.parent.page_id, f.ids.folder);
  const doc = nativeDocument(f.blocks.get(f.ids.scene)); assert.deepEqual(doc.scene.files, {}); assert.equal(doc.assets.f.blockId, files[0].id);
  await store.save('review', { revision: saved.revision, title: '带图片' });
  assert.equal(f.requests.filter(r => r.path === '/files/upload-url').length, 1);
  assert.deepEqual((await f.service().load('review')).canvas.scene, scene);
});

test('staging registry封闭读写，不暴露半迁移内容', async () => {
  const f = folderNativeFixture({ state: 'staging' }), store = f.service();
  await assert.rejects(store.list(), { status: 503 }); await assert.rejects(store.load('review'), { status: 503 });
  await assert.rejects(store.settings(), { status: 503 }); await assert.rejects(store.create({ slug: 'blocked', title: '不得创建' }), { status: 503 });
  assert.equal(f.requests.filter(r => r.method !== 'GET').length, 0);
});

test('原生预览按revision失效，页面或folder移出边界不返回场景', async () => {
  const f = folderNativeFixture(), store = f.service(), listed = (await store.list()).canvases[0];
  const [a, b] = await Promise.all([store.preview('review', listed.revision), store.preview('review', listed.revision)]); assert.deepEqual(a, b);
  const fresh = (await store.save('review', { revision: listed.revision, scene: textScene('新预览') })).canvas;
  await assert.rejects(store.preview('review', listed.revision), { status: 409 });
  await store.list(); assert.equal((await store.preview('review', fresh.revision)).canvas.scene.elements[0].text, '新预览');
  f.blocks.get(f.ids.page).parent.page_id = id(999);
  await assert.rejects(store.load('review'), { status: 409 });
  f.blocks.get(f.ids.page).parent.page_id = f.ids.folder; f.blocks.get(f.ids.folder).parent.page_id = id(999);
  await assert.rejects(store.load('review'), { status: 409 });
});

test('新图片metadata计入容量，超限时0上传且原生block保持原样', async () => {
  const f = folderNativeFixture(), store = f.service(), before = (await store.load('review')).canvas;
  store.native.maxBytes = 1024; const original = structuredClone(f.blocks.get(f.ids.scene));
  const scene = { elements: [{ id: 'i', type: 'image', fileId: 'f' }], appState: {}, files: { f: { id: 'f', mimeType: 'image/png', dataURL: 'data:image/png;base64,YQ==', metadata: 'a'.repeat(1100) } } };
  await assert.rejects(store.save('review', { revision: before.revision, scene }), { status: 413 });
  assert.equal(f.requests.filter(r => r.path === '/files/upload-url').length, 0); assert.deepEqual(f.blocks.get(f.ids.scene), original);
});

test('恢复未登记原生页使用最新输入，不复用失败迁移时的旧快照', async () => {
  const f = folderNativeFixture(); const registry = nativeDocument(f.blocks.get(f.ids.registry)); registry.state = 'staging'; registry.canvases = {}; f.addCode(f.ids.registry, f.ids.settingsPage, registry);
  const old = nativeDocument(f.blocks.get(f.ids.scene)), latest = { ...old, scene: textScene('即时最新源') };
  const entry = await f.service().native.create(latest);
  assert.equal(entry.page.id, f.ids.page); assert.equal(entry.block.id, f.ids.scene);
  assert.equal(nativeDocument(f.blocks.get(f.ids.scene)).scene.elements[0].text, '即时最新源');
  assert.equal(nativeDocument(f.blocks.get(f.ids.registry)).state, 'staging');
  assert.equal(f.requests.filter(r => r.method === 'POST' && r.path === '/pages').length, 0);
  assert.equal(f.requests.filter(r => r.path === '/files/upload-url').length, 0);
});

test('原生模式兼容读取未登记旧JSON，但任何保存不得回退JSON对象上传', async () => {
  const f = folderNativeFixture(), folderId = id(20), sceneId = id(21);
  const oldDoc = { schemaVersion: 1, slug: 'legacy', title: '旧格式', scene: textScene('旧内容'), assets: {}, uploadedBytes: 0 };
  const bytes = Buffer.from(JSON.stringify(oldDoc)); f.objects.set('legacy/scene.json', bytes);
  f.put({ id: folderId, type: 'folder', folder: { title: '旧格式' } }, f.ids.root);
  f.put({ id: sceneId, type: 'file', file: { type: 'file', file: { oss_name: 'legacy/scene.json', content_type: 'application/json', size: bytes.length }, caption: metaCaption({ kind: 'scene', slug: 'legacy', title: '旧格式' }) } }, folderId);
  const store = f.service(), old = (await store.load('legacy')).canvas;
  assert.equal(old.scene.elements[0].text, '旧内容');
  let failure;
  try { await store.save('legacy', { revision: old.revision, scene: textScene('不得写回OSS') }); } catch (error) { failure = error; }
  if (failure) assert.ok([409, 503].includes(failure.status)); // 可安全迁移，也可要求完成迁移后重试。
  assert.equal(f.requests.filter(r => r.path === '/files/upload-url').length, 0);
});

/** 给隔离fixture添加即时旧数据，测试迁移而非复用历史snapshot；返回旧文件块ID。 */
function addLegacyMigrationSource(f) {
  const doc = { schemaVersion: 1, slug: 'review', title: '即时原标题', scene: textScene('即时最新内容'), assets: {}, uploadedBytes: 0 };
  const sources = [
    { id: id(30), parent: f.ids.folder, name: 'migration/scene.json', document: doc, metadata: { kind: 'scene', slug: 'review', title: doc.title } },
    { id: id(31), parent: f.ids.root, name: 'migration/settings.json', document: { settings: { autoSave: false }, uploadedBytes: 0 }, metadata: { kind: 'settings' } },
  ];
  for (const source of sources) {
    const bytes = Buffer.from(JSON.stringify(source.document)); f.objects.set(source.name, bytes);
    f.put({ id: source.id, type: 'file', file: { type: 'file', file: { oss_name: source.name, size: bytes.length, content_type: 'application/json' }, caption: metaCaption(source.metadata) } }, source.parent);
  }
  return { sceneId: id(30), settingsId: id(31), document: doc };
}

test('完整迁移采用即时旧内容，ready后才标备份，重跑不增加页/文件或上传对象', async () => {
  const f = folderNativeFixture({ state: 'staging' }), source = addLegacyMigrationSource(f); const previousFetch = globalThis.fetch;
  globalThis.fetch = f.fetchImpl;
  try {
    const result = await migrateNative({ api: f.api, legacyRootId: f.ids.root, log: () => {} });
    assert.equal(result.nativeRootId, f.ids.settingsPage); assert.equal(result.canvasCount, 1); assert.equal(result.autoSave, false);
    assert.equal(nativeDocument(f.blocks.get(f.ids.registry)).state, 'ready');
    assert.deepEqual((await f.service().load('review')).canvas.scene, source.document.scene);
    assert.equal((await f.service().load('review')).canvas.title, source.document.title);
    const readyWrite = f.requests.findIndex(r => r.method === 'PATCH' && r.path === `/blocks/${f.ids.registry}` && r.body?.code && JSON.parse(plainText(r.body.code.rich_text)).state === 'ready');
    const backupWrite = f.requests.findIndex(r => r.method === 'PATCH' && r.path === `/blocks/${source.sceneId}`);
    assert.ok(readyWrite >= 0 && backupWrite > readyWrite);
    assert.equal(f.blocks.get(source.sceneId).file.file.oss_name, 'migration/scene.json');
    const count = f.blocks.size, patches = f.requests.filter(r => r.method === 'PATCH').length;
    const repeated = await migrateNative({ api: f.api, legacyRootId: f.ids.root, log: () => {} });
    assert.equal(repeated.resumedReady, true); assert.equal(f.blocks.size, count);
    assert.equal(f.requests.filter(r => r.method === 'PATCH').length, patches);
    assert.equal(f.requests.filter(r => r.path === '/files/upload-url').length, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('迁移中旧revision改变则保持staging，原文件不被标备份且0上传', async () => {
  const f = folderNativeFixture({ state: 'staging' }), source = addLegacyMigrationSource(f); const previousFetch = globalThis.fetch, original = f.api.request;
  f.api.request = async (method, path, body) => {
    const response = await original(method, path, body);
    if (method === 'PATCH' && path === `/blocks/${f.ids.scene}`) f.blocks.get(source.sceneId).last_edited_time = 'external-edit-during-migration';
    return response;
  };
  globalThis.fetch = f.fetchImpl;
  try {
    await assert.rejects(migrateNative({ api: f.api, legacyRootId: f.ids.root, log: () => {} }), { status: 409 });
    assert.equal(nativeDocument(f.blocks.get(f.ids.registry)).state, 'staging');
    assert.equal(f.requests.filter(r => r.method === 'PATCH' && r.path === `/blocks/${source.sceneId}`).length, 0);
    assert.equal(f.requests.filter(r => r.path === '/files/upload-url').length, 0);
  } finally { globalThis.fetch = previousFetch; }
});
