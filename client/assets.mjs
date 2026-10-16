/** 用服务器当前清单和已确认场景重建哈希引用；不修改撤销所需原图。 */
export function confirmedAssets(scene, assets = {}) {
  return new Map(Object.entries(assets).map(([id, asset]) => [id, { ...asset, dataURL: scene.files[id]?.dataURL }]));
}

/** 已知图片按哈希引用；每个已确认dataURL只记一次，编辑器撤销所需原图仍保留。 */
export function compactScene(scene, known) {
  return { ...scene, files: Object.fromEntries(Object.entries(scene.files).map(([id, file]) => {
    const old = known.get(id);
    return [id, old && old.dataURL === file.dataURL ? { id, mimeType: old.mimeType, hash: old.hash } : file];
  })) };
}

/** 浏览器短期原图缓存仅按内容哈希复用，最多20MiB，注销时清空。 */
export class ImageCache {
  constructor(limit = 20 * 1024 ** 2) { this.limit = limit; this.items = new Map(); }
  get(hash) { return this.items.get(hash); }
  set(hash, file) {
    this.items.delete(hash); this.items.set(hash, file);
    let size = [...this.items.values()].reduce((n, f) => n + f.dataURL.length, 0);
    while (size > this.limit) { const [key, old] = this.items.entries().next().value; size -= old.dataURL.length; this.items.delete(key); }
  }
}
