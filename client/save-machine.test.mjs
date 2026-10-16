import test from 'node:test';
import assert from 'node:assert/strict';
import { SaveMachine, contentScene } from './save-machine.mjs';

const scene = value => ({ elements: [{ id: 'a', text: value }], appState: {}, files: {} });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('加载首帧不写入；视角、选择和图片访问时间不产生内容变更', async () => {
  const writes = [];
  const machine = new SaveMachine({ revision: 1, persist: async body => { writes.push(body); return { revision: 2 }; } });
  const image = [{ id: 'a', type: 'image', fileId: 'f' }];
  machine.capture(contentScene(image, { scrollX: 0 }, { f: { id: 'f', dataURL: 'data:a', lastRetrieved: 1 } }));
  machine.capture(contentScene(image, { scrollX: 900, selectedElementIds: { a: true } }, { f: { id: 'f', dataURL: 'data:a', lastRetrieved: 2 } }));
  await machine.save();
  assert.equal(writes.length, 0);
  machine.capture(contentScene([], {}));
  await machine.save();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].scene.files, {});
});

test('慢保存期间的新修改保留，排队请求使用新 revision', async () => {
  const first = deferred(); const writes = [];
  const machine = new SaveMachine({ revision: 2, persist: async body => { writes.push(body); return writes.length === 1 ? first.promise : { revision: 4 }; } });
  machine.capture(scene('初始')); machine.capture(scene('第一版'));
  const saving = machine.save();
  await Promise.resolve();
  machine.capture(scene('最新修改')); machine.save();
  first.resolve({ revision: 3 });
  await saving;
  assert.equal(writes.length, 2);
  assert.equal(writes[0].revision, 2);
  assert.equal(writes[1].revision, 3);
  assert.equal(writes[1].scene.elements[0].text, '最新修改');
  assert.equal(machine.dirty, false);
});

test('自动保存关闭时保留修改；手动保存可在请求后继续编辑', async () => {
  const pending = deferred();
  const machine = new SaveMachine({ revision: 1, persist: () => pending.promise });
  machine.capture(scene('初始')); machine.capture(scene('手动版'));
  assert.equal(machine.dirty, true);
  const saving = machine.save(); await Promise.resolve();
  machine.capture(scene('继续编辑'));
  pending.resolve({ revision: 2 }); await saving;
  assert.equal(machine.dirty, true);
  assert.equal(machine.latest.scene.elements[0].text, '继续编辑');
});

test('冲突锁定写入，保留本地最新内容', async () => {
  let calls = 0;
  const machine = new SaveMachine({ revision: 1, persist: async () => { calls++; throw Object.assign(new Error('冲突'), { status: 409 }); } });
  machine.capture(scene('初始')); machine.capture(scene('本地'));
  await machine.save(); machine.capture(scene('继续保留')); await machine.save();
  assert.equal(calls, 1); assert.equal(machine.blocked, true); assert.equal(machine.dirty, true);
  assert.equal(machine.latest.scene.elements[0].text, '继续保留');
});

test('重命名只提交标题，保留未保存画布并沿用新 revision', async () => {
  const writes = [];
  const machine = new SaveMachine({ revision: 1, persist: async payload => { writes.push(payload); return { revision: writes.length + 1, title: payload.title }; } });
  machine.capture(scene('原画布')); machine.capture(scene('未保存绘图'));
  const result = await machine.rename('新标题');
  assert.equal(result.title, '新标题');
  assert.deepEqual(writes[0], { operationId: writes[0].operationId, revision: 1, title: '新标题' });
  assert.equal(machine.dirty, true);
  assert.equal(machine.latest.scene.elements[0].text, '未保存绘图');
  await machine.save();
  assert.equal(writes[1].revision, 2);
  assert.equal(writes[1].scene.elements[0].text, '未保存绘图');
});

