import { FlowUs } from '../server/flowus.mjs';
import { Canvases } from '../server/storage.mjs';
import { CliOAuth } from '../server/oauth.mjs';
import { digest } from '../server/native.mjs';

/** 只读核对画布内容与图片；输出hash和数量，不输出场景内容或凭据。 */
const tokenProvider = new CliOAuth({ configDir: process.env.FLOWUS_CONFIG_DIR, cliPath: process.env.FLOWUS_CLI_PATH || '/usr/local/bin/flowus', workspaceId: process.env.FLOWUS_WORKSPACE_ID });
const store = new Canvases(new FlowUs({ tokenProvider }), { rootId: process.env.FLOWUS_ROOT_ID, uploadPageId: process.env.FLOWUS_UPLOAD_PAGE_ID, nativeRootId: process.env.FLOWUS_NATIVE_ROOT_ID });
const list = await store.list(); const result = [];
for (const entry of list.canvases) {
  if (entry.status && entry.status !== 'ready') { result.push({ slug: entry.slug, status: entry.status }); continue; }
  const { canvas } = await store.load(entry.slug);
  result.push({ slug: canvas.slug, hash: digest(JSON.stringify({ title: canvas.title, scene: canvas.scene })), images: Object.keys(canvas.scene.files).length });
}
console.log(JSON.stringify({ canvases: result, settings: (await store.settings()).settings }));
