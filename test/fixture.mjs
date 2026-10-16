import { randomUUID } from 'node:crypto';
import { NATIVE_LIMIT, nativeContent, nativeDocument, plainText } from '../server/native.mjs';
import { Canvases } from '../server/storage.mjs';


const id = number => `30000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const nativeIds = { root: id(1), upload: id(2), settingsPage: id(3), registry: id(4), settings: id(5), folder: id(6), page: id(7), scene: id(8) };
export const emptyScene = () => ({ elements: [], appState: {}, files: {} });
export const textScene = text => ({ elements: [{ id: 't', type: 'text', text }], appState: {}, files: {} });
const metaCaption = metadata => [{ type: 'text', text: { content: `excalidraw-flowus:${JSON.stringify(metadata)}` } }];

/** 模拟真实folder内JSON数据页；输出服务、固定ID、附件对象及全部API调用，不产生远端内容。 */
export function folderNativeFixture({ state = 'ready' } = {}) {
  const n = nativeIds, blocks = new Map(), objects = new Map(), requests = [], transfers = []; let clock = 0;
  const put = (block, parent) => { const value = { ...structuredClone(block), last_edited_time: `v${++clock}`, ...(parent && { parent: { type: 'page_id', page_id: parent } }) }; blocks.set(value.id, value); return value; };
  const children = parent => [...blocks.values()].filter(block => block.parent?.page_id === parent);
  const addCode = (blockId, parent, doc) => put({ id: blockId, ...nativeContent(doc) }, parent);
  const addPage = (pageId, parent, title) => put({ id: pageId, type: 'child_page', child_page: { title }, properties: { title: { type: 'title', title: [{ text: { content: title } }] } } }, parent);
  put({ id: n.root, type: 'folder', folder: { title: '画布根' } });
  put({ id: n.folder, type: 'folder', folder: { title: '原生画布' } }, n.root);
  addPage(n.settingsPage, n.root, 'general settings'); addPage(n.page, n.folder, 'JSON 数据');
  addCode(n.registry, n.settingsPage, { schemaVersion: 2, kind: 'registry', state, legacyRootId: n.root, maxSceneBytes: NATIVE_LIMIT, canvases: { review: { pageId: n.page, blockId: n.scene, folderId: n.folder } } });
  addCode(n.settings, n.settingsPage, { schemaVersion: 2, kind: 'settings', settings: { autoSave: true } });
  addCode(n.scene, n.page, { schemaVersion: 2, kind: 'scene', slug: 'review', title: '原生画布', assetFolderId: n.folder, scene: emptyScene(), assets: {}, uploadedBytes: 0 });
  const api = {
    async all(method, path) { return structuredClone(children(path.match(/^\/blocks\/([^/]+)\/children$/)[1])); },
    async request(method, path, body) {
      requests.push({ method, path, body: structuredClone(body) });
      await api.beforeRequest?.(method, path, body);
      if (method === 'POST' && path === '/files/upload-url') { const name = `image/${randomUUID()}`; return { data: { oss_name: name, upload_url: `https://upload.cos.myqcloud.com/${encodeURIComponent(name)}`, headers: {} } }; }
      if (method === 'POST' && path === '/pages') {
        const page = addPage(randomUUID(), body.parent.page_id, plainText(body.properties.title.title));
        for (const child of body.children || []) put({ ...child, id: randomUUID() }, page.id);
        return { data: structuredClone(page) };
      }
      const markdown = path.match(/^\/pages\/([^/]+)\/content\/markdown$/);
      if (markdown) return { data: { markdown: children(markdown[1]).filter(b => b.type === 'file').map(b => `[file](https://cdn2.flowus.cn/${encodeURIComponent(b.file.file.oss_name)}?token=test-only)`).join('\n') } };
      const append = path.match(/^\/blocks\/([^/]+)\/children$/);
      if (append && method === 'PATCH') return { data: { results: body.children.map(child => structuredClone(put({ ...child, id: randomUUID() }, append[1]))) } };
      const one = path.match(/^\/(?:blocks|pages)\/([^/]+)$/);
      if (one && method === 'DELETE') return { data: structuredClone(put({ ...blocks.get(one[1]), in_trash: true })) };
      if (one && method === 'GET') return { data: structuredClone(blocks.get(one[1])) };
      if (one && method === 'PATCH') return { data: structuredClone(put({ ...blocks.get(one[1]), ...body })) };
      throw new Error(`未模拟接口：${method} ${path}`);
    },
  };
  async function fetchImpl(input, options = {}) {
    const name = decodeURIComponent(new URL(input).pathname.slice(1)); transfers.push({ name, method: options.method || 'GET' });
    if (options.method === 'PUT') { objects.set(name, Buffer.from(options.body)); return new Response('', { status: 200 }); }
    return objects.has(name) ? new Response(objects.get(name), { status: 200 }) : new Response('', { status: 404 });
  }
  const service = (gcOptions) => new Canvases(api, { rootId: n.root, uploadPageId: n.upload, nativeRootId: n.settingsPage, fetchImpl, gcOptions });
  return { ids: n, api, blocks, objects, requests, transfers, service, children, put, addCode, fetchImpl };
}

/** 创建仅驻留内存的图片场景；输入文件ID，输出带独立字节的测试场景。 */
export function imageScene(fileId = 'f') {
  const bytes = Buffer.from(`gc fixture ${fileId}`);
  return { elements: [{ id: `img-${fileId}`, type: 'image', fileId }], appState: {}, files: { [fileId]: { id: fileId, mimeType: 'image/png', dataURL: `data:image/png;base64,${bytes.toString('base64')}`, created: 1 } } };
}
