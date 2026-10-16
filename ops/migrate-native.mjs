import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { FlowUs, ServiceError } from '../server/flowus.mjs';
import { CliOAuth } from '../server/oauth.mjs';
import { Canvases } from '../server/storage.mjs';
import { NativeDocuments, nativeContent, nativeDocument, plainText, blockVersion, digest, NATIVE_LIMIT } from '../server/native.mjs';

const marker = 'excalidraw-flowus:';
const captionMeta = block => {
  for (const item of block.file?.caption || []) {
    const text = item.plain_text ?? item.text?.content ?? '';
    if (text.startsWith(marker)) { try { return JSON.parse(text.slice(marker.length)); } catch {} }
  }
  return null;
};
const sceneHash = (document, folderId) => digest(JSON.stringify({ slug: document.slug, title: document.title, scene: document.scene, assets: document.assets, assetFolderId: folderId }));

/** 给旧附件标清迁移备份；只改caption，不删对象、不改OSS key，重复执行不重复写。 */
async function markBackup(api, blockId, kind, reference) {
  const { data: block } = await api.request('GET', `/blocks/${blockId}`);
  const current = captionMeta(block);
  if (current?.kind === kind && current.nativeBlockId === reference.nativeBlockId) return;
  if (!block.file?.file?.oss_name || !Number.isSafeInteger(block.file.file.size)) throw new ServiceError(409, '迁移备份附件缺少原始文件信息');
  const meta = { ...current, ...reference, kind, backupOnly: true };
  await api.request('PATCH', `/blocks/${block.id}`, { type: 'file', file: { type: 'file', file: block.file.file, caption: [
    { type: 'text', text: { content: '迁移前备份（不再更新）' } },
    { type: 'text', text: { content: marker + JSON.stringify(meta) } },
  ] } });
  const { data: saved } = await api.request('GET', `/blocks/${blockId}`);
  if (saved.file?.file?.oss_name !== block.file.file.oss_name || captionMeta(saved)?.kind !== kind) throw new ServiceError(409, '备份标记回读失败');
}

