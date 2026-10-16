import { createHash } from 'node:crypto';
import { ServiceError } from './flowus.mjs';
import { normalizeSettings, mergeSettings, SETTINGS_HELP } from './settings.mjs';

export const NATIVE_LIMIT = 1024 * 1024; // 单份原生场景上限1 MiB，迁移时对新块做可逆边界验证。
export const plainText = values => (values || []).map(v => v.plain_text ?? v.text?.content ?? '').join('');
export const digest = value => createHash('sha256').update(value).digest('hex');
export const blockVersion = block => digest(block.type === 'code' ? `${block.id}:${block.last_edited_time}:code:${plainText(block.code?.rich_text)}` : `${block.id}:${block.last_edited_time}:${block.file?.file?.oss_name}:${plainText(block.file?.caption)}`);
const alive = value => value && !value.in_trash && !value.archived;
const titleOf = page => plainText(Object.values(page.properties || {}).find(v => v.type === 'title')?.title);

/** 将JSON写入固定原生代码块；输入对象和上限；输出单次PATCH内容，不分裂提交。 */
export function nativeContent(document, maxBytes = NATIVE_LIMIT) {
  const raw = JSON.stringify(document);
  if (Buffer.byteLength(raw) > maxBytes) throw new ServiceError(413, `场景超过原生存储上限${Math.floor(maxBytes / 1024)} KiB，未保存；请先导出本地内容`);
  const rich_text = (raw.match(/.{1,1800}/gsu) || ['']).map(content => ({ type: 'text', text: { content } })); // 每段避开代理对，所有段在同一请求替换。
  return { type: 'code', code: { language: 'json', rich_text } };
}

/** 读取原生JSON；输入代码块；输出完整对象，拒绝损坏数据和超限内容。 */
export function nativeDocument(block, maxBytes = NATIVE_LIMIT) {
  if (block?.type !== 'code') throw new ServiceError(409, '原生场景块类型错误');
  const raw = plainText(block.code?.rich_text);
  if (Buffer.byteLength(raw) > maxBytes) throw new ServiceError(409, '原生场景块超过配置上限');
  try { const doc = JSON.parse(raw); if (!doc || doc.schemaVersion !== 2 || typeof doc.kind !== 'string') throw new Error(); return doc; }
  catch { throw new ServiceError(409, '原生场景JSON损坏，未覆盖原数据'); }
}

