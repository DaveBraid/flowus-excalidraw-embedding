import { randomUUID } from 'node:crypto';
import { ServiceError, validSlug } from './flowus.mjs';
import { nativeContent, nativeDocument, blockVersion, digest } from './native.mjs';
import { activeFileIds } from './gc.mjs';

const opPattern = /^[a-zA-Z0-9_-]{8,80}$/;
const live = b => b && !b.in_trash && !b.archived;
const parent = b => b?.parent?.page_id || b?.parent?.block_id;
const mimeExt = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };
const pending = message => new ServiceError(503, message, 'OPERATION_PENDING');
export function operationId(value) { if (!opPattern.test(value || '') || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new ServiceError(400, '操作ID格式无效'); return value; }

/** 原生画布的可恢复操作；所有持久任务仍保存在FlowUs，调用方保持单实例画布锁。 */
export class Recovery {
  constructor(store) { this.store = store; this.native = store.native; this.tickets = new Map(); }
  /** 只读取结构与归属，不下载图片；返回可验证的附件描述。 */
  async light(entry) {
    const { data: folder } = await this.store.api.request('GET', `/blocks/${entry.folder.id}`);
    if (!live(folder) || folder.type !== 'folder' || parent(folder) !== this.store.rootId) throw new ServiceError(409, '画布目录已移出数据根');
    const doc = entry.document; activeFileIds(doc);
    const blocks = await this.store.children(entry.folder.id); const assets = {}; const missing = [];
    for (const id of activeFileIds(doc)) {
      const asset = doc.assets[id]; const block = blocks.find(b => b.id === asset.blockId);
      const meta = this.store.gc.metadata(block);
      if (!asset || !/^[a-f0-9]{64}$/.test(asset.hash) || !mimeExt[asset.mimeType]) throw new ServiceError(409, '图片描述损坏');
      const absent = !live(block) || parent(block) !== entry.folder.id || meta?.kind !== 'asset' || meta.hash !== asset.hash;
      assets[id] = { ...asset, missing: absent }; if (absent) missing.push(id);
    }
    return { document: doc, blocks, canvas: { ...this.store.summary(entry), scene: { ...doc.scene, files: {} }, assets, missingAssets: missing } };
  }
  /** 查询一次保存是否已提交；晚于此操作的版本不能伪装成本次响应。 */
  async status(slug, id) {
    operationId(id); const entry = await this.store.resolve(slug);
    const commits = entry.document.commits || []; const receipt = commits.find(c => c.id === id);
    if (!receipt) return { status: 'unknown', operationId: id };
    return { status: 'committed', operationId: id, superseded: commits.at(-1)?.id !== id, canvas: this.result(entry, id) };
  }
  result(entry, id) { return { ...this.store.summary(entry), assets: entry.document.assets, operationId: id, superseded: entry.document.commits?.at(-1)?.id !== id }; }
  /** 原位记录意图后创建；文件夹唯一临时名在首次请求中写入，响应丢失后只查找、不盲目再建。 */
  async create({ title = '未命名画布', slug, operationId: id = randomUUID() } = {}) {
    operationId(id);
    if (typeof title !== 'string' || !title.trim() || title.length > 120 || (slug !== undefined && !validSlug(slug))) throw new ServiceError(400, '标题或链接标识无效');
    title = title.trim(); const fingerprint = digest(JSON.stringify({ title, slug: slug || null }));
    const registry = await this.native.registry(); let job = registry.document.creations?.[id];
    if (job && job.fingerprint !== fingerprint) throw new ServiceError(409, '同一创建操作不能更换内容');
    slug = job?.slug || slug || `c-${id.slice(0, 12).toLowerCase()}`;
    const ref = registry.document.canvases[slug];
    if (ref) { if (job && !ref.state) { const existing = await this.native.readReference(slug, ref); if (existing.document.createId !== id) throw new ServiceError(409, '同名画布不属于原创建操作'); return this.store.load(slug); } throw new ServiceError(409, '画布链接已存在或被保留'); }
    if (job?.state === 'cleaned') throw new ServiceError(410, '创建任务已过期清理，请重新发起');
    if (!job) {
      if (Object.values(registry.document.creations || {}).some(j => j.slug === slug && j.state !== 'cleaned')) throw new ServiceError(409, '同名画布正在创建，请检查原创建操作');
      job = { id, slug, title, fingerprint, at: Date.now(), state: 'prepared', marker: `⏳ ${title.slice(0, 45)} [${id}]` };
      await this.native.editRegistry(doc => { doc.creations ||= {}; doc.creations[id] = job; });
    }
    const folders = (await this.store.children(this.store.rootId)).filter(b => b.type === 'folder');
    let folder = folders.find(b => b.id === job.folderId);
    if (!folder) {
      const matches = folders.filter(b => b.folder.title === job.marker);
      if (matches.length > 1) throw new ServiceError(409, '创建任务出现重复文件夹，请检查');
      folder = matches[0];
    }
    if (!folder) {
      if (job.state !== 'prepared') throw pending('正在确认原文件夹创建结果；未重复创建，请稍后重试');
      job = { ...job, state: 'folder-requested' };
      await this.native.editRegistry(doc => { doc.creations[id] = job; });
      const { data } = await this.store.api.request('PATCH', `/blocks/${this.store.rootId}/children`, { children: [{ type: 'folder', folder: { title: job.marker } }] });
      folder = data.results?.[0]; if (!folder) throw pending('文件夹创建结果待确认');
    }
    job = { ...job, folderId: folder.id, state: 'page-requested' };
    await this.native.editRegistry(doc => { doc.creations[id] = job; });
    const entry = await this.native.create({ schemaVersion: 2, kind: 'scene', slug, title, createId: id, assetFolderId: folder.id, scene: { elements: [], appState: {}, files: {} }, assets: {}, uploadedBytes: 0 });
    try {
      await this.store.api.request('PATCH', `/blocks/${folder.id}`, { type: 'folder', folder: { title } });
      await this.native.editRegistry(doc => { doc.creations[id] = { ...job, state: 'complete' }; const completed = Object.values(doc.creations).filter(j => j.state === 'complete').sort((a, b) => b.at - a.at); for (const old of completed.slice(64)) delete doc.creations[old.id]; });
    } catch { console.error('创建已提交，文件夹名称待后台同步'); }
    return { canvas: { ...this.store.summary(entry), scene: entry.document.scene, assets: {} } };
  }
  /** 上传前保存对象标识；上传成功而挂载失败时可用同一对象恢复，绝不重新上传JSON。 */
  async uploadAsset(entry, id, bytes, mimeType, hash, blocks) {
    const store = this.store;
    const tasks = await this.native.tasks(entry);
    const existingTask = Object.entries(tasks.uploads).find(([, t]) => t.operationId === id && t.hash === hash && t.state !== 'empty');
    const taskKey = existingTask?.[0] || `${id}:${hash}:${randomUUID().slice(0, 8)}`;
    let task = existingTask?.[1];
    let ticket = this.tickets.get(taskKey);
    if (!task) {
      if (Object.keys(tasks.uploads).length >= 400) throw new ServiceError(413, '未完成上传任务过多，请先处理旧任务');
      if (Date.now() - store.uploadWindow.startedAt > 60000) store.uploadWindow = { startedAt: Date.now(), bytes: 0 };
      if (store.uploadWindow.bytes + bytes.length > store.uploadBytesPerMinute) throw new ServiceError(429, '上传达到每分钟额度');
      store.uploadWindow.bytes += bytes.length;
      ticket = (await store.api.request('POST', '/files/upload-url', { filename: `${hash}.${mimeExt[mimeType]}`, content_type: mimeType, content_length: bytes.length, parent: { type: 'page_id', page_id: entry.folder.id } })).data;
      task = { operationId: id, hash, at: Date.now(), file: { oss_name: ticket.oss_name, size: bytes.length, content_type: mimeType }, state: 'allocated' };
      await this.native.tasks(entry, doc => { doc.uploads[taskKey] = task; }); // 此写入确认前不发送任何图片字节。
    }
    if (ticket) {
      this.tickets.set(taskKey, ticket); if (this.tickets.size > 200) this.tickets.delete(this.tickets.keys().next().value);
      const url = new URL(ticket.upload_url);
      if (url.protocol !== 'https:' || url.username || url.password || !/(^|\.)(flowus\.cn|myqcloud\.com|tencentcos\.cn)$/.test(url.hostname)) throw new ServiceError(502, '上传地址不符合策略');
      const result = await store.fetch(url, { method: 'PUT', headers: ticket.headers, body: bytes, signal: AbortSignal.timeout(60000), redirect: 'error' });
      if (!result.ok) { this.tickets.delete(taskKey); throw pending('图片上传待确认，任务已保留'); }
    }
    let block = blocks.find(b => b.file?.file?.oss_name === task.file.oss_name && store.gc.metadata(b)?.taskKey === taskKey);
    if (!block) {
      const meta = { kind: 'asset', hash, mimeType, ownerSlug: entry.meta.slug, ownerFolderId: entry.folder.id, committed: false, taskKey, createdAt: task.at };
      const { data } = await store.api.request('PATCH', `/blocks/${entry.folder.id}/children`, { children: [{ type: 'file', file: store.fileContent(task.file, meta) }] });
      block = data.results?.[0]; if (!block) throw pending('附件挂载结果待确认'); blocks.push(block);
    }
    if (!ticket) {
      try { if (digest(await store.download(block, 10 * 1024 ** 2)) !== hash) throw new ServiceError(409, '恢复附件内容不一致，未提交画布'); }
      catch (error) { if (error.code === 'OBJECT_NOT_FOUND') { await this.native.tasks(entry, doc => { doc.uploads[taskKey] = { ...task, state: 'empty', blockId: block.id }; }); throw pending('原图片未完成上传，已登记空对象；再次重试将补传'); } throw error; }
    }
    await this.native.tasks(entry, doc => { doc.uploads[taskKey] = { ...task, state: 'attached', blockId: block.id }; });
    this.tickets.delete(taskKey); return block;
  }
  /** 保存原生场景：先校验版本与附件，操作凭证随场景单块提交，后续维护不影响成功结果。 */
  async save(slug, input) {
    const store = this.store, id = operationId(input.operationId || randomUUID());
    const fingerprint = digest(JSON.stringify({ revision: input.revision, scene: input.scene, title: input.title }));
    const entry = await store.resolve(slug); const previous = entry.document;
    const receipt = (previous.commits || []).find(c => c.id === id);
    if (receipt) { if (receipt.fingerprint !== fingerprint) throw new ServiceError(409, '同一保存操作不能更换内容'); return { canvas: this.result(entry, id) }; }
    if (!input.revision || input.revision !== blockVersion(entry.block)) throw new ServiceError(409, '画布已有其他修改，请保留本地内容', 'VERSION_CONFLICT');
    const current = await this.light(entry); const blocks = current.blocks;
    const title = input.title ?? previous.title;
    if (typeof title !== 'string' || !title.trim() || title.length > 120) throw new ServiceError(400, '画布标题须为1–120字符');
    const scene = structuredClone(input.scene ?? { ...previous.scene, files: Object.fromEntries(Object.entries(previous.assets).map(([key, a]) => [key, { id: key, hash: a.hash, mimeType: a.mimeType }])) });
    if (!scene || !Array.isArray(scene.elements) || scene.elements.length > 10000 || !scene.appState || typeof scene.appState !== 'object' || Array.isArray(scene.appState) || !scene.files || typeof scene.files !== 'object' || Array.isArray(scene.files)) throw new ServiceError(400, '场景格式无效');
    const used = new Set(scene.elements.filter(e => e?.type === 'image' && !e.isDeleted).map(e => e.fileId));
    if (used.size > 200 || scene.elements.some(e => !e || typeof e.id !== 'string')) throw new ServiceError(400, '场景元素无效');
    const assets = {}, prepared = []; let totalBytes = 0, uploaded = previous.uploadedBytes || 0;
    for (const fileId of used) {
      const file = scene.files[fileId]; if (!file) throw new ServiceError(400, '图片引用缺失，未保存');
      const { dataURL, hash: claimed, missing, ...properties } = file;
      let hash = claimed, bytes, mimeType = file.mimeType, block;
      if (dataURL) {
        const match = typeof dataURL === 'string' && dataURL.match(/^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,([A-Za-z0-9+/=]+)$/);
        if (!match || match[1] !== mimeType) throw new ServiceError(400, '图片格式无效');
        bytes = Buffer.from(match[2], 'base64'); hash = digest(bytes);
        if (!bytes.length || bytes.length > 10 * 1024 ** 2) throw new ServiceError(413, '图片超出容量');
        block = blocks.filter(b => store.gc.metadata(b)?.kind === 'asset' && store.gc.metadata(b)?.hash === hash).sort((a, b) => Number(store.gc.metadata(b)?.committed === true) - Number(store.gc.metadata(a)?.committed === true))[0];
      } else {
        const known = previous.assets[fileId];
        if (!known || known.hash !== hash || known.mimeType !== mimeType) throw new ServiceError(409, '图片引用未在本画布保存，请重新提供原图', 'ASSET_MISSING');
        block = blocks.find(b => b.id === known.blockId && store.gc.metadata(b)?.hash === hash);
        if (!block) throw new ServiceError(409, '图片已被手动删除，请恢复原图或明确移除对应图片', 'ASSET_MISSING');
        Object.assign(properties, known.properties, { id: fileId, mimeType });
      }
      if (block && bytes && store.gc.metadata(block)?.committed !== true) {
        try { if (digest(await store.download(block, 10 * 1024 ** 2)) !== hash) throw new ServiceError(409, '未提交附件校验失败'); }
        catch (error) { if (error.code !== 'OBJECT_NOT_FOUND') throw error; block = undefined; }
      }
      totalBytes += bytes?.length ?? block?.file?.file?.size ?? 10 * 1024 ** 2;
      const asset = { blockId: block?.id || '00000000-0000-4000-8000-000000000000', hash, mimeType, properties };
      assets[fileId] = asset; prepared.push({ fileId, bytes, mimeType, hash, block });
    }
    if (totalBytes > 20 * 1024 ** 2) throw new ServiceError(413, '图片总量超过20MiB');
    const document = { ...previous, title: title.trim(), scene: { ...scene, files: {} }, assets, commits: [...(previous.commits || []).slice(-31), { id, fingerprint, at: Date.now() }] };
    nativeContent(document, this.native.maxBytes); // 包含所有映射与操作凭证的容量检查先于上传。
    for (const asset of prepared) {
      if (!asset.block) { asset.block = await this.uploadAsset(entry, id, asset.bytes, asset.mimeType, asset.hash, blocks); uploaded += asset.bytes.length; }
      assets[asset.fileId].blockId = asset.block.id;
    }
    document.uploadedBytes = uploaded;
    const saved = await this.native.write(entry.block, document, input.revision);
    const fresh = { ...entry, block: saved, document, meta: { ...entry.meta, title: document.title, uploadedBytes: uploaded } };
    try { if (entry.folder.folder.title !== document.title) await store.api.request('PATCH', `/blocks/${entry.folder.id}`, { type: 'folder', folder: { title: document.title } }); } catch { console.error('场景已保存，文件夹名称待同步'); }
    await store.afterCommit(slug, fresh, blocks, document);
    await store.thumbnails.remove(slug).catch(() => {}); // 旧派生图失效不改变场景提交结果。
    const result = this.result(fresh, id);
    if (!input.operationId) result.scene = input.scene || { ...document.scene, files: {} }; // 兼容既有客户端；新协议仅返回描述。
    return { canvas: result };
  }
  /** 清理确有任务凭证的失败上传；完整引用、到期、双扫描和画布锁缺一不可。 */
  async recoverUploads(entry, remaining) {
    const store = this.store; let tasks = await this.native.tasks(entry);
    for (const [key, task] of Object.entries(tasks.uploads)) {
      if (remaining.count <= 0) break;
      let policy = (await store.settings()).settings;
      if (!policy.assetGcEnabled) return;
      if (!Number.isFinite(task.at) || !/^[a-f0-9]{64}$/.test(task.hash) || !opPattern.test(task.operationId || '') || !task.file?.oss_name || !mimeExt[task.file.content_type]) throw new ServiceError(409, '失败附件任务损坏，停止清理');
      const latest = await store.resolve(entry.meta.slug);
      const refs = new Set(Object.values(latest.document.assets).map(a => a.blockId));
      const blocks = await store.children(entry.folder.id);
      let block = blocks.find(b => b.file?.file?.oss_name === task.file.oss_name && store.gc.metadata(b)?.taskKey === key);
      if (block && refs.has(block.id)) { await this.native.tasks(entry, doc => { delete doc.uploads[key]; }); remaining.count--; continue; }
      if (Date.now() - task.at < policy.failedTaskRetentionHours * 3600000) continue;
      if (!block && task.state === 'deleting' && task.blockId) {
        const { data: prior } = await store.api.request('GET', `/blocks/${task.blockId}`);
        if (prior?.in_trash === true) { await this.native.tasks(entry, doc => { delete doc.uploads[key]; }); remaining.count--; continue; }
        throw pending('附件回收结果尚无法确认，保留任务且不重复挂载');
      }
      if (!block) {
        // 已分配的对象只补挂文件块；不重新上传字节，后续仍需下载验证。
        const meta = { kind: 'asset', hash: task.hash, mimeType: task.file.content_type, ownerSlug: entry.meta.slug, ownerFolderId: entry.folder.id, committed: false, taskKey: key, createdAt: task.at };
        const { data } = await store.api.request('PATCH', `/blocks/${entry.folder.id}/children`, { children: [{ type: 'file', file: store.fileContent(task.file, meta) }] });
        block = data.results?.[0]; if (!block) throw pending('恢复失败附件挂载待确认'); remaining.count--;
      }
      const meta = store.gc.metadata(block);
      if (parent(block) !== entry.folder.id || meta?.ownerFolderId !== entry.folder.id || meta.ownerSlug !== entry.meta.slug || meta.hash !== task.hash || meta.taskKey !== key) throw new ServiceError(409, '失败附件归属不匹配');
      const version = blockVersion(latest.block);
      if (!task.checkedAt || Date.now() - task.checkedAt < 60000 || task.checkedRevision !== version) {
        if (!task.checkedAt || task.checkedRevision !== version) { await this.native.tasks(entry, doc => { doc.uploads[key] = { ...task, blockId: block.id, checkedAt: Date.now(), checkedRevision: version }; }); remaining.count--; }
        continue;
      }
      const view = await store.gc.references();
      if (view.references.has(block.id)) continue;
      try { if (digest(await store.download(block, 10 * 1024 ** 2)) !== task.hash) throw new ServiceError(409, '失败附件实际内容与任务不一致'); }
      catch (error) { if (error.code !== 'OBJECT_NOT_FOUND') throw error; } // 官方对象明确404时仅清理本任务生成的空文件块。
      const finalEntry = await store.resolve(entry.meta.slug); const currentTasks = await this.native.tasks(entry);
      if (blockVersion(finalEntry.block) !== version || JSON.stringify(currentTasks.uploads[key]) !== JSON.stringify(task)) continue;
      policy = (await store.settings()).settings;
      if (!policy.assetGcEnabled || Date.now() - task.at < policy.failedTaskRetentionHours * 3600000) return;
      const { data: freshBlock } = await store.api.request('GET', `/blocks/${block.id}`);
      if (!live(freshBlock) || parent(freshBlock) !== entry.folder.id || freshBlock.file?.file?.oss_name !== task.file.oss_name || JSON.stringify(store.gc.metadata(freshBlock)) !== JSON.stringify(meta)) continue;
      await this.native.tasks(entry, doc => { doc.uploads[key] = { ...task, blockId: block.id, state: 'deleting' }; });
      const lastPolicy = (await store.settings()).settings;
      if (!lastPolicy.assetGcEnabled || Date.now() - task.at < lastPolicy.failedTaskRetentionHours * 3600000) return;
      const { data: result } = await store.api.request('DELETE', `/blocks/${block.id}`);
      if (result?.id !== block.id || result.in_trash !== true) throw pending('失败附件回收结果待确认');
      await this.native.tasks(entry, doc => { delete doc.uploads[key]; }); remaining.count--;
    }
  }
  /** 失败创建只回收带原任务标记且没有用户额外内容的目录；已登记画布永不自动删除。 */
  async recoverCreates(remaining) {
    const store = this.store, registry = await this.native.registry();
    for (const job of Object.values(registry.document.creations || {})) {
      if (remaining.count <= 0) break;
      if (registry.document.canvases[job.slug] || job.state === 'cleaned' || job.state === 'complete') continue;
      const policy = (await store.settings()).settings;
      if (!policy.assetGcEnabled) return;
      if (!Number.isFinite(job.at) || Date.now() - job.at < policy.failedTaskRetentionHours * 3600000) continue;
      const matches = (await store.children(store.rootId)).filter(b => b.type === 'folder' && b.folder.title === job.marker && (!job.folderId || b.id === job.folderId));
      if (!matches.length) {
        if (!job.checkedAt) { await this.native.editRegistry(doc => { doc.creations[job.id].checkedAt = Date.now(); }); remaining.count--; }
        else if (Date.now() - job.checkedAt >= 60000) { await this.native.editRegistry(doc => { doc.creations[job.id] = { ...job, state: 'cleaned' }; }); remaining.count--; }
        continue; // 没有匹配目录时仅过期任务记录，不推断或删除其它位置的内容。
      }
      if (matches.length !== 1) continue;
      const folder = matches[0]; const children = await store.children(folder.id); let safe = true;
      for (const page of children) {
        if (page.type !== 'child_page') { safe = false; break; }
        const parts = await store.children(page.id);
        if (parts.length !== 1 || parts[0].type !== 'code') { safe = false; break; }
        let doc; try { doc = nativeDocument(parts[0]); } catch { safe = false; break; }
        if (doc.createId !== job.id || doc.assetFolderId !== folder.id || doc.slug !== job.slug || doc.scene.elements.length || Object.keys(doc.assets).length) { safe = false; break; }
      }
      if (!safe) continue;
      if (!job.checkedAt || Date.now() - job.checkedAt < 60000) { if (!job.checkedAt) { await this.native.editRegistry(doc => { doc.creations[job.id].checkedAt = Date.now(); }); remaining.count--; } continue; }
      await store.gc.references(); // 任一在册画布引用不完整时不执行失败目录删除。
      const final = await this.native.registry(); const freshPolicy = (await store.settings()).settings;
      if (final.document.canvases[job.slug] || !freshPolicy.assetGcEnabled || Date.now() - job.at < freshPolicy.failedTaskRetentionHours * 3600000) continue;
      await this.native.editRegistry(doc => { doc.creations[job.id] = { ...job, state: 'cleaning' }; });
      const lastPolicy = (await store.settings()).settings; if (!lastPolicy.assetGcEnabled || Date.now() - job.at < lastPolicy.failedTaskRetentionHours * 3600000) return;
      const { data: result } = await store.api.request('DELETE', `/blocks/${folder.id}`);
      if (result?.id !== folder.id || result.in_trash !== true) throw pending('失败创建回收结果待确认');
      await this.native.editRegistry(doc => { doc.creations[job.id] = { ...job, state: 'cleaned' }; }); remaining.count--;
    }
    const fresh = await this.native.registry();
    const terminal = Object.values(fresh.document.creations || {}).filter(j => ['complete', 'cleaned'].includes(j.state)).sort((a, b) => b.at - a.at);
    if (remaining.count > 0 && terminal.length > 64 && (await store.settings()).settings.assetGcEnabled) {
      await this.native.editRegistry(doc => { for (const job of terminal.slice(64)) if (['complete', 'cleaned'].includes(doc.creations[job.id]?.state)) delete doc.creations[job.id]; }); remaining.count--;
    }
  }
  /** 显式管理画布；删除意图先持久化，失败不恢复写入，移除列表只改变索引。 */
  async manage(slug, { action, operationId: id, revision } = {}) {
    operationId(id); const { document } = await this.native.registry(); const ref = document.canvases[slug];
    if (!ref) throw new ServiceError(404, '索引不存在');
    if (action === 'delete') {
      if (ref.state === 'deleted') return { status: 'deleted' };
      if (ref.state !== 'deleting') {
        const entry = await this.native.readReference(slug, ref);
        if (blockVersion(entry.block) !== revision) throw new ServiceError(409, '画布已更新，请刷新后确认删除');
        await this.native.editRegistry(doc => { doc.canvases[slug] = { ...ref, title: entry.document.title, state: 'deleting', deleteId: id, deletedAt: Date.now() }; });
      } else if (ref.deleteId !== id) id = ref.deleteId; // 用户重开页面仍续做原删除任务。
      const { data: folder } = await this.store.api.request('GET', `/blocks/${ref.folderId}`);
      if (parent(folder) !== this.store.rootId || folder?.type !== 'folder') throw new ServiceError(409, '文件夹归属变化，删除已暂停');
      if (live(folder)) {
        const { data: result } = await this.store.api.request('DELETE', `/blocks/${ref.folderId}`);
        if (result?.id !== ref.folderId || result.in_trash !== true) throw pending('删除结果待确认，请重新检查');
      }
      await this.native.editRegistry(doc => { doc.canvases[slug] = { ...doc.canvases[slug], state: 'deleted' }; });
      await this.store.thumbnails.remove(slug); return { status: 'deleted' };
    }
    if (action === 'detach') {
      await this.native.editRegistry(doc => { doc.canvases[slug] = { ...ref, state: 'detached', detachedAt: Date.now() }; });
      await this.store.thumbnails.remove(slug); return { status: 'detached' };
    }
    if (action === 'release') {
      if (ref.state !== 'deleted') throw new ServiceError(409, '只能释放已确认删除画布的标识');
      await this.native.editRegistry(doc => { delete doc.canvases[slug]; for (const [key, job] of Object.entries(doc.creations || {})) if (job.slug === slug) delete doc.creations[key]; });
      return { status: 'released' };
    }
    if (action === 'repair') {
      const { data: folder } = await this.store.api.request('GET', `/blocks/${ref.folderId}`);
      if (!live(folder) || parent(folder) !== this.store.rootId) throw new ServiceError(409, '请先在FlowUs恢复文件夹或移回数据根');
      const candidates = [];
      for (const page of (await this.store.children(ref.folderId)).filter(b => b.type === 'child_page')) {
        for (const block of (await this.store.children(page.id)).filter(b => b.type === 'code')) {
          let doc; try { doc = nativeDocument(block); } catch { continue; }
          if (doc.kind === 'scene' && doc.slug === slug && doc.assetFolderId === ref.folderId) candidates.push({ folderId: ref.folderId, pageId: page.id, blockId: block.id, title: doc.title });
        }
      }
      if (candidates.length !== 1) throw new ServiceError(409, candidates.length ? '找到多个候选数据页，请在FlowUs中保留唯一正确版本' : '未找到匹配的数据页，请先从FlowUs回收站恢复');
      await this.native.editRegistry(doc => { doc.canvases[slug] = candidates[0]; }); return { status: 'restored' };
    }
    throw new ServiceError(400, '管理操作无效');
  }
}