test('重命名等待现有保存，不提交保存期间的新绘图', async () => {
  const pending = deferred(); const writes = [];
  const machine = new SaveMachine({ revision: 1, persist: async payload => { writes.push(payload); return writes.length === 1 ? pending.promise : { revision: 3, title: payload.title }; } });
  machine.capture(scene('初始')); machine.capture(scene('在保存'));
  machine.save(); await Promise.resolve();
  machine.capture(scene('更新但未保存'));
  const rename = machine.rename('改名'); machine.save();
  pending.resolve({ revision: 2 }); await rename;
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], { operationId: writes[1].operationId, revision: 2, title: '改名' });
  assert.equal(machine.dirty, true);
});

test('标题保存冲突同样锁定写入并保留本地内容', async () => {
  const machine = new SaveMachine({ revision: 1, persist: async () => { throw Object.assign(new Error('版本冲突'), { status: 409 }); } });
  machine.capture(scene('初始')); machine.capture(scene('保留'));
  assert.equal(await machine.rename('失败的标题'), false);
  assert.equal(machine.blocked, true);
  assert.equal(machine.revision, 1);
  assert.equal(machine.dirty, true);
});

test('提交仅引用活跃图片，但保留原始文件和删除元素供页面内undo恢复', () => {
  const elements = [{ id: 'live', type: 'image', fileId: 'a' }, { id: 'deleted', type: 'image', fileId: 'b', isDeleted: true }];
  const files = { a: { id: 'a', dataURL: 'data:live' }, b: { id: 'b', dataURL: 'data:undo' } };
  const saved = contentScene(elements, {}, files);
  assert.deepEqual(Object.keys(saved.files), ['a']);
  assert.equal(elements.length, 2); assert.equal(elements[1].isDeleted, true); assert.equal(files.b.dataURL, 'data:undo');
  const restored = contentScene([elements[0], { ...elements[1], isDeleted: false }], {}, files);
  assert.equal(restored.files.b.dataURL, 'data:undo');
});

test('丢失成功响应先查操作凭证，不重复提交；继续编辑使用新操作ID', async () => {
  const writes = []; let confirmed;
  const machine = new SaveMachine({ revision: 'v1', persist: async payload => { writes.push(payload); if (writes.length === 1) { confirmed = { revision: 'v2' }; throw Object.assign(new Error('断网'), { status: 503 }); } return { revision: 'v3' }; }, confirm: async () => ({ status: 'committed', canvas: confirmed }) });
  machine.capture(scene('初始')); machine.capture(scene('第一版')); await machine.save();
  assert.equal(writes.length, 1); assert.equal(machine.dirty, false); assert.equal(machine.revision, 'v2');
  machine.capture(scene('第二版')); await machine.save(); assert.equal(writes[1].revision, 'v2'); assert.notEqual(writes[0].operationId, writes[1].operationId);
});

test('结果未知后继续编辑：先重试冻结快照，再提交新内容；确认接口离线不盲写', async () => {
  const writes = []; let online = false;
  const machine = new SaveMachine({ revision: 'v1', persist: async payload => { writes.push(structuredClone(payload)); if (!online) throw new Error('断网'); return { revision: `v${writes.length + 1}` }; }, confirm: async () => { if (!online) throw new Error('断网'); return { status: 'unknown' }; } });
  machine.capture(scene('初始')); machine.capture(scene('第一版')); await machine.save(); assert.equal(machine.uncertain, true);
  machine.capture(scene('最新')); await machine.save(); assert.equal(writes.length, 1);
  online = true; await machine.save(); assert.equal(writes.length, 3); assert.equal(writes[1].operationId, writes[0].operationId); assert.equal(writes[1].scene.elements[0].text, '第一版'); assert.equal(writes[2].scene.elements[0].text, '最新');
});

test('历史提交已成功但有后续版本时，确认后停止继续覆盖', async () => {
  let writes = 0;
  const machine = new SaveMachine({ revision: 'old', persist: async () => { writes++; throw new Error('断网'); }, confirm: async () => ({ status: 'committed', canvas: { revision: 'newer', superseded: true } }) });
  machine.capture(scene('初始')); machine.capture(scene('本地')); await machine.save(); machine.capture(scene('继续')); await machine.save();
  assert.equal(writes, 1); assert.equal(machine.blocked, true); assert.equal(machine.dirty, true);
});
