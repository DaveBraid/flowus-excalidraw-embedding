import { randomBytes } from 'node:crypto';
import { Auth, hashPassword } from '../server/auth.mjs';
import { createApp } from '../server/index.mjs';
import { Canvases } from '../server/storage.mjs';
import { initNative } from './init-native.mjs';
import { folderNativeFixture } from '../test/fixture.mjs';

let sequence = 0;
const ink = '#334155';

/** 构造标准Excalidraw元素；输入类型、几何和样式，输出仅含虚构内容的演示元素。 */
function element(type, x, y, width, height, extra = {}) {
  const id = ++sequence;
  return { id: `demo-${id}`, type, x, y, width, height, angle: 0, strokeColor: ink, backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1.5, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: type === 'rectangle' ? { type: 3 } : null, seed: id * 1729, version: 1, versionNonce: id * 271, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, ...extra };
}

/** 生成中文标注；输入文字、位置和字号，输出编辑器可直接渲染的文本元素。 */
function text(content, x, y, size = 22, color = ink) {
  const lines = content.split('\n');
  return element('text', x, y, Math.max(...lines.map(line => [...line].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? size : size * 0.56), 0))), lines.length * size * 1.4, { text: content, originalText: content, fontSize: size, fontFamily: 2, textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.4, strokeColor: color });
}

/** 生成单向连接；输入起终坐标，输出不依赖外部数据的箭头。 */
function arrow(x, y, dx, dy, color = '#64748b') {
  return element('arrow', x, y, Math.abs(dx), Math.abs(dy), { points: [[0, 0], [dx, dy]], lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: 'arrow', elbowed: false, strokeColor: color, strokeWidth: 2 });
}

/** 生成主题画布；输入示例标题和三组卡片，输出完全虚构的场景内容。 */
function scene(title, subtitle, cards, notes) {
  const elements = [text(title, 20, 0, 34, '#273449'), text(subtitle, 22, 61, 18, '#64748b')];
  const fills = ['#e7e3ff', '#d3f0e3', '#fff0c7'];
  const strokes = ['#8475cf', '#519579', '#c89938'];
  for (let i = 0; i < 3; i++) {
    const x = 20 + i * 370;
    elements.push(element('rectangle', x, 142, 300, 146, { backgroundColor: fills[i], strokeColor: strokes[i], strokeWidth: 2 }));
    elements.push(text(`0${i + 1}`, x + 22, 160, 16, strokes[i]), text(cards[i][0], x + 22, 192, 28), text(cards[i][1], x + 22, 240, 18));
    if (i < 2) elements.push(arrow(x + 312, 214, 48, 0));
    elements.push(element('rectangle', x, 343, 300, 150, { backgroundColor: '#f8fafc', strokeColor: '#cbd5e1', roughness: 0.8 }));
    elements.push(text(notes[i][0], x + 20, 362, 22), text(notes[i][1], x + 20, 405, 18, '#64748b'));
  }
  elements.push(element('line', 20, 538, 1040, 0, { points: [[0, 0], [1040, 0]], strokeColor: '#cbd5e1', roughness: 0.8 }));
  elements.push(text('自由绘图  /  固定链接  /  自动保存', 22, 560, 19, '#64748b'), text('演示数据 · 不连接真实工作区', 785, 562, 15, '#94a3b8'));
  return { elements, appState: { viewBackgroundColor: '#ffffff' }, files: {} };
}

/** 运行本机内存演示；不加载.env、不访问FlowUs，退出后所有演示更改丢失。 */
async function main() {
  delete process.env.THUMBNAIL_CACHE_DIR; // 演示缩略图仅驻留内存，不接触运行环境中的缓存目录。
  const f = folderNativeFixture();
  for (const id of f.blocks.keys()) if (id !== f.ids.root) f.blocks.delete(id);
  const { nativeRootId } = await initNative({ api: f.api, rootId: f.ids.root });
  const store = new Canvases(f.api, { rootId: f.ids.root, uploadPageId: f.ids.root, nativeRootId, fetchImpl: f.fetchImpl });
  const examples = [
    ['idea-to-action', '从想法到行动', scene('让想法在一张画布里展开', '把零散灵感连接起来，留下清晰的下一步。', [['记录灵感', '随手画下一个好问题'], ['连接线索', '把笔记、草图与流程串起来'], ['形成计划', '拆成可以完成的小步骤']], [['输入', '阅读摘记\n观察与草图'], ['整理', '归纳关系\n标出关键路径'], ['行动', '选择一件小事\n完成后回到画布']])],
    ['project-map', '项目结构一览', scene('把项目放在同一张图上', '一个工作区，连接内容、画布与行动。', [['想法', '先记录，再展开'], ['结构', '看见节点之间的关系'], ['交付', '把进展沉淀为文档']], [['文档', '背景与问题\n资料与参考'], ['画布', '流程与关系\n图文自由组合'], ['成果', '行动清单\n回顾与迭代']])],
    ['weekly-notes', '本周灵感墙', scene('给灵感一个可以回来的地方', '随手记下，再慢慢整理。', [['发现', '今天注意到了什么'], ['尝试', '画一个小小的可能性'], ['回顾', '保留值得继续的部分']], [['值得记录', '一个观察\n一个新问题'], ['可以尝试', '一段流程\n一张手绘草图'], ['下次再看', '留下固定链接\n继续补充线索']])],
  ];
  for (const [slug, title, content] of examples) {
    const { canvas } = await store.create({ slug, title, operationId: `demo-create-${slug}` });
    await store.save(slug, { revision: canvas.revision, scene: content, operationId: `demo-save-${slug}` });
  }
  const port = Number(process.env.DEMO_PORT || 4318);
  const origin = `http://127.0.0.1:${port}`;
  const auth = new Auth(randomBytes(32).toString('hex'), hashPassword('demo-only-password'), { secure: false });
  const server = createApp({ auth, canvases: store, origin });
  server.listen(port, '127.0.0.1', () => console.log(`本机内存演示：${origin}；演示密码：demo-only-password；不连接FlowUs。`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}

await main();
