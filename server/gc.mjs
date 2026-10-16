import { ServiceError } from './flowus.mjs';
import { blockVersion, digest } from './native.mjs';
import { normalizeSettings } from './settings.mjs';

export const GC_GRACE_MS = 24 * 60 * 60 * 1000; // 生产默认24小时，保留本地撤销和未保存编辑的恢复窗口。
const parentOf = block => block?.parent?.page_id || block?.parent?.block_id;
const live = block => block && !block.in_trash && !block.archived;
const plain = values => (values || []).map(v => v.plain_text ?? v.text?.content ?? '').join('');
const marker = 'excalidraw-flowus:';
const imageMime = value => ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'].includes(value);
const imageBlock = (block, meta) => imageMime(meta.mimeType) && (!block.file?.file?.content_type || block.file.file.content_type === meta.mimeType); // 官方GET只返回oss_name/size，MIME取已验证的场景映射。

/** 提取已提交场景的活跃图片引用；输入原生文档，输出fileId集合；不依赖files残留或tombstone。 */
export function activeFileIds(document) {
  if (!document?.scene || !Array.isArray(document.scene.elements) || !document.assets || typeof document.assets !== 'object' || Array.isArray(document.assets)) throw new ServiceError(409, '附件回收遇到损坏场景，已停止');
  const ids = new Set();
  for (const element of document.scene.elements) {
    if (!element || typeof element !== 'object') throw new ServiceError(409, '附件回收遇到损坏元素，已停止');
    if (element.type === 'image' && !element.isDeleted) {
      if (typeof element.fileId !== 'string' || !document.assets[element.fileId]?.blockId) throw new ServiceError(409, '活跃图片缺少附件映射，已停止回收');
      ids.add(element.fileId);
    }
  }
  return ids;
}

