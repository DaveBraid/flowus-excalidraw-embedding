import test from 'node:test';
import assert from 'node:assert/strict';
import { initNative } from '../ops/init-native.mjs';
import { folderNativeFixture } from './fixture.mjs';
import { NativeDocuments, nativeDocument } from '../server/native.mjs';

/** 构造空的专用文件夹；仅使用内存API，不访问用户FlowUs。 */
function emptyRoot() {
  const f = folderNativeFixture();
  for (const id of f.blocks.keys()) if (id !== f.ids.root) f.blocks.delete(id);
  return f;
}

test('空目录初始化后可创建原生画布，重跑不修改任何内容', async () => {
  const f = emptyRoot();
  const result = await initNative({ api: f.api, rootId: f.ids.root });
  const native = new NativeDocuments(f.api, { rootId: result.nativeRootId, legacyRootId: f.ids.root });
  assert.equal((await native.registry()).document.state, 'ready');
  assert.equal((await native.settings()).settings.assetGcGraceHours, 24);
  const settings = f.children(result.nativeRootId).map(b => nativeDocument(b)).find(d => d.kind === 'settings');
  assert.match(settings.settingsHelp.assetGcEnabled, /回收/);
  const count = f.requests.filter(r => r.method !== 'GET').length;
  assert.deepEqual(await initNative({ api: f.api, rootId: f.ids.root }), result);
  assert.equal(f.requests.filter(r => r.method !== 'GET').length, count);
  // 使用初始化产物真实走创建协议，覆盖索引、场景页和附件目录的兼容性。
  const { Canvases } = await import('../server/storage.mjs');
  const store = new Canvases(f.api, { rootId: f.ids.root, uploadPageId: f.ids.root, nativeRootId: result.nativeRootId, fetchImpl: f.fetchImpl });
  const created = await store.create({ title: '初始画布', slug: 'first', operationId: 'bootstrap-create-1' });
  assert.equal(created.canvas.slug, 'first');
  assert.equal((await store.list()).canvases.length, 1);
});

test('初始化响应丢失后重跑复用原页', async () => {
  const f = emptyRoot(); const request = f.api.request.bind(f.api); let lost = true;
  f.api.request = async (...args) => {
    const result = await request(...args);
    if (args[0] === 'POST' && args[1] === '/pages' && lost) { lost = false; throw new Error('模拟响应丢失'); }
    return result;
  };
  await assert.rejects(initNative({ api: f.api, rootId: f.ids.root }), /响应丢失/);
  await initNative({ api: f.api, rootId: f.ids.root });
  assert.equal(f.children(f.ids.root).length, 1);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
});

test('拒绝非空根与损坏的同名设置页，不覆盖既有数据', async () => {
  const f = folderNativeFixture();
  f.blocks.delete(f.ids.settingsPage);
  await assert.rejects(initNative({ api: f.api, rootId: f.ids.root }), /空目录/);
  assert.equal(f.requests.filter(r => r.method !== 'GET').length, 0);
  const g = folderNativeFixture(); g.blocks.delete(g.ids.registry);
  await assert.rejects(initNative({ api: g.api, rootId: g.ids.root }), /registry/);
  assert.equal(g.requests.filter(r => r.method !== 'GET').length, 0);
});