/** 原生数据页适配器；输入固定数据根；输出可原位更新的场景与设置，不创建OSS对象。 */
export class NativeDocuments {
  constructor(api, { rootId, legacyRootId, maxBytes = NATIVE_LIMIT } = {}) { this.api = api; this.rootId = rootId; this.legacyRootId = legacyRootId; this.maxBytes = maxBytes; this.index = null; this.registryQueue = Promise.resolve(); }
  async children(id) { return (await this.api.all('GET', `/blocks/${id}/children`)).filter(alive); }
  /** 读取固定registry；staging不参与服务切源，避免迁移失败暴露半份数据。 */
  async registry(requireReady = true) {
    const blocks = await this.children(this.rootId); const matches = [];
    for (const block of blocks.filter(b => b.type === 'code')) {
      const doc = nativeDocument(block, this.maxBytes);
      if (doc.kind === 'registry') matches.push({ block, document: doc });
    }
    if (matches.length !== 1 || matches[0].document.legacyRootId !== this.legacyRootId) throw new ServiceError(409, '原生数据根registry缺失、重复或归属错误');
    if (requireReady && matches[0].document.state !== 'ready') throw new ServiceError(503, '数据迁移尚未完成，请稍后重试');
    const document = matches[0].document;
    if (!document.canvases || typeof document.canvases !== 'object' || Array.isArray(document.canvases)) throw new ServiceError(409, '原生registry索引格式损坏');
    if (Number.isSafeInteger(document.maxSceneBytes) && document.maxSceneBytes > 0) this.maxBytes = Math.min(this.maxBytes, document.maxSceneBytes);
    this.index = { document }; // 保留索引快照；resolve只使用本次读取返回值。
    return { ...matches[0], blocks };
  }
  /** 枚举每张画布的稳定数据页；普通旧JSON仍由上层兼容读取。 */
  async entries(requireReady = true, tolerant = false) {
    const registry = await this.registry(requireReady); const entries = [];
    for (const [slug, ref] of Object.entries(registry.document.canvases)) {
      if (ref.state === 'deleted' || ref.state === 'detached') { if (tolerant) entries.push({ unavailable: true, slug, ref, status: ref.state, error: ref.state === 'deleted' ? '画布已移入回收站' : '已从列表移除，FlowUs内容保留' }); continue; }
      if (ref.state === 'deleting') { if (tolerant) { entries.push({ unavailable: true, slug, ref, status: 'deleting', error: '删除结果待确认，请重试删除或重新检查' }); continue; } throw new ServiceError(503, '画布删除待确认，回收暂停'); }
      try { entries.push(await this.readReference(slug, ref)); }
      catch (error) { if (!tolerant) throw error; entries.push({ unavailable: true, slug, ref, status: 'unavailable', error: error.status === 409 ? error.message : '暂时无法读取；可能被删除、移动或失去权限' }); }
    }
    return entries;
  }
  /** 根据固定ID读取单画布；只读最新块并检查父节点，不扫描其他画布。 */
  async readReference(slug, ref) {
    const { data: folder } = await this.api.request('GET', `/blocks/${ref.folderId}`);
    if (!alive(folder) || folder.type !== 'folder' || (folder.parent?.page_id || folder.parent?.block_id) !== this.legacyRootId) throw new ServiceError(409, '画布文件夹不可用或已移出数据根');
    const { data: page } = await this.api.request('GET', `/pages/${ref.pageId}`);
    if (!alive(page) || (page.parent?.page_id || page.parent?.block_id) !== ref.folderId) throw new ServiceError(409, 'JSON数据页已移出画布文件夹');
    const { data: block } = await this.api.request('GET', `/blocks/${ref.blockId}`);
    const document = nativeDocument(block, this.maxBytes);
    if (!alive(block) || document.kind !== 'scene' || document.slug !== slug || document.assetFolderId !== ref.folderId || (block.parent?.page_id || block.parent?.block_id) !== ref.pageId) throw new ServiceError(409, '原生场景索引或归属不一致');
    return { native: true, page: { id: ref.pageId }, block, document, folder, meta: { slug, title: document.title, uploadedBytes: document.uploadedBytes || 0 } };
  }
  async resolve(slug, requireReady = true) {
    const { document } = await this.registry(requireReady); // 前台GET由API短缓存合并；写入与GC必须读取最新索引。
    const ref = document.canvases[slug];
    if (!ref) return null;
    if (ref.state) throw new ServiceError(410, '画布已删除、移除或正在删除；请在列表管理中检查', 'CANVAS_RETIRED');
    return this.readReference(slug, ref);
  }
  /** 原位登记稳定ID；输入已回读的新页；输出同一个registry块的新内容。 */
  async register(entry) {
    await this.editRegistry(doc => {
      const previous = doc.canvases[entry.document.slug];
      if (previous && (previous.state || previous.pageId !== entry.page.id || previous.blockId !== entry.block.id)) throw new ServiceError(409, '原生画布URL重复或已停用');
      doc.canvases[entry.document.slug] = { pageId: entry.page.id, blockId: entry.block.id, folderId: entry.folder.id, title: entry.document.title };
    });
  }
  /** 串行改中央索引，防止不同画布操作互相覆盖；仅原位更新同一代码块。 */
  async editRegistry(change) {
    const work = async () => { const value = await this.registry(false); await change(value.document); try { const block = await this.write(value.block, value.document); return { document: value.document, block }; } finally { this.index = null; } };
    const pending = this.registryQueue.then(work, work); this.registryQueue = pending.catch(() => {}); return pending;
  }
  /** 读取或更新画布任务记录；记录位于同一JSON数据页，读操作不创建内容。 */
  async tasks(entry, edit) {
    const blocks = await this.children(entry.page.id);
    const matches = blocks.filter(b => b.type === 'code').filter(b => { try { return nativeDocument(b).kind === 'tasks'; } catch { return false; } });
    if (matches.length > 1) throw new ServiceError(409, '任务记录重复，已停止写入');
    let block = matches[0]; const doc = block ? nativeDocument(block) : { schemaVersion: 2, kind: 'tasks', slug: entry.meta.slug, folderId: entry.folder.id, uploads: {} };
    if (doc.slug !== entry.meta.slug || doc.folderId !== entry.folder.id || !doc.uploads || typeof doc.uploads !== 'object') throw new ServiceError(409, '任务记录归属错误');
    if (edit) {
      await edit(doc);
      if (block) block = await this.write(block, doc);
      else { const { data } = await this.api.request('PATCH', `/blocks/${entry.page.id}/children`, { children: [nativeContent(doc)] }); block = data.results?.[0]; if (!block) throw new ServiceError(503, '任务记录创建待确认'); }
    }
    return doc;
  }

