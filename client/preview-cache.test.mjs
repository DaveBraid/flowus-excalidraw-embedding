import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewCache, previewKey } from './preview-cache.mjs';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test('两路预览并发有界，先完成的任务释放名额，同版本不重复请求', async () => {
  const cache = new PreviewCache(32, 2), a = deferred(), b = deferred(), calls = [];
  const first = cache.get('a', () => { calls.push('a'); return a.promise; });
  const second = cache.get('b', () => { calls.push('b'); return b.promise; });
  const third = cache.get('c', async () => { calls.push('c'); return 'c'; });
  assert.equal(cache.get('b', () => { throw Error(); }), second);
  assert.deepEqual(calls, ['a', 'b']); b.resolve('b'); await second; await third;
  assert.deepEqual(calls, ['a', 'b', 'c']); a.resolve('a'); await first; assert.equal(cache.running, 0);
});

test('同一已保存 revision 只读取一次，新 revision 生成独立预览', async () => {
  const cache = new PreviewCache(); let reads = 0;
  const create = async () => { reads++; return new Blob(['预览']); };
  const a = await cache.get(previewKey('a', 'r1'), create);
  assert.equal(await cache.get(previewKey('a', 'r1'), create), a);
  await cache.get(previewKey('a', 'r2'), create);
  assert.equal(reads, 2);
});

test('读取和渲染单并发，同版本并发调用合并', async () => {
  const cache = new PreviewCache(); const first = deferred(); const calls = [];
  const a = cache.get('a', async () => { calls.push('a'); return first.promise; });
  const same = cache.get('a', async () => { throw new Error('重复任务不得运行'); });
  const b = cache.get('b', async () => { calls.push('b'); return new Blob(['b']); });
  assert.equal(a, same); assert.deepEqual(calls, ['a']);
  first.resolve(new Blob(['a'])); await Promise.all([a, same, b]);
  assert.deepEqual(calls, ['a', 'b']);
});

test('滚出视区的排队任务跳过，失败允许重试，缓存遵守上限', async () => {
  const cache = new PreviewCache(2); const first = deferred();
  const a = cache.get('a', () => first.promise);
  let needed = true; let reads = 0;
  const skipped = cache.get('skip', async () => { reads++; }, () => needed);
  const rejection = assert.rejects(skipped, { name: 'AbortError' });
  needed = false; first.resolve(new Blob(['a'])); await a; await rejection;
  assert.equal(reads, 0);
  await assert.rejects(cache.get('error', async () => { throw new Error('失败'); }));
  await cache.get('error', async () => new Blob(['恢复']));
  await cache.get('c', async () => new Blob(['c']));
  assert.equal(cache.cache.size, 2); assert.equal(cache.cache.has('a'), false);
});
