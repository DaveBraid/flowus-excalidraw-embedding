import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Canvases } from '../server/storage.mjs';

const rootId = '10000000-0000-4000-8000-000000000001';
const uploadPageId = '10000000-0000-4000-8000-000000000002';
const clone = value => structuredClone(value);
const scene = label => ({ elements: [{ id: 'text-a', type: 'text', text: label }], appState: { viewBackgroundColor: '#ffffff' }, files: {} });

/** 构造隔离的 FlowUs 文件系统；输入无，输出 API、对象存储与受控下载器。 */
function fixture() {
  const blocks = new Map([[rootId, { id: rootId, type: 'folder', folder: { title: '测试根' } }]]);
  const objects = new Map(); const requests = []; const transfers = []; const control = {}; let clock = 0;
  const touch = block => ({ ...block, last_edited_time: `revision-${++clock}` });
  const children = id => [...blocks.values()].filter(block => block.parent?.page_id === id);
  const api = {
    async all(method, path) {
      return clone(children(path.match(/^\/blocks\/([^/]+)\/children$/)[1]));
    },
    async request(method, path, body) {
      requests.push({ method, path, body: clone(body) });
      if (path === '/files/upload-url') {
        const name = `test/${randomUUID()}/${body.filename}`;
        return { data: { upload_url: `https://upload.cos.myqcloud.com/${encodeURIComponent(name)}`, oss_name: name, headers: {} } };
      }
      const markdown = path.match(/^\/pages\/([^/]+)\/content\/markdown$/);
      if (markdown) return { data: { markdown: children(markdown[1]).filter(b => b.type === 'file').map(b => `[file](https://cdn2.flowus.cn/${encodeURIComponent(b.file.file.oss_name)}?token=test-only)`).join('\n') } };
      const list = path.match(/^\/blocks\/([^/]+)\/children$/);
      if (list && method === 'PATCH') {
        const results = body.children.map(input => {
          const block = touch({ ...clone(input), id: randomUUID(), parent: { type: 'page_id', page_id: list[1] } });
          blocks.set(block.id, block); return block;
        });
        return { data: { results: clone(results) } };
      }
      const one = path.match(/^\/blocks\/([^/]+)$/);
      if (one && method === 'GET') return { data: clone(blocks.get(one[1])) };
      if (one && method === 'PATCH') {
        const block = touch({ ...blocks.get(one[1]), ...clone(body) }); blocks.set(block.id, block); return { data: clone(block) };
      }
      throw new Error(`未模拟接口：${method} ${path}`);
    },
  };
  async function fetchImpl(input, options = {}) {
    const url = new URL(input); const name = decodeURIComponent(url.pathname.slice(1));
    transfers.push({ host: url.hostname, name, method: options.method || 'GET', redirect: options.redirect, referer: options.headers?.Referer });
    if (options.method === 'PUT') {
      if (control.failPut) return new Response('', { status: 503 }); // 模拟上传失败，检查旧指针是否保持有效。
      objects.set(name, Buffer.from(options.body)); control.onPut?.(); return new Response('', { status: 200 });
    }
    if (!objects.has(name)) return new Response('', { status: 404 });
    return new Response(objects.get(name), { status: 200 });
  }
  const repository = () => new Canvases(api, { rootId, uploadPageId, fetchImpl });
  return { api, blocks, objects, requests, transfers, repository, children, control };
}

test('创建真实 folder 与独立 JSON；读取首帧不上传', async () => {
  const f = fixture(), store = f.repository();
  const { canvas } = await store.create({ title: '测试画布', slug: 'review' });
  const folder = f.children(rootId)[0];
  assert.equal(folder.type, 'folder');
  assert.equal(folder.folder.title, '测试画布');
  assert.equal(f.children(folder.id).filter(b => b.type === 'file').length, 1);
  const uploads = f.transfers.filter(t => t.method === 'PUT').length;
  assert.deepEqual((await store.load('review')).canvas.scene, canvas.scene);
  assert.equal(f.transfers.filter(t => t.method === 'PUT').length, uploads);
  assert.ok(f.transfers.filter(t => t.method === 'GET').every(t => t.host === 'cdn2.flowus.cn' && t.redirect === 'error' && t.referer === 'https://flowus.cn/'));
});

