import test from 'node:test';
import assert from 'node:assert/strict';
import { compactScene, confirmedAssets } from '../client/assets.mjs';
import { contentScene, SaveMachine } from '../client/save-machine.mjs';
import { folderNativeFixture, imageScene, emptyScene } from './fixture.mjs';

for (const responseLost of [false, true]) {
  test(`图片删除保存后撤销可再次保存，${responseLost ? '丢失响应后查询确认' : '正常响应'}同步引用清单`, async () => {
    const f = folderNativeFixture(), store = f.service();
    const initial = (await store.load('review', true)).canvas;
    const first = imageScene('f'), second = imageScene('g');
    const original = contentScene([...first.elements, ...second.elements], {}, { ...first.files, ...second.files });
    // 编辑器删除后仍保留原图，只有未删除的元素进入保存快照。
    const deleted = contentScene(original.elements.map(e => e.fileId === 'f' ? { ...e, isDeleted: true } : e), {}, original.files);
    let known = confirmedAssets(initial.scene, initial.assets), dropResponse = false, undoDuringSave = false;
    const wires = [];
    const accept = (canvas, payload) => {
      if (!canvas.superseded && payload?.scene) known = confirmedAssets(payload.scene, canvas.assets);
    };
    const machine = new SaveMachine({ revision: initial.revision,
      persist: async payload => {
        const wire = { ...payload, scene: compactScene(payload.scene, known) }; wires.push(wire);
        const { canvas } = await store.save('review', wire);
        if (undoDuringSave) { undoDuringSave = false; machine.capture(original); } // 回包前已撤销，也必须按已提交快照同步。
        if (dropResponse) { dropResponse = false; throw Object.assign(new Error('模拟响应丢失'), { status: 503 }); }
        accept(canvas, payload); return canvas;
      },
      confirm: async id => {
        const status = await store.operationStatus('review', id);
        if (status.status === 'committed') accept(status.canvas, machine.operation?.payload);
        return status;
      },
    });
    machine.capture(emptyScene()); machine.capture(original);
    assert.equal(await machine.save(), true);
    assert.deepEqual([...known.keys()].sort(), ['f', 'g']);
    machine.capture(deleted); dropResponse = responseLost; undoDuringSave = true;
    assert.equal(await machine.save(), true);
    assert.deepEqual([...known.keys()], ['g']);
    assert.equal(machine.dirty, true);
    assert.equal(original.files.f.dataURL, first.files.f.dataURL); // 同步清单不删除撤销缓存。
    assert.equal(await machine.save(), true);
    const restored = wires.at(-1).scene.files;
    assert.equal(restored.f.dataURL, original.files.f.dataURL);
    assert.equal(restored.g.dataURL, undefined);
    assert.ok(restored.g.hash);
    assert.deepEqual(Object.keys((await store.load('review', true)).canvas.assets).sort(), ['f', 'g']);
    assert.equal(machine.dirty, false);
    assert.equal(machine.error, null);
    machine.dispose();
  });
}
