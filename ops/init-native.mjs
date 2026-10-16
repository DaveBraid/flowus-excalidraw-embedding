import { fileURLToPath } from 'node:url';
import { FlowUs, ServiceError } from '../server/flowus.mjs';
import { CliOAuth } from '../server/oauth.mjs';
import { NativeDocuments, nativeContent, digest, NATIVE_LIMIT } from '../server/native.mjs';
import { normalizeSettings, SETTINGS_HELP } from '../server/settings.mjs';

/** 初始化专用空目录；输入API和根ID，输出原生设置页ID；已初始化时只校验，不覆盖内容。 */
export async function initNative({ api, rootId }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rootId || '')) throw new ServiceError(400, '请配置有效的 FLOWUS_ROOT_ID');
  const { data: root } = await api.request('GET', `/blocks/${rootId}`);
  if (!root || root.type !== 'folder' || root.in_trash || root.archived) throw new ServiceError(409, '数据根必须是可访问的真实文件夹');
  const children = (await api.all('GET', `/blocks/${rootId}/children`)).filter(b => !b.in_trash && !b.archived);
  const candidates = children.filter(b => b.type === 'child_page' && b.child_page.title === 'general settings');
  if (candidates.length > 1) throw new ServiceError(409, '存在多个设置页，停止初始化');
  let page = candidates[0];
  if (!page) {
    if (children.length) throw new ServiceError(409, '首次初始化只接受空目录，请另建专用文件夹');
    const settings = normalizeSettings({ autoSave: true });
    const result = await api.request('POST', '/pages', {
      parent: { page_id: rootId },
      properties: { title: { type: 'title', title: [{ type: 'text', text: { content: 'general settings' } }] } },
      children: [
        nativeContent({ schemaVersion: 2, kind: 'registry', state: 'ready', legacyRootId: rootId, maxSceneBytes: NATIVE_LIMIT, canvases: {}, creations: {} }),
        nativeContent({ schemaVersion: 2, kind: 'settings', settings, settingsHelp: SETTINGS_HELP }),
      ],
    }, undefined, `draw-init-${digest(rootId).slice(0, 48)}`); // 同一根使用固定幂等键，响应丢失后重跑恢复。
    page = result.data;
  }
  const { data: verified } = await api.request('GET', `/pages/${page.id}`);
  if (!verified || verified.in_trash || verified.archived || (verified.parent?.page_id || verified.parent?.block_id) !== rootId) throw new ServiceError(409, '设置页归属校验失败');
  const native = new NativeDocuments(api, { rootId: page.id, legacyRootId: rootId });
  await native.registry(); await native.settings(); // 回读实际内容，避免输出无法启动的设置页。
  return { nativeRootId: page.id };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tokenProvider = new CliOAuth({ configDir: process.env.FLOWUS_CONFIG_DIR, cliPath: process.env.FLOWUS_CLI_PATH, workspaceId: process.env.FLOWUS_WORKSPACE_ID });
  const result = await initNative({ api: new FlowUs({ tokenProvider }), rootId: process.env.FLOWUS_ROOT_ID });
  console.log(`FLOWUS_NATIVE_ROOT_ID=${result.nativeRootId}`);
}
