import { createHash, randomUUID } from 'node:crypto';
import { ServiceError } from './flowus.mjs';
import { NativeDocuments, nativeDocument, nativeContent, blockVersion } from './native.mjs';
import { AssetCollector, activeFileIds } from './gc.mjs';
import { Recovery } from './resilience.mjs';
import { ThumbnailCache } from './thumbnail.mjs';
import { normalizeSettings, mergeSettings, SETTINGS_HELP } from './settings.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const text = value => (value || []).map(v => v.plain_text ?? v.text?.content ?? '').join('');
const marker = 'excalidraw-flowus:';
const live = block => !block.in_trash && !block.archived;
const key = block => block.file?.file?.oss_name;
const caption = block => text(block.file?.caption);
const revision = blockVersion;
const uuid = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const slugPattern = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const mimeExtensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };

/** 解析应用文件标签；输入 FlowUs 文件块；输出可识别的元数据，其他文件保持独立。 */
function metadata(block) {
  if (block.type !== 'file') return null;
  for (const item of block.file?.caption || []) {
    const value = item.plain_text ?? item.text?.content ?? '';
    if (!value.startsWith(marker)) continue;
    try { return JSON.parse(value.slice(marker.length)); } catch {}
  }
  return null;
}

/** 仅信任官方对象存储 URL；输入服务端返回的地址；输出可用 HTTPS URL。 */
function safeStorageUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || !/(^|\.)(flowus\.cn|myqcloud\.com|tencentcos\.cn)$/.test(url.hostname)) throw new ServiceError(502, 'FlowUs 文件地址不符合安全策略');
  return url;
}

/** 流式限制下载大小；输入官方文件响应及上限；输出内存字节，不写本地内容缓存。 */
async function boundedBytes(response, limit) {
  if (response.status === 404) throw new ServiceError(502, '图片对象尚未上传或已不存在', 'OBJECT_NOT_FOUND');
  if (!response.ok || Number(response.headers.get('content-length')) > limit) throw new ServiceError(502, 'FlowUs 文件下载失败或文件超限');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) { await response.body.cancel?.().catch(() => {}); throw new ServiceError(413, 'FlowUs 文件超出安全容量'); } chunks.push(chunk); }
  return Buffer.concat(chunks);
}

/** 校验场景及图片；输入客户端场景；输出 JSON 副本，拒绝远程图片及不完整图片引用。 */
export function validateScene(scene) {
  if (!scene || !Array.isArray(scene.elements) || scene.elements.length > 10000 || !scene.appState || typeof scene.appState !== 'object' || Array.isArray(scene.appState) || !scene.files || typeof scene.files !== 'object' || Array.isArray(scene.files)) throw new ServiceError(400, '画布场景格式无效');
  if (Object.keys(scene.files).length > 200) throw new ServiceError(413, '每张画布最多保存 200 个图片附件');
  const copy = JSON.parse(JSON.stringify(scene));
  for (const element of copy.elements) {
    if (!element || typeof element.id !== 'string' || (element.type === 'image' && !element.isDeleted && (!element.fileId || !copy.files[element.fileId]))) throw new ServiceError(400, '画布图片缺失，未覆盖服务器内容');
  }
  return copy;
}