/** 幂等迁移；必须先封闭旧服务写入口，完整校验旧内容后才发布ready标记。 */
export async function migrateNative({ api, legacyRootId, log = value => console.log(JSON.stringify(value)) }) {
  const legacy = new Canvases(api, { rootId: legacyRootId, uploadPageId: legacyRootId });
  const rootBlocks = await legacy.children(legacyRootId);
  const roots = rootBlocks.filter(b => b.type === 'child_page' && b.child_page.title === 'general settings');
  if (roots.length > 1) throw new ServiceError(409, 'general settings数据页重复，停止迁移');
  let settingsPage = roots[0]; let native;
  if (settingsPage) {
    native = new NativeDocuments(api, { rootId: settingsPage.id, legacyRootId });
    const registry = await native.registry(false);
    if (registry.document.state === 'ready') {
      const migrated = await native.entries();
      const store = new Canvases(api, { rootId: legacyRootId, uploadPageId: legacyRootId, nativeRootId: settingsPage.id });
      for (const entry of migrated) await store.readEntry(entry); // 重跑先校验当前真实场景和全部图片。
      for (const entry of migrated) if (entry.document.legacyBackupFileId) await markBackup(api, entry.document.legacyBackupFileId, 'scene-backup', { nativePageId: entry.page.id, nativeBlockId: entry.block.id });
      const settingsBlock = registry.blocks.find(b => b.type === 'code' && nativeDocument(b).kind === 'settings');
      if (registry.document.legacySettingsBlockId) await markBackup(api, registry.document.legacySettingsBlockId, 'settings-backup', { nativePageId: settingsPage.id, nativeBlockId: settingsBlock.id });
      return { nativeRootId: settingsPage.id, resumedReady: true, canvasCount: migrated.length, maxSceneBytes: native.maxBytes, sceneHashes: migrated.map(e => ({ slug: e.meta.slug, hash: sceneHash(e.document, e.folder.id) })), autoSave: (await native.settings()).settings.autoSave };
    }
  }
  log({ phase: 'read-and-verify-legacy' });
  const sourceEntries = await legacy.entries();
  const oldSettingsBlock = rootBlocks.find(b => captionMeta(b)?.kind === 'settings');
  if (!oldSettingsBlock) throw new ServiceError(409, '旧全局设置文件未找到，停止迁移');
  const sourceSettings = await legacy.settings();
  const snapshots = [];
  for (const entry of sourceEntries) {
    const read = await legacy.readEntry(entry); // 验证每个图片附件的实际字节SHA-256。
    snapshots.push({ entry, document: read.document, sourceRevision: blockVersion(entry.block), hash: sceneHash(read.document, entry.folder.id) });
  }
  if (!snapshots.length) throw new ServiceError(409, '没有可迁移的旧场景，未创建数据页');
  if (!settingsPage) {
    const registryDoc = { schemaVersion: 2, kind: 'registry', state: 'staging', legacyRootId, legacySettingsBlockId: oldSettingsBlock.id, maxSceneBytes: NATIVE_LIMIT, capacityVerifiedBytes: NATIVE_LIMIT, canvases: {} };
    const { data: created } = await api.request('POST', '/pages', { parent: { page_id: legacyRootId }, properties: { title: { type: 'title', title: [{ type: 'text', text: { content: 'general settings' } }] } }, children: [
      nativeContent(registryDoc), nativeContent({ schemaVersion: 2, kind: 'settings', settings: sourceSettings.settings }),
    ] });
    settingsPage = created; native = new NativeDocuments(api, { rootId: created.id, legacyRootId });
  }
  log({ phase: 'write-and-readback-native', canvases: snapshots.length, maxSceneBytes: NATIVE_LIMIT });
  const migrated = [];
  for (const snapshot of snapshots) {
    const document = { ...snapshot.document, schemaVersion: 2, kind: 'scene', assetFolderId: snapshot.entry.folder.id, legacyBackupFileId: snapshot.entry.block.id, migrationState: 'ready' };
    const found = await native.resolve(snapshot.entry.meta.slug, false);
    let entry;
    if (found) { const block = await native.write(found.block, document); entry = { ...found, block, document }; }
    else entry = await native.create(document);
    if (sceneHash(nativeDocument(entry.block), entry.folder.id) !== snapshot.hash) throw new ServiceError(409, '原生JSON与旧场景内容hash不一致，未切换来源');
    migrated.push({ ...entry, verifiedHash: snapshot.hash });
    log({ phase: 'canvas-verified', slug: snapshot.entry.meta.slug, hash: snapshot.hash });
  }
  log({ phase: 'final-source-check' });
  for (const snapshot of snapshots) {
    const { data: current } = await api.request('GET', `/blocks/${snapshot.entry.block.id}`);
    if (blockVersion(current) !== snapshot.sourceRevision) throw new ServiceError(409, '迁移期间旧场景变化，ready未生效；请重读后重试');
  }
  const latestSettings = await legacy.settings();
  if (latestSettings.revision !== sourceSettings.revision || JSON.stringify(latestSettings.settings) !== JSON.stringify(sourceSettings.settings)) throw new ServiceError(409, '迁移期间全局设置变化，未切换来源');
  const registry = await native.registry(false);
  const nativeSettingsBlock = registry.blocks.find(b => b.type === 'code' && nativeDocument(b).kind === 'settings');
  if (!nativeSettingsBlock) throw new ServiceError(409, '原生全局设置块缺失');
  await native.write(nativeSettingsBlock, { schemaVersion: 2, kind: 'settings', settings: sourceSettings.settings });
  const nativeStore = new Canvases(api, { rootId: legacyRootId, uploadPageId: legacyRootId, nativeRootId: settingsPage.id });
  for (const entry of migrated) await nativeStore.readEntry(entry); // 切源前再次核对页归属和全部图片。
  const finalSources = await legacy.entries();
  const sourceIdentity = entries => entries.map(e => `${e.meta.slug}:${e.folder.id}:${e.block.id}`).sort();
  if (JSON.stringify(sourceIdentity(finalSources)) !== JSON.stringify(sourceIdentity(snapshots.map(s => s.entry)))) throw new ServiceError(409, '迁移期间画布集合变化，ready未生效');
  for (const snapshot of snapshots) {
    const { data: current } = await api.request('GET', `/blocks/${snapshot.entry.block.id}`);
    if (blockVersion(current) !== snapshot.sourceRevision) throw new ServiceError(409, '最终提交前旧场景变化，ready未生效');
  }
  const finalSettings = await legacy.settings();
  if (finalSettings.revision !== sourceSettings.revision) throw new ServiceError(409, '最终提交前旧设置变化，ready未生效');
  const freshRegistry = await native.registry(false);
  const registered = Object.entries(freshRegistry.document.canvases).map(([slug, ref]) => `${slug}:${ref.folderId}:${ref.pageId}:${ref.blockId}`).sort();
  const expected = migrated.map(e => `${e.meta.slug}:${e.folder.id}:${e.page.id}:${e.block.id}`).sort();
  if (JSON.stringify(registered) !== JSON.stringify(expected)) throw new ServiceError(409, '原生registry集合与本轮迁移不一致，ready未生效');
  const readyDocument = { ...freshRegistry.document, state: 'ready', migratedAt: new Date().toISOString(), verifiedSceneHashes: migrated.map(e => ({ slug: e.meta.slug, hash: e.verifiedHash })) };
  await native.write(freshRegistry.block, readyDocument); // 唯一提交点；此前失败均保持staging。
  for (const entry of migrated) await markBackup(api, entry.document.legacyBackupFileId, 'scene-backup', { nativePageId: entry.page.id, nativeBlockId: entry.block.id, sourceHash: entry.verifiedHash });
  await markBackup(api, oldSettingsBlock.id, 'settings-backup', { nativePageId: settingsPage.id, nativeBlockId: nativeSettingsBlock.id });
  const result = { nativeRootId: settingsPage.id, resumedReady: false, canvasCount: migrated.length, sceneBackupCount: migrated.length, settingsBackupCount: 1, imageCount: snapshots.reduce((n, s) => n + Object.keys(s.document.assets).length, 0), autoSave: sourceSettings.settings.autoSave, maxSceneBytes: native.maxBytes, sceneHashes: migrated.map(e => ({ slug: e.meta.slug, hash: e.verifiedHash })) };
  log({ phase: 'ready', ...result });
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.env.DRAW_MIGRATION_WRITE_GATE !== 'confirmed') throw new Error('必须先确认服务已临时只读，不能在线无门禁迁移');
  const tokenProvider = new CliOAuth({ configDir: process.env.FLOWUS_CONFIG_DIR, cliPath: process.env.FLOWUS_CLI_PATH || '/usr/local/bin/flowus', workspaceId: process.env.FLOWUS_WORKSPACE_ID });
  const api = new FlowUs({ tokenProvider }); const request = api.request.bind(api); let uploadUrlRequests = 0;
  api.request = async (method, path, ...args) => {
    if (path.split('?')[0] === '/files/upload-url') { uploadUrlRequests++; throw new ServiceError(409, '迁移禁止产生任何新OSS上传对象'); }
    return request(method, path, ...args);
  };
  const result = await migrateNative({ api, legacyRootId: process.env.FLOWUS_ROOT_ID });
  result.uploadUrlRequests = uploadUrlRequests;
  if (process.env.MIGRATION_REPORT_PATH) await writeFile(process.env.MIGRATION_REPORT_PATH, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ completed: true, ...result }));
}