test('同一 slug 并发创建仅成功一次', async () => {
  const f = fixture(), store = f.repository();
  const outcomes = await Promise.allSettled([store.create({ title: '甲', slug: 'same' }), store.create({ title: '乙', slug: 'same' })]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(o => o.status === 'rejected').reason.status, 409);
  assert.equal(f.children(rootId).filter(b => b.type === 'folder').length, 1);
});

test('卡片预览复用列表索引，同版本并发合并且全程不上传', async () => {
  const f = fixture(), store = f.repository(), { canvas } = await store.create({ title: '预览', slug: 'review' });
  await store.list();
  const original = f.api.all; const scanned = [];
  f.api.all = async (method, path) => { scanned.push(path); return original(method, path); };
  const uploads = f.transfers.filter(t => t.method === 'PUT').length;
  const requests = f.requests.length;
  const [first, second] = await Promise.all([store.preview('review', canvas.revision), store.preview('review', canvas.revision)]);
  assert.deepEqual(first.canvas.scene, canvas.scene);
  assert.deepEqual(second, first);
  assert.ok(!scanned.includes(`/blocks/${rootId}/children`));
  assert.equal(f.requests.slice(requests).filter(r => r.method === 'GET' && /^\/blocks\//.test(r.path)).length, 2);
  assert.equal(f.transfers.filter(t => t.method === 'PUT').length, uploads);
  assert.equal(f.children(rootId).filter(b => b.type === 'file').length, 0); // 预览不初始化全局设置。
  assert.equal(store.previewPending.size, 0);
});

test('旧版本或移出授权根的卡片拒绝预览，不返回旧场景', async () => {
  const f = fixture(), store = f.repository(), { canvas } = await store.create({ title: '预览边界', slug: 'review' });
  await store.list();
  const folder = f.children(rootId)[0], block = f.children(folder.id)[0];
  f.blocks.get(block.id).last_edited_time = 'external-update';
  await assert.rejects(store.preview('review', canvas.revision), { status: 409 });
  const fresh = (await store.list()).canvases[0];
  f.blocks.get(folder.id).parent.page_id = 'another-root';
  await assert.rejects(store.preview('review', fresh.revision), { status: 404 });
  await assert.rejects(store.preview('review', ''), { status: 400 });
});

test('仅改标题保留已保存场景及固定 slug，旧版本仍拒绝覆盖', async () => {
  const f = fixture(), store = f.repository(), { canvas } = await store.create({ title: '原标题', slug: 'review' });
  const saved = (await store.save('review', { revision: canvas.revision, scene: scene('已保存内容') })).canvas;
  const renamed = (await store.save('review', { revision: saved.revision, title: '新标题' })).canvas;
  assert.equal(renamed.slug, 'review');
  assert.equal(renamed.title, '新标题');
  assert.deepEqual(renamed.scene, saved.scene);
  assert.notEqual(renamed.revision, saved.revision);
  assert.equal(f.children(rootId)[0].folder.title, '新标题');
  await assert.rejects(store.save('review', { revision: saved.revision, title: '过期标题' }), { status: 409 });
});

test('相同 revision 并发保存仅成功一次，旧 revision 不再分配对象', async () => {
  const f = fixture(), store = f.repository(), { canvas } = await store.create({ title: '测试', slug: 'review' });
  const outcomes = await Promise.allSettled([store.save('review', { revision: canvas.revision, scene: scene('甲') }), store.save('review', { revision: canvas.revision, scene: scene('乙') })]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(o => o.status === 'rejected').reason.status, 409);
  const uploads = f.transfers.filter(t => t.method === 'PUT').length;
  await assert.rejects(store.save('review', { revision: canvas.revision, scene: scene('覆盖') }), { status: 409 });
  assert.equal(f.transfers.filter(t => t.method === 'PUT').length, uploads);
  assert.equal((await store.load('review')).canvas.scene.elements[0].text, '甲');
});

test('图片单独挂载并校验哈希；新服务实例可完整恢复，无变更不上传', async () => {
  const f = fixture(), store = f.repository(), { canvas } = await store.create({ title: '图片测试', slug: 'review' });
  const image = Buffer.from('isolated image fixture');
  const imageScene = { elements: [{ id: 'image-a', type: 'image', fileId: 'file-a' }], appState: {}, files: { 'file-a': { id: 'file-a', mimeType: 'image/png', dataURL: `data:image/png;base64,${image.toString('base64')}`, created: 123 } } };
  const saved = (await store.save('review', { revision: canvas.revision, scene: imageScene })).canvas;
  const files = f.children(f.children(rootId)[0].id);
  assert.equal(files.length, 2);
  const document = JSON.parse(f.objects.get(files.find(b => b.file.file.content_type === 'application/json').file.file.oss_name));
  assert.deepEqual(document.scene.files, {});
  assert.equal(Object.keys(document.assets).length, 1);
  assert.deepEqual((await f.repository().load('review')).canvas.scene, imageScene);
  const uploads = f.transfers.filter(t => t.method === 'PUT').length;
  await store.save('review', { revision: saved.revision, scene: imageScene });
  assert.equal(f.transfers.filter(t => t.method === 'PUT').length, uploads);
  const asset = files.find(b => b.file.file.content_type === 'image/png');
  f.objects.set(asset.file.file.oss_name, Buffer.from('corrupted'));
  await assert.rejects(f.repository().load('review'), { status: 409 });
});

test('全局偏好默认开启，更新可跨实例读取，旧版本返回409', async () => {
  const f = fixture(), store = f.repository(), initial = await store.settings();
  assert.equal(initial.settings.autoSave, true);
  const updated = await store.settings({ revision: initial.revision, settings: { autoSave: false } });
  assert.equal(updated.settings.autoSave, false);
  assert.equal((await f.repository().settings()).settings.autoSave, false);
  await assert.rejects(store.settings({ revision: initial.revision, settings: { autoSave: true } }), { status: 409 });
  assert.equal(f.children(rootId).filter(b => b.type === 'file').length, 1);
});

test('上传失败或上传期间远端版本变化，都不替换原场景指针', async () => {
  const f = fixture(), store = f.repository(), { canvas } = await store.create({ title: '失败恢复测试', slug: 'review' });
  const folder = f.children(rootId)[0], block = f.children(folder.id)[0], originalKey = block.file.file.oss_name;
  f.control.failPut = true;
  await assert.rejects(store.save('review', { revision: canvas.revision, scene: scene('失败内容') }), { status: 502 });
  assert.equal(f.blocks.get(block.id).file.file.oss_name, originalKey);
  assert.deepEqual((await store.load('review')).canvas.scene, canvas.scene);
  f.control.failPut = false;
  f.control.onPut = () => { f.blocks.get(block.id).last_edited_time = 'external-update'; };
  await assert.rejects(store.save('review', { revision: canvas.revision, scene: scene('冲突内容') }), { status: 409 });
  assert.equal(f.blocks.get(block.id).file.file.oss_name, originalKey);
});

test('拒绝外域签名与相似对象路径，拒绝远程图片且不上传', async () => {
  const f = fixture(), store = f.repository(), { canvas } = await store.create({ title: '安全测试', slug: 'review' });
  const uploads = f.transfers.filter(t => t.method === 'PUT').length;
  await assert.rejects(store.save('review', { revision: canvas.revision, scene: { elements: [{ id: 'a', type: 'image', fileId: 'f' }], appState: {}, files: { f: { mimeType: 'image/png', dataURL: 'http://127.0.0.1/private' } } } }), { status: 400 });
  assert.equal(f.transfers.filter(t => t.method === 'PUT').length, uploads);
  const original = f.api.request;
  f.api.request = async (method, path, body) => path.includes('/content/markdown') ? { data: { markdown: '[bad](https://127.0.0.1/private?token=bad)\n[similar](https://cdn2.flowus.cn/not-the-object?token=bad)' } } : original(method, path, body);
  const before = f.transfers.length;
  await assert.rejects(f.repository().load('review'), { status: 502 });
  assert.equal(f.transfers.length, before);
});