/** FlowUs 是唯一内容存储；实例内锁保护单服务并发，所有保存均重新读取远端版本。 */
export class Canvases {
  constructor(api, { rootId, uploadPageId, fetchImpl = fetch, budgetBytes = 2 * 1024 ** 3, settingsBudgetBytes = 64 * 1024 ** 2, nativeRootId = '', gcOptions } = {}) {
    if (!uuid.test(rootId || '') || !uuid.test(uploadPageId || '')) throw new Error('需要明确的 FlowUs 根 ID 和上传权限页面 ID');
    this.native = nativeRootId ? new NativeDocuments(api, { rootId: nativeRootId, legacyRootId: rootId }) : null;
    this.api = api; this.rootId = rootId; this.uploadPageId = uploadPageId; this.fetch = fetchImpl;
    this.budgetBytes = budgetBytes; this.settingsBudgetBytes = settingsBudgetBytes; this.locks = new Map();
    this.signedMaps = new Map(); // 短期签名仅在内存缓存30秒。
    this.entryIndex = { until: 0, entries: new Map() }; // 仅为卡片预览复用列表索引，不改变编辑读取。
    this.previewPending = new Map(); // 同版本预览共用一次读取，完成后释放完整场景。
    this.uploadWindow = { startedAt: Date.now(), bytes: 0 }; // 仅用于传输节流，重启可重置，不充当存储账本。
    this.uploadBytesPerMinute = 100 * 1024 ** 2; // 每实例每分钟最多上传100 MiB。
    this.gc = new AssetCollector(this, gcOptions);
    this.recovery = this.native ? new Recovery(this) : null; this.thumbnails = new ThumbnailCache(); // 时钟及短宽限仅供内部隔离验收，不暴露HTTP配置。
  }
  /** 按资源排队；输入锁名与操作；输出串行操作结果，并回收锁。 */
  async locked(name, operation) {
    const before = this.locks.get(name) || Promise.resolve();
    const pending = before.catch(() => {}).then(operation); this.locks.set(name, pending);
    try { return await pending; } finally { if (this.locks.get(name) === pending) this.locks.delete(name); }
  }
  /** 仅HTTP读取启用短期快照；不把缓存上下文传给保存、删除或后台回收。 */
  readOnly(work, fresh = false) { return this.api.readView ? this.api.readView(work, fresh) : work(); }
  /** 完整读取直属子块；输入父 ID；输出未删除内容，不跨出授权根。 */
  async children(id) { return (await this.api.all('GET', `/blocks/${id}/children`)).filter(live); }
  /** 根目录扫描；输出真实 folder，文件夹中的 scene 标签保存稳定 slug。 */
  async entries(includeNative = true) {
    const result = [];
    for (const folder of (await this.children(this.rootId)).filter(b => b.type === 'folder')) {
      const scenes = (await this.children(folder.id)).filter(b => metadata(b)?.kind === 'scene');
      if (scenes.length > 1) throw new ServiceError(409, '画布文件夹含重复场景文件，请在 FlowUs 中修正');
      if (scenes.length === 1) {
        const block = scenes[0], meta = metadata(block);
        if (!slugPattern.test(meta.slug || '')) throw new ServiceError(409, '画布 URL 标识损坏');
        result.push({ folder, block, meta });
      }
    }
    if (this.native && includeNative) {
      const migrated = await this.native.entries();
      const nativeSlugs = new Set(migrated.map(e => e.meta.slug));
      for (let i = result.length - 1; i >= 0; i--) if (nativeSlugs.has(result[i].meta.slug)) result.splice(i, 1);
      result.push(...migrated);
    }
    const entries = new Map();
    for (const entry of result) {
      const cached = entry.native ? { ...entry, document: undefined, block: undefined, snapshotRevision: revision(entry.block) } : entry;
      entries.set(entry.meta.slug, entries.has(entry.meta.slug) ? null : cached);
    } // 重复slug仍需显式报错。
    this.entryIndex = { until: Date.now() + 30000, entries };
    return result;
  }
  /** 提供列表元数据；输入目录项；输出浏览器可见字段，隐藏对象存储签名。 */
  summary(entry) {
    return { slug: entry.meta.slug, title: entry.meta.title, updatedAt: entry.block.last_edited_time, revision: revision(entry.block), ...(entry.document?.scene && { empty: !entry.document.scene.elements.some(e => !e.isDeleted) }), flowusUrl: `https://flowus.cn/${this.uploadPageId}`, storage: { uploadedBytes: entry.meta.uploadedBytes || 0, warningThresholdBytes: this.budgetBytes, approximate: true, warning: (entry.meta.uploadedBytes || 0) > this.budgetBytes } };
  }
  async list() {
    if (!this.native) return { canvases: (await this.entries()).map(e => this.summary(e)) };
    const entries = await this.native.entries(true, true);
    return { canvases: entries.map(e => e.unavailable ? { slug: e.slug, title: e.ref.title || e.slug, status: e.status, error: e.error, flowusUrl: `https://flowus.cn/${e.ref.folderId}` } : { ...this.summary(e), status: 'ready' }), gcPaused: entries.some(e => e.unavailable && !['deleted', 'detached'].includes(e.status)) };
  }
  async resolve(slug) {
    if (!slugPattern.test(slug || '')) throw new ServiceError(404, '画布不存在');
    if (this.native) { const entry = await this.native.resolve(slug); if (entry) return entry; }
    const matches = (await this.entries(!this.native)).filter(e => e.meta.slug === slug);
    if (matches.length !== 1) throw new ServiceError(matches.length ? 409 : 404, matches.length ? '画布 URL 重复' : '画布不存在', matches.length ? undefined : 'CANVAS_NOT_FOUND');
    return matches[0];
  }
  /** 获取认证短期下载地址；输入文件块；输出内存字节，签名地址不返回浏览器。 */
  async download(block, limit) {
    const parent = block.parent?.page_id || block.parent?.block_id;
    if (!uuid.test(parent || '')) throw new ServiceError(502, '附件缺少目录归属');
    let cached = this.signedMaps.get(parent);
    if (!cached || cached.until < Date.now() || !cached.urls.has(key(block))) {
      const { data } = await this.api.request('GET', `/pages/${parent}/content/markdown`);
      const urls = new Map();
      for (const value of (data.markdown || '').match(/https:\/\/[^\s)]+/g) || []) {
        const url = new URL(value);
        if (url.hostname !== 'cdn2.flowus.cn' || !url.searchParams.has('token')) continue;
        const path = decodeURIComponent(url.pathname).replace(/^\//, '');
        urls.set(path, value);
      }
      cached = { urls, until: Date.now() + 30000 }; this.signedMaps.set(parent, cached);
      if (this.signedMaps.size > 200) this.signedMaps.delete(this.signedMaps.keys().next().value);
    }
    const value = cached.urls.get(key(block));
    if (!value) throw new ServiceError(502, 'FlowUs 未返回此附件的可用签名，图片及场景未被省略');
    const url = safeStorageUrl(value);
    return boundedBytes(await this.fetch(url, { headers: { Referer: 'https://flowus.cn/' }, signal: AbortSignal.timeout(30000), redirect: 'error' }), limit);
  }
  /** 上传字节并登记官方回调；输入名字、类型与字节；输出可挂载文件字段。 */
  async upload(filename, contentType, bytes, parentId = this.rootId) {
    if (Date.now() - this.uploadWindow.startedAt > 60000) this.uploadWindow = { startedAt: Date.now(), bytes: 0 };
    if (this.uploadWindow.bytes + bytes.length > this.uploadBytesPerMinute) throw new ServiceError(429, '文件上传暂时达到每分钟传输额度，请稍后重试');
    this.uploadWindow.bytes += bytes.length; // 分配上传URL前计费，失败上传也占本分钟额度。
    const { data } = await this.api.request('POST', '/files/upload-url', { filename, content_type: contentType, content_length: bytes.length, parent: { type: 'page_id', page_id: parentId } });
    const response = await this.fetch(safeStorageUrl(data.upload_url), { method: 'PUT', headers: data.headers, body: bytes, signal: AbortSignal.timeout(60000), redirect: 'error' });
    if (!response.ok) throw new ServiceError(502, 'FlowUs 文件上传失败，原场景未覆盖');
    return { oss_name: data.oss_name, size: bytes.length, content_type: contentType };
  }
  /** 包装可识别的真实文件块；输入上传对象及小型元数据；输出 API 文件内容。 */
  fileContent(file, meta) { return { type: 'file', file, caption: [{ type: 'text', text: { content: marker + JSON.stringify(meta) } }] }; }
  /** 读取场景并恢复附件；输入已验证目录项；输出完整 Excalidraw 场景。 */
  async readEntry(entry) {
    let document;
    if (entry.native) {
      const { data: folder } = await this.api.request('GET', `/blocks/${entry.folder.id}`);
      if (!folder || folder.type !== 'folder' || !live(folder) || (folder.parent?.page_id || folder.parent?.block_id) !== this.rootId) throw new ServiceError(409, '图片目录已移出授权根');
    }
    try { document = entry.native ? nativeDocument(entry.block, this.native.maxBytes) : JSON.parse((await this.download(entry.block, 4 * 1024 ** 2)).toString('utf8')); } catch (error) { if (error instanceof ServiceError) throw error; throw new ServiceError(409, '场景 JSON 损坏，未覆盖原文件'); }
    if (!document || typeof document !== 'object' || ![1, 2].includes(document.schemaVersion) || document.slug !== entry.meta.slug || !document.scene || !document.assets || typeof document.assets !== 'object' || Array.isArray(document.assets) || Object.keys(document.assets).length > 200) throw new ServiceError(409, '场景文件版本或归属错误');
    const blocks = await this.children(entry.folder.id); const files = {}; let imageBytes = 0;
    const active = activeFileIds(document);
    for (const [id, asset] of Object.entries(document.assets)) {
      if (!active.has(id)) continue; // tombstone及历史files不强制下载已回收图片，撤销由客户端保留的dataURL恢复。
      if (!asset || typeof asset !== 'object' || typeof asset.hash !== 'string' || !mimeExtensions[asset.mimeType] || !asset.properties || typeof asset.properties !== 'object' || Array.isArray(asset.properties)) throw new ServiceError(409, '图片元数据损坏');
      const block = blocks.find(b => b.id === asset.blockId && b.type === 'file' && metadata(b)?.kind === 'asset' && metadata(b)?.hash === asset.hash);
      if (!block || !mimeExtensions[asset.mimeType]) throw new ServiceError(409, '画布图片附件缺失，未加载不完整场景');
      const bytes = await this.download(block, 10 * 1024 ** 2);
      imageBytes += bytes.length; if (imageBytes > 20 * 1024 ** 2) throw new ServiceError(413, '图片总量超过20 MiB');
      if (hash(bytes) !== asset.hash) throw new ServiceError(409, '图片校验失败，未加载损坏数据');
      files[id] = { ...asset.properties, id, mimeType: asset.mimeType, dataURL: `data:${asset.mimeType};base64,${bytes.toString('base64')}` };
    }
    return { document, canvas: { ...this.summary(entry), scene: validateScene({ ...document.scene, files }) } };
  }
  async load(slug, manifest = false) { const entry = await this.resolve(slug); return { canvas: manifest && entry.native ? (await this.recovery.light(entry)).canvas : (await this.readEntry(entry)).canvas }; }
  async asset(slug, fileId, expected) {
    const entry = await this.resolve(slug); const current = await this.recovery.light(entry); const asset = current.document.assets[fileId];
    if (!asset || asset.hash !== expected || !activeFileIds(current.document).has(fileId)) throw new ServiceError(404, '图片引用不存在');
    const block = current.blocks.find(b => b.id === asset.blockId);
    if (!block || current.canvas.assets[fileId]?.missing) throw new ServiceError(404, '图片附件缺失');
    const bytes = await this.download(block, 10 * 1024 ** 2);
    if (hash(bytes) !== asset.hash) throw new ServiceError(409, '图片校验失败');
    return { file: { ...asset.properties, id: fileId, mimeType: asset.mimeType, dataURL: `data:${asset.mimeType};base64,${bytes.toString('base64')}` } };
  }
  async thumbnail(slug, expected, update) {
    return this.locked(`canvas:${slug}`, async () => {
      const entry = await this.resolve(slug);
      if (revision(entry.block) !== expected) throw new ServiceError(409, '预览版本已变化');
      if (entry.document?.scene && !entry.document.scene.elements.some(e => !e.isDeleted)) return { thumbnail: { revision: expected, empty: true } };
      if (update) await this.thumbnails.set(slug, { revision: expected, dataURL: update.dataURL });
      return { thumbnail: await this.thumbnails.get(slug, expected) };
    });
  }
  async operationStatus(slug, id) { return this.locked(`canvas:${slug}`, () => this.recovery.status(slug, id)); }
  async manage(slug, input) { return this.locked(`canvas:${slug}`, () => this.recovery.manage(slug, input)); }
  /** 只读加载列表所见版本；输入slug与列表revision；输出真实场景，同版本并发共用一次读取。 */
  async preview(slug, expected) {
    if (!slugPattern.test(slug || '')) throw new ServiceError(404, '画布不存在');
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) throw new ServiceError(400, '预览需要列表中的画布版本');
    const pendingKey = `${slug}:${expected}`;
    if (this.previewPending.has(pendingKey)) return this.previewPending.get(pendingKey);
    const work = async () => {
      let entry;
      if (this.entryIndex.until > Date.now() && this.entryIndex.entries.has(slug)) {
        entry = this.entryIndex.entries.get(slug);
        if (!entry) throw new ServiceError(409, '画布URL重复，无法读取预览');
      } else entry = await this.resolve(slug);
      if ((entry.snapshotRevision || revision(entry.block)) !== expected) throw new ServiceError(409, '画布预览已更新，请刷新列表');
      if (entry.native) {
        const fresh = await this.native.resolve(slug);
        if (!fresh || revision(fresh.block) !== expected) throw new ServiceError(409, '画布预览已更新，请刷新列表');
        return { canvas: (await this.readEntry(fresh)).canvas };
      }
      const { data: folder } = await this.api.request('GET', `/blocks/${entry.folder.id}`);
      const parent = folder?.parent?.page_id || folder?.parent?.block_id;
      if (!folder || !live(folder) || folder.type !== 'folder' || parent !== this.rootId) throw new ServiceError(404, '画布已移出当前目录');
      const { data: block } = await this.api.request('GET', `/blocks/${entry.block.id}`);
      const blockParent = block?.parent?.page_id || block?.parent?.block_id;
      const meta = block && metadata(block);
      if (!block || !live(block) || blockParent !== folder.id || meta?.kind !== 'scene' || meta.slug !== slug) throw new ServiceError(404, '画布场景不存在');
      if (revision(block) !== expected) throw new ServiceError(409, '画布预览已更新，请刷新列表');
      return { canvas: (await this.readEntry({ folder, block, meta })).canvas };
    };
    const pending = work(); this.previewPending.set(pendingKey, pending);
    try { return await pending; } finally { this.previewPending.delete(pendingKey); }
  }
  /** 创建独立真实文件夹；输入标题及可选 slug；输出可直接进入的固定链接对象。 */
  async create(input = {}) {
    if (this.recovery) return this.locked('root', () => this.recovery.create(input));
    let { title = '未命名画布', slug = `c-${randomUUID().slice(0, 12)}` } = input;
    return this.locked('root', async () => {
      if (typeof title !== 'string' || !title.trim() || title.length > 120 || !slugPattern.test(slug)) throw new ServiceError(400, '标题或 URL 标识格式无效');
      if ((await this.entries()).some(e => e.meta.slug === slug)) throw new ServiceError(409, '画布 URL 标识已存在');
      const { data } = await this.api.request('PATCH', `/blocks/${this.rootId}/children`, { children: [{ type: 'folder', folder: { title: title.trim() } }] });
      const folder = data.results?.[0];
      if (!folder || folder.type !== 'folder') throw new ServiceError(502, 'FlowUs 未返回真实文件夹，创建已停止');
      const document = { schemaVersion: 1, slug, title: title.trim(), scene: { elements: [], appState: {}, files: {} }, assets: {}, uploadedBytes: 0 };
      if (this.native) {
        await this.native.create({ ...document, schemaVersion: 2, kind: 'scene', assetFolderId: folder.id });
        return this.load(slug);
      }
      const bytes = Buffer.from(JSON.stringify(document)); document.uploadedBytes = bytes.length;
      const file = await this.upload('scene.excalidraw.json', 'application/json', Buffer.from(JSON.stringify(document)), folder.id);
      await this.api.request('PATCH', `/blocks/${folder.id}/children`, { children: [{ type: 'file', file: this.fileContent(file, { kind: 'scene', slug, title: document.title, uploadedBytes: file.size }) }] });
      return this.load(slug);
    });
  }
  /** 保存去除 base64 的场景；图片按哈希复用，上传完成后再次校验旧版本再替换文件指针。 */
  async save(slug, input = {}) {
    if (this.recovery) {
      const entry = await this.resolve(slug);
      if (!entry.native) throw new ServiceError(409, '此画布尚未完成原生迁移');
      return this.locked(`canvas:${slug}`, () => this.recovery.save(slug, input));
    }
    let { revision: expected, scene, title } = input;
    return this.locked(`canvas:${slug}`, async () => {
      const entry = await this.resolve(slug);
      if (this.native && !entry.native) throw new ServiceError(409, '此画布尚未完成原生迁移，请先导出本地内容；未上传新的JSON文件');
      if (!expected || expected !== revision(entry.block)) throw new ServiceError(409, '画布已被其他窗口修改，请先导出本地内容再重新加载');
      const current = await this.readEntry(entry);
      if (scene === undefined && title !== undefined) scene = current.canvas.scene; // 只改标题时复用已保存内容，不提交浏览器未保存草稿。
      const normalized = validateScene(scene); const assets = {}; const blocks = await this.children(entry.folder.id);
      const active = new Set(normalized.elements.filter(e => e.type === 'image' && !e.isDeleted).map(e => e.fileId));
      normalized.files = Object.fromEntries(Object.entries(normalized.files).filter(([id]) => active.has(id))); // 无活跃引用的binary不再进入已提交资源映射。
      let uploaded = entry.meta.uploadedBytes || 0;
      title ??= entry.meta.title;
      if (typeof title !== 'string' || !title.trim() || title.length > 120) throw new ServiceError(400, '画布标题须为 1–120 个字符');
      if (entry.native) nativeContent({ ...entry.document, title: title.trim(), scene: { ...normalized, files: {} } }, this.native.maxBytes);
      const prepared = [];
      for (const [id, file] of Object.entries(normalized.files)) {
        const match = typeof file?.dataURL === 'string' && file.dataURL.match(/^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,([A-Za-z0-9+/=]+)$/);
        if (!match || file.mimeType !== match[1]) throw new ServiceError(400, '图片须为完整的本地 PNG/JPEG/WebP/GIF/SVG 数据，远程图片地址不接受');
        const bytes = Buffer.from(match[2], 'base64');
        if (!bytes.length || bytes.length > 10 * 1024 ** 2) throw new ServiceError(413, '每张图片最大 10 MB');
        const digest = hash(bytes); const existing = blocks.find(b => metadata(b)?.kind === 'asset' && metadata(b)?.hash === digest);
        prepared.push({ id, file, bytes, digest, existing });
      }
      if (prepared.reduce((n, a) => n + a.bytes.length, 0) > 20 * 1024 ** 2) throw new ServiceError(413, '每张画布的图片总量最大20 MiB');
      if (entry.native) {
        const plannedAssets = {};
        for (const asset of prepared) {
          const { dataURL, mimeType, ...properties } = asset.file;
          plannedAssets[asset.id] = { blockId: asset.existing?.id || '00000000-0000-4000-8000-000000000000', hash: asset.digest, mimeType, properties };
        }
        nativeContent({ ...entry.document, title: title.trim(), scene: { ...normalized, files: {} }, assets: plannedAssets }, this.native.maxBytes); // 新图元数据也在任何上传前计入容量。
        await this.gc.register(entry, blocks, current.document); // 已提交旧图先登记归属；此时不标记未用候选。
      }
      for (const asset of prepared) {
        let block = asset.existing;
        if (!block) {
          const file = await this.upload(`${asset.digest}.${mimeExtensions[asset.file.mimeType]}`, asset.file.mimeType, asset.bytes, entry.folder.id); uploaded += asset.bytes.length;
          const { data } = await this.api.request('PATCH', `/blocks/${entry.folder.id}/children`, { children: [{ type: 'file', file: this.fileContent(file, { kind: 'asset', hash: asset.digest, ...(entry.native ? { mimeType: asset.file.mimeType, ownerSlug: slug, ownerFolderId: entry.folder.id, committed: false } : {}) }) }] });
          block = data.results[0]; blocks.push(block);
        }
        const { dataURL, mimeType, ...properties } = asset.file;
        assets[asset.id] = { blockId: block.id, hash: asset.digest, mimeType, properties };
      }
      const document = { schemaVersion: 1, slug, title: title.trim(), scene: { ...normalized, files: {} }, assets };
      if (entry.native) Object.assign(document, { ...entry.document, title: title.trim(), scene: { ...normalized, files: {} }, assets });
      if (JSON.stringify(current.document.scene) === JSON.stringify(document.scene) && JSON.stringify(current.document.assets) === JSON.stringify(assets) && current.document.title === document.title) {
        if (entry.native) await this.afterCommit(slug, entry, blocks, document);
        return { canvas: current.canvas }; // 无内容变化时不分配新对象。
      }
      if (entry.native) {
        document.uploadedBytes = uploaded; // 普通JSON保存不上传对象，估算只计新增图片。
        await this.native.write(entry.block, document, expected);
        if (entry.folder.folder.title !== document.title) await this.api.request('PATCH', `/blocks/${entry.folder.id}`, { type: 'folder', folder: { title: document.title } });
        await this.afterCommit(slug, entry, blocks, document);
        return this.load(slug);
      }
      document.uploadedBytes = uploaded + Buffer.byteLength(JSON.stringify(document)); // 估算只用于软提示，不冒充完整OSS账本。
      const bytes = Buffer.from(JSON.stringify(document));
      if (bytes.length > 4 * 1024 ** 2) throw new ServiceError(413, '场景 JSON 最大4 MiB，图片已单独保存');
      uploaded = document.uploadedBytes;
      const file = await this.upload('scene.excalidraw.json', 'application/json', bytes, entry.folder.id);
      const { data: fresh } = await this.api.request('GET', `/blocks/${entry.block.id}`);
      if (revision(fresh) !== expected) throw new ServiceError(409, '上传期间画布已变化，原场景未覆盖');
      await this.api.request('PATCH', `/blocks/${entry.block.id}`, { type: 'file', file: this.fileContent(file, { kind: 'scene', slug, title: document.title, uploadedBytes: uploaded }) });
      if (entry.folder.folder.title !== document.title) await this.api.request('PATCH', `/blocks/${entry.folder.id}`, { type: 'folder', folder: { title: document.title } });
      return this.load(slug);
    });
  }
  /** 提交成功后持锁登记图片并标候选；失败保留原生提交，定时任务重试，不误报场景保存失败。 */
  async afterCommit(slug, entry, blocks, document) {
    try { await this.gc.register(entry, blocks, document);
      if (this.recovery) { const tasks = await this.native.tasks(entry); const used = new Set(Object.values(document.assets).map(a => a.blockId)); const done = Object.entries(tasks.uploads).filter(([, t]) => used.has(t.blockId)); if (done.length) await this.native.tasks(entry, doc => { for (const [id] of done) delete doc.uploads[id]; }); }
      await this.gc.observe(slug, { allowDelete: false, global: { references: new Map() } }); }
    catch { console.error('场景已提交，附件回收登记暂时失败；定时任务将重试'); }
  }
  async collectGarbage() { return this.gc.run(); }
  /** 全局偏好是真实 JSON 文件；首次读取时初始化，所有修改共用该文件版本。 */
  async settings(update) {
    return this.locked('settings', async () => {
      if (this.native) return this.native.settings(update);
      const matches = (await this.children(this.rootId)).filter(b => metadata(b)?.kind === 'settings');
      if (matches.length > 1) throw new ServiceError(409, '全局设置文件重复');
      let block = matches[0]; let old = { settings: { autoSave: true }, uploadedBytes: 0 };
      if (block) {
        try { old = JSON.parse((await this.download(block, 65536)).toString()); } catch { throw new ServiceError(409, '全局设置 JSON 损坏'); }
        if (!old || typeof old.settings?.autoSave !== 'boolean') throw new ServiceError(409, '全局设置格式无效');
      }
      if (update && (!block || update.revision !== revision(block))) throw new ServiceError(409, '全局设置已变化，请重新加载');
      const settings = update ? mergeSettings(old.settings, update.settings) : normalizeSettings(old.settings);
      if (!block || (update && JSON.stringify(settings) !== JSON.stringify(old.settings))) {
        const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, settings, settingsHelp: SETTINGS_HELP, uploadedBytes: (old.uploadedBytes || 0) + 128 }));
        const file = await this.upload('general-settings.json', 'application/json', bytes);
        const content = this.fileContent(file, { kind: 'settings' });
        if (block) { const { data: fresh } = await this.api.request('GET', `/blocks/${block.id}`); if (revision(fresh) !== update.revision) throw new ServiceError(409, '全局设置已被修改'); await this.api.request('PATCH', `/blocks/${block.id}`, { type: 'file', file: content }); }
        else { const { data } = await this.api.request('PATCH', `/blocks/${this.rootId}/children`, { children: [{ type: 'file', file: content }] }); block = data.results[0]; }
        block = (await this.api.request('GET', `/blocks/${block.id}`)).data;
      }
      return { settings, revision: revision(block) };
    });
  }
}