  /** 单块原位替换并回读；expected防止覆盖已知新版本，写后校验拒绝静默丢失。 */
  async write(block, document, expected = blockVersion(block)) {
    const content = nativeContent(document, this.maxBytes); // 任何超限先拒绝，尚未发出远端写请求。
    const { data: fresh } = await this.api.request('GET', `/blocks/${block.id}`);
    if (plainText(fresh?.code?.rich_text) === JSON.stringify(document)) return fresh; // 相同写入重试直接确认，不制造新版本。
    if (blockVersion(fresh) !== expected) throw new ServiceError(409, '原生数据已被其他窗口修改，请先导出本地内容再重新加载');
    let failure;
    try { await this.api.request('PATCH', `/blocks/${block.id}`, content); } catch (error) { failure = error; }
    const { data: saved } = await this.api.request('GET', `/blocks/${block.id}`);
    if (failure && plainText(saved?.code?.rich_text) !== JSON.stringify(document)) throw failure;
    if (plainText(saved.code?.rich_text) !== JSON.stringify(document)) throw new ServiceError(409, '原生数据回读与保存内容不同，请保留本地内容并重新加载');
    return saved;
  }
  /** 创建稳定数据页及一个JSON块；输入已核验场景；输出可立即读回的目录项。 */
  async create(document) {
    await this.registry(false);
    const { data: folder } = await this.api.request('GET', `/blocks/${document.assetFolderId}`);
    if (!alive(folder) || folder.type !== 'folder' || (folder.parent?.page_id || folder.parent?.block_id) !== this.legacyRootId) throw new ServiceError(409, '目标图片文件夹不在授权根内');
    const candidates = [];
    for (const page of (await this.children(document.assetFolderId)).filter(b => b.type === 'child_page')) {
      const code = (await this.children(page.id)).find(b => b.type === 'code');
      if (!code) continue;
      let recovered;
      try { recovered = nativeDocument(code, this.maxBytes); } catch { continue; }
      if (recovered.kind === 'scene' && recovered.slug === document.slug && recovered.assetFolderId === document.assetFolderId) candidates.push({ page, code, recovered });
    }
    if (candidates.length > 1) throw new ServiceError(409, '文件夹内出现重复JSON数据页');
    if (candidates.length === 1) {
      const { page, code, recovered } = candidates[0];
      if (document.createId && recovered.createId !== document.createId) throw new ServiceError(409, '创建标识不匹配');
      const block = document.createId || JSON.stringify(recovered) === JSON.stringify(document) ? code : await this.write(code, document); // 恢复迁移时先写入最新源内容，禁止复用过期快照。
      document = nativeDocument(block, this.maxBytes);
      const entry = { native: true, page, block, document, folder: { id: document.assetFolderId, folder: { title: document.title } }, meta: { slug: document.slug, title: document.title } };
      await this.register(entry); return entry;
    }
    const { data: page } = await this.api.request('POST', '/pages', { parent: { page_id: document.assetFolderId }, properties: { title: { type: 'title', title: [{ type: 'text', text: { content: 'JSON 数据' } }] } }, children: [nativeContent(document, this.maxBytes)] }, undefined, document.createId ? `draw-page-${document.createId}` : undefined);
    const blocks = await this.children(page.id); const block = blocks.find(b => b.type === 'code');
    if (!block || plainText(block.code?.rich_text) !== JSON.stringify(document)) throw new ServiceError(409, '新建原生场景回读失败');
    const entry = { native: true, page: { ...page, child_page: { title: titleOf(page) } }, block, document, folder: { id: document.assetFolderId, folder: { title: document.title } }, meta: { slug: document.slug, title: document.title, uploadedBytes: document.uploadedBytes || 0 } };
    await this.register(entry); return entry;
  }
  /** 读取并更新同一个原生设置块；输入可选偏好和旧版本；输出偏好及新版本。 */
  async settings(update) {
    const registry = await this.registry();
    const matches = registry.blocks.filter(b => b.type === 'code').filter(b => nativeDocument(b, this.maxBytes).kind === 'settings');
    if (matches.length !== 1) throw new ServiceError(409, '原生全局设置块缺失或重复');
    let block = matches[0]; const doc = nativeDocument(block, this.maxBytes);
    let settings = normalizeSettings(doc.settings);
    if (update) {
      if (update.revision !== blockVersion(block)) throw new ServiceError(409, '全局设置已变化，请重新加载');
      settings = mergeSettings(settings, update.settings);
      if (JSON.stringify(settings) !== JSON.stringify(doc.settings) || JSON.stringify(doc.settingsHelp) !== JSON.stringify(SETTINGS_HELP)) {
        doc.settings = settings; doc.settingsHelp = SETTINGS_HELP;
        block = await this.write(block, doc, update.revision);
      }
    }
    return { settings, revision: blockVersion(block) };
  }
}