/** 受限附件回收器；输入仓库与内部测试时钟，输出可重启恢复的原生caption候选；不提供HTTP删除入口。 */
export class AssetCollector {
  constructor(store, { now = Date.now, graceMs, scanIntervalMs = 60000, batchLimit = 10 } = {}) {
    this.store = store; this.now = now; this.graceMs = graceMs ?? GC_GRACE_MS; this.testGraceMs = graceMs; this.scanIntervalMs = scanIntervalMs;
    this.batchLimit = batchLimit; this.pending = null;
  }
  /** 每轮及写入前读取FlowUs设置；非法或读取失败直接抛错，内部短宽限仅用于既有隔离测试。 */
  async policy() {
    const { settings } = await this.store.settings();
    const value = normalizeSettings(settings);
    return { enabled: value.assetGcEnabled, graceMs: this.testGraceMs ?? value.assetGcGraceHours * 3600000 };
  }
  /** 解析应用片段；其它用户caption保留，重复或损坏片段拒绝认领。 */
  metadata(block) {
    if (block?.type !== 'file') return null;
    const values = (block.file?.caption || []).map(v => v.plain_text ?? v.text?.content ?? '').filter(v => v.startsWith(marker));
    if (values.length !== 1) return null;
    try { return JSON.parse(values[0].slice(marker.length)); } catch { return null; }
  }
  /** 指纹绑定块、父目录和对象；caption被外部修改不改变对象指纹。 */
  fingerprint(block, meta) { return digest(JSON.stringify({ blockId: block.id, folderId: parentOf(block), ossName: block.file?.file?.oss_name, hash: meta.hash })); }
  /** 仅修改本应用metadata；保留文件本体与用户caption，回读失败时停止本轮回收。 */
  async patch(block, metadata, requireEnabled = false) {
    if (requireEnabled && !(await this.policy()).enabled) return null; // 关闭后候选保持原样，正常保存的归属登记独立保留。
    const caption = (block.file.caption || []).filter(v => !plain([v]).startsWith(marker)).map(v => structuredClone(v));
    caption.push({ type: 'text', text: { content: marker + JSON.stringify(metadata) } });
    await this.store.api.request('PATCH', `/blocks/${block.id}`, { type: 'file', file: { ...block.file, caption } });
    const { data: fresh } = await this.store.api.request('GET', `/blocks/${block.id}`);
    if (!live(fresh) || this.fingerprint(fresh, metadata) !== this.fingerprint(block, metadata) || JSON.stringify(this.metadata(fresh)) !== JSON.stringify(metadata)) throw new ServiceError(409, '附件回收标记回读失败，已停止');
    return fresh;
  }
  /** 登记已经校验哈希的已提交图片；调用方须持有画布锁；不领养手工文件或跨目录来源。 */
  async register(entry, blocks, document, remaining = { count: Infinity }, requireEnabled = false) {
    if (!entry.native) return;
    for (const fileId of activeFileIds(document)) {
      const asset = document.assets[fileId];
      const block = blocks.find(b => b.id === asset.blockId);
      const meta = this.metadata(block);
      if (!live(block) || parentOf(block) !== entry.folder.id || meta?.kind !== 'asset' || meta.hash !== asset.hash || !/^[0-9a-f]{64}$/.test(meta.hash) || !block.file?.file?.oss_name) throw new ServiceError(409, '图片归属异常，未登记回收权限');
      if (meta.ownerSlug && (meta.ownerSlug !== entry.meta.slug || meta.ownerFolderId !== entry.folder.id)) throw new ServiceError(409, '图片来源跨画布，已停止回收登记');
      if (!imageMime(asset.mimeType)) throw new ServiceError(409, '图片类型无法验证，未登记回收权限');
      if (meta.ownerSlug === entry.meta.slug && meta.ownerFolderId === entry.folder.id && meta.committed === true && meta.mimeType === asset.mimeType) continue;
      if (remaining.count <= 0) break;
      const fresh = await this.patch(block, { ...meta, mimeType: asset.mimeType, ownerSlug: entry.meta.slug, ownerFolderId: entry.folder.id, committed: true }, requireEnabled);
      if (!fresh) return;
      remaining.count--;
      blocks[blocks.indexOf(block)] = fresh;
    }
  }
  /** 旧未用图片仅凭同folder迁移备份映射和真实字节哈希认领；证据缺失时保持原文件。 */
  async adoptLegacy(entry, blocks, remaining) {
    if (!(await this.policy()).enabled) return;
    const backupId = entry.document.legacyBackupFileId;
    if (!backupId || remaining.count <= 0) return;
    const backup = blocks.find(block => block.id === backupId);
    const tag = this.metadata(backup);
    if (tag?.kind !== 'scene-backup' || tag.slug !== entry.meta.slug || tag.nativeBlockId !== entry.block.id || parentOf(backup) !== entry.folder.id) return;
    const candidates = blocks.filter(block => { const meta = this.metadata(block); return meta?.kind === 'asset' && (!meta.ownerSlug || (meta.ownerSlug === entry.meta.slug && meta.ownerFolderId === entry.folder.id && !meta.mimeType)); });
    if (!candidates.length) return;
    let document;
    try { document = JSON.parse((await this.store.download(backup, 4 * 1024 ** 2)).toString('utf8')); }
    catch { throw new ServiceError(409, '旧附件备份不可验证，已停止本轮回收'); }
    if (document.slug !== entry.meta.slug || !document.assets || typeof document.assets !== 'object' || Array.isArray(document.assets)) throw new ServiceError(409, '旧附件备份归属异常');
    for (const block of candidates) {
      if (remaining.count <= 0) break;
      const meta = this.metadata(block);
      const proof = Object.values(document.assets).find(asset => asset?.blockId === block.id && asset.hash === meta.hash);
      if (!proof || !imageMime(proof.mimeType) || parentOf(block) !== entry.folder.id || !/^[0-9a-f]{64}$/.test(meta.hash) || (block.file?.file?.content_type && block.file.file.content_type !== proof.mimeType)) continue;
      if (digest(await this.store.download(block, 10 * 1024 ** 2)) !== meta.hash) throw new ServiceError(409, '旧附件哈希不一致，已停止本轮回收');
      const fresh = await this.patch(block, { ...meta, mimeType: proof.mimeType, ownerSlug: entry.meta.slug, ownerFolderId: entry.folder.id, committed: true }, true);
      if (!fresh) return;
      blocks[blocks.indexOf(block)] = fresh; remaining.count--;
    }
  }
  /** 读取最新全局引用；任一已登记页面/场景/父目录异常则整轮失败，避免在不完整视图上删除。 */
  async references() {
    const entries = await this.store.native.entries(); const references = new Map();
    for (const entry of entries) {
      const { data: folder } = await this.store.api.request('GET', `/blocks/${entry.folder.id}`);
      if (!live(folder) || folder.type !== 'folder' || parentOf(folder) !== this.store.rootId) throw new ServiceError(409, '画布目录归属异常，已停止回收');
      activeFileIds(entry.document);
      for (const asset of Object.values(entry.document.assets)) {
        if (!asset || typeof asset.blockId !== 'string' || typeof asset.hash !== 'string') throw new ServiceError(409, '附件映射异常，已停止回收');
        const owners = references.get(asset.blockId) || new Set(); owners.add(entry.folder.id); references.set(asset.blockId, owners);
      }
    }
    return { entries, references };
  }
  /** 一次只处理本folder；调用方须持有同一画布保存锁，所有候选仅来自已提交原生scene。 */
  async observe(slug, { remaining = { count: this.batchLimit }, global, allowDelete = true } = {}) {
    const policy = await this.policy();
    if (!policy.enabled) return { marked: 0, trashed: 0 };
    const view = global || await this.references();
    const entry = await this.store.native.resolve(slug);
    if (!entry?.native) return { marked: 0, trashed: 0 };
    const used = new Set([...activeFileIds(entry.document)].map(id => entry.document.assets[id].blockId));
    const version = blockVersion(entry.block); const now = this.now();
    const blocks = await this.store.children(entry.folder.id); let marked = 0, trashed = 0;
    for (const block of blocks) {
      if (remaining.count <= 0) break;
      const meta = this.metadata(block);
      if (meta?.kind !== 'asset' || meta.ownerSlug !== slug || meta.ownerFolderId !== entry.folder.id || meta.committed !== true || !/^[0-9a-f]{64}$/.test(meta.hash) || !block.file?.file?.oss_name || parentOf(block) !== entry.folder.id || !imageBlock(block, meta)) continue;
      const owners = view.references.get(block.id);
      if (owners && [...owners].some(folderId => folderId !== entry.folder.id)) continue; // 跨画布引用保持原状，不猜测来源。
      if (used.has(block.id)) {
        if (meta.gc) { const { gc, ...retained } = meta; if (!await this.patch(block, retained, true)) return { marked, trashed }; remaining.count--; }
        continue;
      }
      const fingerprint = this.fingerprint(block, meta); const old = meta.gc;
      const valid = old && old.fingerprint === fingerprint && Number.isFinite(old.firstSeenAt) && old.firstSeenAt <= now && Number.isFinite(old.lastCheckedAt) && old.lastCheckedAt <= now && Number.isInteger(old.scans) && old.scans > 0;
      if (valid && now - old.lastCheckedAt < this.scanIntervalMs) continue;
      const gc = { firstSeenAt: valid ? old.firstSeenAt : now, lastCheckedAt: now, sceneRevision: version, scans: valid && old.sceneRevision === version ? Math.min(old.scans + 1, 1000) : 1, fingerprint };
      if (!valid || gc.scans < 2 || now - gc.firstSeenAt < policy.graceMs) {
        if (!await this.patch(block, { ...meta, gc }, true)) return { marked, trashed }; remaining.count--; marked++; continue;
      }
      if (!allowDelete) continue; // 保存请求只登记候选，实际删除统一交给后台专用流程。
      // 删除前完整重读最新全局引用与本块；官方DELETE没有CAS，外部writer仍有极短竞态窗口。
      const latestView = await this.references();
      const latest = latestView.entries.find(value => value.meta.slug === slug);
      if (!latest || blockVersion(latest.block) !== version) continue;
      const latestUsed = new Set([...activeFileIds(latest.document)].map(id => latest.document.assets[id].blockId));
      const foreign = latestView.references.get(block.id);
      if (latestUsed.has(block.id) || (foreign && [...foreign].some(folderId => folderId !== entry.folder.id))) continue;
      const { data: fresh } = await this.store.api.request('GET', `/blocks/${block.id}`);
      const freshMeta = this.metadata(fresh);
      if (!live(fresh) || parentOf(fresh) !== entry.folder.id || freshMeta?.kind !== 'asset' || freshMeta.committed !== true || freshMeta.ownerSlug !== slug || freshMeta.ownerFolderId !== entry.folder.id || freshMeta.hash !== meta.hash || !imageBlock(fresh, freshMeta) || this.fingerprint(fresh, freshMeta) !== fingerprint || JSON.stringify(freshMeta.gc) !== JSON.stringify(old)) continue;
      if (digest(await this.store.download(fresh, 10 * 1024 ** 2)) !== meta.hash) throw new ServiceError(409, '候选附件真实哈希变化，已停止回收');
      const finalEntry = await this.store.native.resolve(slug);
      if (!finalEntry || blockVersion(finalEntry.block) !== version || [...activeFileIds(finalEntry.document)].some(id => finalEntry.document.assets[id].blockId === fresh.id)) continue;
      const currentPolicy = await this.policy();
      if (!currentPolicy.enabled) return { marked, trashed };
      if (this.now() - old.firstSeenAt < currentPolicy.graceMs) continue; // 扫描期间加长宽限也必须立即保护候选。
      const { data: result } = await this.store.api.request('DELETE', `/blocks/${fresh.id}`);
      if (result?.id !== fresh.id || result?.in_trash !== true) throw new ServiceError(503, 'FlowUs 未确认附件进入回收站，稍后重试');
      remaining.count--; trashed++;
      this.store.signedMaps.delete(entry.folder.id);
    }
    return { marked, trashed };
  }
  /** 定时单实例回收；防止重入、限制每批变更，重启后从FlowUs caption恢复。 */
  async run() {
    if (!this.store.native) return { marked: 0, trashed: 0 };
    if (this.pending) return this.pending;
    const work = async () => {
      if (!(await this.policy()).enabled) return { marked: 0, trashed: 0 };
      const global = await this.references(); const remaining = { count: this.batchLimit }; const total = { marked: 0, trashed: 0 };
      for (const entry of global.entries) {
        if (remaining.count <= 0) break;
        const result = await this.store.locked(`canvas:${entry.meta.slug}`, async () => {
          if (!(await this.policy()).enabled) return { marked: 0, trashed: 0 };
          // 中断发生在提交与登记之间时，仅对当前可下载并通过哈希验证的活跃图片补登记。
          const latest = await this.store.native.resolve(entry.meta.slug);
          const blocks = await this.store.children(entry.folder.id);
          // 无闲置附件、失败任务或标题待同步时，结束本画布扫描；此分支不写入也不删除。
          const used = new Set([...activeFileIds(latest.document)].map(id => latest.document.assets[id].blockId));
          const files = blocks.filter(block => block.type === 'file');
          const cleanFiles = files.every(block => {
            const meta = this.metadata(block), asset = Object.values(latest.document.assets).find(a => a.blockId === block.id);
            return used.has(block.id) && meta?.kind === 'asset' && meta.committed === true && !meta.gc &&
              meta.ownerSlug === latest.meta.slug && meta.ownerFolderId === latest.folder.id &&
              meta.hash === asset?.hash && meta.mimeType === asset?.mimeType && imageBlock(block, meta);
          });
          if (cleanFiles && [...used].every(id => files.some(block => block.id === id)) && latest.folder.folder.title === latest.document.title) {
            const tasks = this.store.recovery ? await this.store.native.tasks(latest) : { uploads: {} };
            if (Object.keys(tasks.uploads).length === 0) return { marked: 0, trashed: 0 };
          }
          const needsRegistration = [...activeFileIds(latest.document)].some(id => { const meta = this.metadata(blocks.find(b => b.id === latest.document.assets[id].blockId)); return meta?.kind === 'asset' && (!meta.committed || !meta.mimeType); });
          if (needsRegistration) { const validated = await this.store.readEntry(latest); await this.register(latest, blocks, validated.document, remaining, true); }
          await this.adoptLegacy(latest, blocks, remaining);
          if (this.store.recovery) {
            await this.store.recovery.recoverUploads(latest, remaining);
            const policy = await this.policy();
            if (policy.enabled && latest.folder.folder.title !== latest.document.title) {
              await this.store.api.request('PATCH', `/blocks/${latest.folder.id}`, { type: 'folder', folder: { title: latest.document.title } });
            }
          }
          return this.observe(entry.meta.slug, { remaining, global });
        });
        total.marked += result.marked; total.trashed += result.trashed;
      }
      if (this.store.recovery && remaining.count > 0) await this.store.locked('root', () => this.store.recovery.recoverCreates(remaining));
      return total;
    };
    const pending = work(); this.pending = pending;
    try { return await pending; } finally { this.pending = null; }
  }
}

/** 每十分钟执行轻量扫描；只读维护时禁用，返回可等待当前任务结束的停止器。 */
export function startAssetCollector(store, { intervalMs = 10 * 60000, onError = () => console.error('附件回收失败，保留候选等待下次重试') } = {}) {
  let stopped = false; let running;
  const tick = () => { if (stopped || running) return; running = store.collectGarbage().catch(onError).finally(() => { running = undefined; }); };
  const timer = setInterval(tick, intervalMs); timer.unref();
  const first = setTimeout(tick, 30000); first.unref();
  return async () => { stopped = true; clearInterval(timer); clearTimeout(first); await running; };
}
