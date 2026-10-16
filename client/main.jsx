import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RotateCw, Wrench, Trash2, ListMinus, Unlink, Ellipsis } from 'lucide-react';
import { ConfirmDialog } from './confirm-dialog.jsx';
import { Excalidraw, MainMenu, serializeAsJSON, exportToBlob } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import './style.css';
import { contentScene, SaveMachine } from './save-machine.mjs';
import { PreviewCache, previewKey } from './preview-cache.mjs';
import { compactScene, confirmedAssets, ImageCache } from './assets.mjs';
import { canvasRoute, isMissingCanvas } from './canvas-route.mjs';

const previews = new PreviewCache(32, 2); // 仅在当前页面会话缓存缩略位图。

const images = new ImageCache();
const STATUS = { confirming: '保存结果待确认', saved: '已保存', dirty: '未保存', saving: '保存中…', error: '保存失败', conflict: '版本冲突' };

/** 读取系统配色并监听变化；只更新显示，不写入画布内容或全局设置。 */
function useSystemTheme() {
  const [theme, setTheme] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setTheme(media.matches ? 'dark' : 'light');
    media.addEventListener('change', update); update(); // 补齐初始化到订阅之间的系统变化。
    return () => media.removeEventListener('change', update);
  }, []);
  return theme;
}

/** 请求同源服务；输入路径和请求参数，输出 JSON，失败保留 HTTP 状态。 */
async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { ...(options.body && { 'Content-Type': 'application/json' }), ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || body.message || `请求失败（${response.status}）`), { status: response.status, code: body.code });
  return body;
}

/** 创建重试跨刷新保留同一ID；仅保存标题/链接标识的键，不缓存画布内容。 */
let pendingCreate;
function createOperation(input) {
  const key = JSON.stringify(input);
  if (pendingCreate?.key === key) return pendingCreate.id;
  try { const saved = JSON.parse(sessionStorage.getItem('draw-create') || '{}'); if (saved.key === key) { pendingCreate = saved; return saved.id; } const id = crypto.randomUUID(); pendingCreate = { key, id }; sessionStorage.setItem('draw-create', JSON.stringify(pendingCreate)); return id; }
  catch { pendingCreate = { key, id: crypto.randomUUID() }; return pendingCreate.id; }
}
/** 按需恢复本画布图片；两路下载，缺图保留占位和原引用，禁止静默丢失。 */
async function hydrate(canvas) {
  const queue = Object.entries(canvas.assets || {}); const files = {}; const missing = [];
  const placeholder = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#f4e9e9"/><text x="35" y="65" fill="#994444" font-size="20">Image unavailable</text></svg>');
  await Promise.all([0, 1].map(async () => { while (queue.length) { const [id, asset] = queue.shift();
    try { if (asset.missing) throw new Error('missing'); const file = images.get(asset.hash) || (await request(`/api/canvases/${encodeURIComponent(canvas.slug)}/assets/${encodeURIComponent(id)}?hash=${asset.hash}`)).file; files[id] = { ...file, id }; images.set(asset.hash, file); }
    catch { files[id] = { ...asset.properties, id, mimeType: asset.mimeType, dataURL: placeholder }; missing.push(id); }
  } }));
  return { ...canvas, scene: { ...canvas.scene, files }, missingAssets: missing };
}
/** 小图由浏览器已有场景生成，服务器只保存最新有限张；失败不影响场景保存。 */
async function makeThumbnail(scene) {
  if (!scene.elements.some(e => !e.isDeleted)) return null;
  const blob = await exportToBlob({ elements: scene.elements, files: scene.files, appState: { ...scene.appState, exportBackground: true, exportWithDarkMode: false, exportEmbedScene: false }, maxWidthOrHeight: 512, exportPadding: 24, mimeType: 'image/png' });
  const bitmap = await createImageBitmap(blob); const target = document.createElement('canvas'); target.width = bitmap.width; target.height = bitmap.height; target.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
  let dataURL = target.toDataURL('image/webp', 0.65);
  if (dataURL.length > 128 * 1024) { const small = document.createElement('canvas'); small.width = Math.max(1, target.width >> 1); small.height = Math.max(1, target.height >> 1); small.getContext('2d').drawImage(target, 0, 0, small.width, small.height); dataURL = small.toDataURL('image/webp', 0.5); }
  return dataURL.length <= 128 * 1024 ? dataURL : null;
}
async function cacheThumbnail(canvas, scene, session) {
  const dataURL = await makeThumbnail(scene); if (!dataURL) return null;
  await request(`/api/canvases/${encodeURIComponent(canvas.slug)}/thumbnail?revision=${canvas.revision}`, { method: 'PUT', headers: { 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ dataURL }) }); return dataURL;
}

let routeGuard = () => true;
let routeIndex = Number(window.history.state?.canvasIndex || 0);
let restoringRoute = false;
window.history.replaceState({ ...window.history.state, canvasIndex: routeIndex }, '');

/** 在内存路由中切换页面；先确认未保存修改，再发布已授权导航事件。 */
function navigate(path) {
  if (!routeGuard()) return;
  routeIndex += 1;
  window.history.pushState({ canvasIndex: routeIndex }, '', path);
  const event = new PopStateEvent('popstate'); event.approvedNavigation = true;
  window.dispatchEvent(event);
}

/** 下载官方场景格式；输入 Excalidraw API 与名称，输出可重新导入的文件。 */
function downloadScene(api, title) {
  if (!api) return;
  const text = serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), 'local');
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `${title || '画布'}.excalidraw`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); // 下载触发后释放临时对象 URL。
}

/** 显示登录表单；输入会话回调，输出登录结果和嵌入 Cookie 提示。 */
function Login({ onLogin }) {
  const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await request('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
      const session = await request('/api/session');
      if (!session.authenticated) throw new Error('浏览器未保存登录 Cookie，请单独打开页面后登录。');
      onLogin(session);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <main className="center"><form className="login panel" onSubmit={submit}>
    <div className="eyebrow">FLOWUS × EXCALIDRAW</div><h1>画布</h1><p>随手画，留在 FlowUs。</p>
    <label htmlFor="password">访问密码</label><input id="password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required autoFocus />
    <button className="primary" disabled={busy}>{busy ? '正在登录…' : '进入画布'}</button>
    {error && <p className="error" role="alert">{error}</p>}
    <a href={window.location.href} target="_blank" rel="noopener noreferrer">单独打开页面 ↗</a>
  </form></main>;
}

/** 显示全局偏好；输入保存状态及切换回调，输出自动保存设置。 */
function Settings({ settings, onToggle, busy, error, onClose }) {
  return <div className="modal-backdrop" onClick={onClose}><section className="panel settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={event => event.stopPropagation()}>
    <div className="section-heading"><h2 id="settings-title">通用设置</h2><button onClick={onClose} aria-label="关闭设置">✕</button></div>
    <label className="switch-row"><span><strong>自动保存</strong><small>停止绘图 2 秒后保存到 FlowUs。</small></span><input type="checkbox" checked={settings.autoSave} disabled={busy} onChange={event => onToggle(event.target.checked)} /></label>
    <p className="muted">关闭后可点“保存”或按 ⌘ / Ctrl + S。未保存内容仅留在当前页面，请在离开前保存或导出。</p>
    {busy && <p role="status">正在保存设置…</p>}{error && <p className="error" role="alert">{error}</p>}
  </section></div>;
}

/** 从已保存 scene 生成真实缩略图；官方导出器负责图片与中英文字体。 */
function thumbnailBlob(dataURL) { const [header, encoded] = dataURL.split(','); return new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], { type: header.slice(5).split(';')[0] }); }
async function renderPreview(canvas, session) {
  if (canvas.empty) return { empty: true, blob: null }; // 列表已确认空场景，无需再读取完整画布。
  const cached = await request(`/api/canvases/${encodeURIComponent(canvas.slug)}/thumbnail?revision=${canvas.revision}`);
  if (cached.thumbnail) return cached.thumbnail.empty ? { empty: true, blob: null } : { empty: false, blob: thumbnailBlob(cached.thumbnail.dataURL) };
  const current = (await request(`/api/canvases/${encodeURIComponent(canvas.slug)}?manifest=1`)).canvas;
  if (current.revision !== canvas.revision) throw Object.assign(new Error('画布版本变化'), { status: 409 });
  if (!current.scene.elements.some(e => !e.isDeleted)) return { empty: true, blob: null };
  const loaded = await hydrate(current);
  if (loaded.missingAssets.length) throw new Error('画布包含缺失图片，请进入画布检查');
  const dataURL = await cacheThumbnail(canvas, loaded.scene, session);
  if (!dataURL) throw new Error('缩略图超出限制');
  return { empty: false, blob: thumbnailBlob(dataURL) };
}

/** 可见卡片才进入两路并发预览队列；卸载时释放专用对象 URL。 */
function CanvasPreview({ canvas, onReload, session }) {
  const root = useRef(null); const [visible, setVisible] = useState(false); const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState({ status: 'loading', url: null });
  useEffect(() => {
    if (!window.IntersectionObserver) { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => setVisible(entries[0].isIntersecting), { rootMargin: '120px 0px' });
    observer.observe(root.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false; let objectUrl = null;
    setPreview({ status: 'loading', url: null });
    previews.get(previewKey(canvas.slug, canvas.revision), () => renderPreview(canvas, session), () => !cancelled).then(result => {
      if (cancelled) return;
      objectUrl = result.blob ? URL.createObjectURL(result.blob) : null;
      setPreview({ status: result.empty ? 'empty' : 'ready', url: objectUrl });
    }).catch(failure => {
      if (!cancelled && failure.name !== 'AbortError') setPreview({ status: failure.status === 409 ? 'stale' : 'error', url: null });
    });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [visible, canvas.slug, canvas.revision, attempt]);
  return <div className="canvas-preview" ref={root}>
    {preview.status === 'ready' ? <img src={preview.url} alt={`${canvas.title}的已保存预览`} /> : <div className={`preview-placeholder ${preview.status}`}>
      {preview.status === 'empty' ? <><span className="preview-empty-icon" aria-hidden="true">▱</span><span>空白画布</span></> : preview.status === 'error' || preview.status === 'stale' ? <><span>{preview.status === 'stale' ? '画布已更新，请刷新预览' : '预览加载失败'}</span><button className="preview-retry" onClick={preview.status === 'stale' ? onReload : () => setAttempt(value => value + 1)}>{preview.status === 'stale' ? '刷新列表' : '重试'}</button></> : <span>正在加载预览…</span>}
    </div>}
  </div>;
}

/** 菜单图标沿用文字颜色；装饰图形不重复参与无障碍朗读。 */
function CardMenuIcon({ name }) {
  const Icon = { reload: RotateCw, repair: Wrench, delete: Trash2, detach: ListMinus, release: Unlink }[name];
  return <Icon size={18} strokeWidth={1.75} aria-hidden="true" />;
}

/** 卡片用独立链接与按钮；复制失败时提供可选中的完整嵌入地址。 */
function CanvasCard({ canvas, onReload, session }) {
  const [copyState, setCopyState] = useState('idle');
  const [busy, setBusy] = useState(false); const [manageError, setManageError] = useState('');
  const [pendingAction, setPendingAction] = useState(null);
  const managementPending = useRef(false); const menu = useRef(null);
  const confirmations = {
    delete: { title: '删除画布', description: `将“${canvas.title}”的整个文件夹移入 FlowUs 回收站？画布数据和所有附件都会一起移入回收站。`, confirmLabel: '确认删除', destructive: true },
    detach: { title: '从列表移除', description: `将“${canvas.title}”从列表移除？FlowUs 文件夹和链接标识会保留，之后可恢复。`, confirmLabel: '确认移除' },
    release: { title: '永久释放链接标识', description: '释放链接标识并移除恢复记录？以后可同名新建；旧画布恢复后不会自动接回此链接。', confirmLabel: '确认释放', destructive: true },
  };
  function closeConfirmation() {
    if (managementPending.current) return;
    setPendingAction(null); setManageError(''); menu.current?.querySelector('summary')?.focus();
  }
  /** 确认后才提交；同步锁防止连续点按，失败时保留确认框和错误信息。 */
  async function runManage(action) {
    if (managementPending.current) return;
    managementPending.current = true; setBusy(true); setManageError('');
    try {
      await request(`/api/canvases/${encodeURIComponent(canvas.slug)}/manage`, { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ action, revision: canvas.revision, operationId: crypto.randomUUID() }) });
      setPendingAction(null); menu.current?.querySelector('summary')?.focus(); onReload();
    } catch (error) { setManageError(error.message); }
    finally { managementPending.current = false; setBusy(false); }
  }
  function manage(action) {
    if (managementPending.current) return;
    if (menu.current) menu.current.open = false;
    setManageError('');
    if (confirmations[action]) setPendingAction(action);
    else runManage(action);
  }
  const href = `/c/${encodeURIComponent(canvas.slug)}`;
  const fullUrl = `${window.location.origin}${href}`;
  useEffect(() => {
    if (copyState !== 'copied') return;
    const timer = setTimeout(() => setCopyState('idle'), 2500); return () => clearTimeout(timer);
  }, [copyState]);
  async function copy() {
    try { await navigator.clipboard.writeText(fullUrl); setCopyState('copied'); }
    catch { setCopyState('manual'); }
  }
  return <article className="canvas-card">
    {pendingAction && <ConfirmDialog {...confirmations[pendingAction]} busy={busy} error={manageError} onConfirm={() => runManage(pendingAction)} onCancel={closeConfirmation} />}
    <div className="card-visual">{canvas.status && canvas.status !== 'ready' ? <div className="canvas-preview preview-unavailable"><strong>{canvas.status === 'deleted' ? '已删除' : canvas.status === 'detached' ? '已移除' : '画布暂不可用'}</strong><small>{canvas.error}</small></div> : <CanvasPreview canvas={canvas} onReload={onReload} session={session} />}<details className="card-menu" ref={menu}><summary aria-label={`管理画布“${canvas.title}”`} title="管理画布"><Ellipsis size={18} strokeWidth={2} aria-hidden="true" /></summary><div><button disabled={busy} onClick={onReload}><CardMenuIcon name="reload" />重新检查</button><button disabled={busy} onClick={() => manage('repair')}><CardMenuIcon name="repair" />修复索引 / 恢复</button>{(!canvas.status || ['ready', 'deleting'].includes(canvas.status)) && <button className="menu-danger" disabled={busy} onClick={() => manage('delete')}><CardMenuIcon name="delete" />{canvas.status === 'deleting' ? '确认删除结果' : '删除画布'}</button>}<button disabled={busy} onClick={() => manage('detach')}><CardMenuIcon name="detach" />从列表移除</button>{canvas.status === 'deleted' && <button disabled={busy} onClick={() => manage('release')}><CardMenuIcon name="release" />永久释放链接标识</button>}</div></details>{manageError && !pendingAction && <div className="card-management-error" role="alert">{manageError}</div>}</div>
    <div className="canvas-card-info"><a className="canvas-card-open" href={href} onClick={event => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey) { event.preventDefault(); navigate(href); } }}><h3 title={canvas.title}>{canvas.title}</h3></a><span className="muted card-path" title={href}>{href}</span>
      <footer><time dateTime={canvas.updatedAt}>{canvas.updatedAt && Number.isFinite(Date.parse(canvas.updatedAt)) ? new Date(canvas.updatedAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '打开画布'}</time><button className="card-copy" onClick={copy} title={copyState === 'copied' ? '完整嵌入链接已复制' : '复制完整嵌入链接'} aria-label={`复制画布“${canvas.title}”的完整嵌入链接`}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{copyState === 'copied' ? <path d="m5 12 4 4L19 6" /> : <><path d="M9 17H7a5 5 0 0 1 0-10h2M15 7h2a5 5 0 0 1 0 10h-2" /><path d="M8 12h8" /></>}</svg>{copyState === 'copied' && <span className="sr-only" role="status">完整嵌入链接已复制</span>}</button></footer>
    </div>
    {copyState === 'manual' && <div className="card-copy-fallback" role="group" aria-label="手动复制嵌入链接"><div><span role="status">浏览器限制自动复制，请手动复制完整链接。</span><button onClick={() => setCopyState('idle')} aria-label={`关闭“${canvas.title}”的手动复制`}>✕</button></div><input aria-label={`画布“${canvas.title}”的完整嵌入链接`} value={fullUrl} readOnly autoFocus onFocus={event => event.target.select()} /></div>}
  </article>;
}

/** 列出并创建独立画布；输入会话及全局操作，输出根路径管理页。 */
function CanvasList({ session, onSettings, onLogout }) {
  const [showRetired, setShowRetired] = useState(false); const [gcPaused, setGcPaused] = useState(false);
  const [canvases, setCanvases] = useState(null); const [error, setError] = useState('');
  const [title, setTitle] = useState(''); const [slug, setSlug] = useState(''); const [creating, setCreating] = useState(false);
  const load = useCallback((fresh = false) => { setError(''); request(`/api/canvases${fresh ? '?fresh=1' : ''}`).then(body => { setCanvases(body.canvases); setGcPaused(body.gcPaused); }).catch(failure => setError(failure.message)); }, []);
  useEffect(() => { load(); }, [load]);
  const visibleCanvases = canvases?.filter(canvas => showRetired || !['deleted', 'detached'].includes(canvas.status));
  async function create(event) {
    event.preventDefault(); setCreating(true); setError('');
    try {
      const body = await request('/api/canvases', { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ title: title.trim(), ...(slug.trim() && { slug: slug.trim() }), operationId: createOperation({ title: title.trim(), slug: slug.trim() }) }) });
      navigate(`/c/${encodeURIComponent(body.canvas.slug)}`);
    } catch (failure) { if (failure.status === 410) { pendingCreate = null; try { sessionStorage.removeItem('draw-create'); } catch {} } setError(failure.message); }
    finally { setCreating(false); }
  }
  return <div className="library-page"><header className="library-header"><div className="brand"><span className="brand-icon">✎</span><span>画布 <small>FlowUs</small></span></div><nav><button onClick={onSettings}>通用设置</button><button onClick={onLogout}>退出</button></nav></header>
    <main className="library-main"><div className="intro"><div className="eyebrow">你的绘图空间</div><h1>从一个想法开始。</h1><p>自由绘图、流程图和图片，统一保存在 FlowUs。</p></div>
      <form className="create-form panel" onSubmit={create}><h2>新建画布</h2><div className="create-fields"><label>标题<input value={title} maxLength={100} onChange={event => setTitle(event.target.value)} placeholder="例如：研究思路" required /></label><label><span>链接标识 <small className="muted">（可选）</small></span><input value={slug} onChange={event => setSlug(event.target.value)} placeholder="research-ideas" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxLength={64} title="使用小写字母、数字和连字符" /></label><button className="primary" disabled={creating}>{creating ? '正在创建…' : '创建并打开 →'}</button></div><p className="muted">链接标识用于 /c/标识；留空会自动生成。</p></form>
      {error && <p className="error" role="alert">{error} <button onClick={load}>重试</button></p>}
      <label className="retired-toggle"><input type="checkbox" checked={showRetired} onChange={event => setShowRetired(event.target.checked)} />显示已删除 / 已移除的画布</label>{gcPaused && <p className="storage-warning">部分画布无法读取，附件回收已暂停删除。其他画布仍可使用。</p>}<div className="section-heading"><h2>所有画布</h2><span className="muted">{visibleCanvases?.length ?? '…'} 个</span></div>
      {canvases === null ? <p role="status">正在读取 FlowUs…</p> : visibleCanvases.length === 0 ? <div className="empty-state">{canvases.length ? '没有显示中的画布，可勾选上方选项查看已删除或已移除的画布。' : '还没有画布。创建第一张，开始画吧。'}</div> : <div className="canvas-grid">{visibleCanvases.map(canvas => <CanvasCard key={canvas.slug} canvas={canvas} onReload={() => load(true)} session={session} />)}</div>}
      <p className="embed-note">在 FlowUs 中嵌入本页可浏览画布。创建后可复制该画布的固定链接，替换嵌入地址。</p>
    </main></div>;
}

/** 管理单画布加载、排队保存及嵌入链接；加载成功后才挂载官方编辑器。 */
function CanvasEditor({ slug, session, autoSave, onSettings }) {
  const theme = useSystemTheme();
  const [canvas, setCanvas] = useState(null); const [error, setError] = useState(''); const [state, setState] = useState({ status: 'saved', dirty: false });
  const [missing, setMissing] = useState(false); const [createTitle, setCreateTitle] = useState(slug); const [creating, setCreating] = useState(false); const [createError, setCreateError] = useState(''); const [createConflict, setCreateConflict] = useState(false);
  const createPending = useRef(false); // 同一次确认只允许发出一个创建请求。
  const [renameOpen, setRenameOpen] = useState(false); const [renameTitle, setRenameTitle] = useState(''); const [renameBusy, setRenameBusy] = useState(false); const [renameError, setRenameError] = useState('');
  const renameActive = useRef(false); renameActive.current = renameOpen;
  const [copyOpen, setCopyOpen] = useState(false); const [copied, setCopied] = useState(false); const [loadId, setLoadId] = useState(0);
  const known = useRef(new Map()); const thumbnailTimer = useRef();
  const api = useRef(null); const machine = useRef(null); const timer = useRef(null); const active = useRef(false); const autoRef = useRef(autoSave);
  const fixedUrl = `${window.location.origin}/c/${encodeURIComponent(slug)}`;
  autoRef.current = autoSave && !renameOpen;
  /** 初始化已读取或确认创建的画布；异步保存响应不得覆盖当前场景。 */
  const openCanvas = useCallback(data => {
    machine.current?.dispose();
    known.current = confirmedAssets(data.scene, data.assets);
    const accepted = (result, payload) => {
      if (result.superseded) return result; // 旧操作的快照不能成为后续版本的预览。
      if (payload?.scene) {
        known.current = confirmedAssets(payload.scene, result.assets); // 移除已失效的哈希，撤销恢复时重新携带原图。
        clearTimeout(thumbnailTimer.current);
        thumbnailTimer.current = setTimeout(() => cacheThumbnail({ ...result, slug }, payload.scene, session).catch(() => {}), 1500);
      }
      if (active.current) setCanvas(current => current ? { ...current, title: result.title, revision: result.revision, storage: result.storage, missingAssets: (current.missingAssets || []).filter(id => result.assets?.[id]) } : current);
      return result;
    };
    machine.current = new SaveMachine({ revision: data.revision, persist: async payload => {
      const wire = payload.scene ? { ...payload, scene: compactScene(payload.scene, known.current) } : payload;
      const result = (await request(`/api/canvases/${encodeURIComponent(slug)}`, { method: 'PUT', headers: { 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify(wire) })).canvas;
      return accepted(result, payload);
    }, confirm: async id => {
      const status = await request(`/api/canvases/${encodeURIComponent(slug)}/operations/${id}`);
      if (status.status === 'committed') accepted(status.canvas, machine.current.operation?.payload);
      return status;
    }, onState: setState });
    setCanvas(data); setMissing(false); setError('');
  }, [slug, session.csrfToken]);
  useEffect(() => {
    let cancelled = false; active.current = true; setCanvas(null); setError(''); setMissing(false); setCreateConflict(false); setCreateError('');
    request(`/api/canvases/${encodeURIComponent(slug)}?manifest=1${loadId ? '&fresh=1' : ''}`).then(async body => {
      body.canvas = await hydrate(body.canvas);
      if (!cancelled) openCanvas(body.canvas);
    }).catch(failure => {
      if (cancelled) return;
      if (isMissingCanvas(failure, slug)) setMissing(true); // GET缺失只展示确认，不创建远端内容。
      else setError(failure.message);
    });
    return () => { cancelled = true; active.current = false; clearTimeout(timer.current); machine.current?.dispose(); machine.current = null; };
  }, [slug, session.csrfToken, loadId, openCanvas]);
  /** 显式确认后创建URL指定的画布；同名冲突不覆盖已有内容。 */
  async function confirmCreate(event) {
    event.preventDefault();
    if (createPending.current || !missing || createConflict || !createTitle.trim()) return;
    createPending.current = true; setCreating(true); setCreateError('');
    try {
      const body = await request('/api/canvases', { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ title: createTitle.trim(), slug, operationId: createOperation({ title: createTitle.trim(), slug }) }) });
      if (body.canvas?.slug !== slug) throw new Error('服务返回的画布链接不匹配，请返回首页检查。');
      if (active.current) openCanvas(body.canvas); // 保持iframe当前URL，不另建导航历史。
    } catch (failure) {
      if (failure.status === 410) { pendingCreate = null; try { sessionStorage.removeItem('draw-create'); } catch {} }
      if (active.current) {
        if (failure.status === 409) { setCreateConflict(true); setCreateError('同名画布已存在。打开后将保留已有标题与内容。'); }
        else setCreateError(failure.message);
      }
    } finally {
      createPending.current = false;
      if (active.current) setCreating(false);
    }
  }
  const save = useCallback(() => { clearTimeout(timer.current); if (renameActive.current) return Promise.resolve(false); return machine.current?.save(); }, []);
  useEffect(() => {
    clearTimeout(timer.current);
    if (autoSave && !renameOpen && state.dirty && !['conflict', 'error', 'confirming'].includes(state.status)) timer.current = setTimeout(save, 2000); // 停笔去抖，减少 FlowUs 写入。
    return () => clearTimeout(timer.current);
  }, [autoSave, renameOpen, state.dirty, state.status, save]);
  useEffect(() => {
    const shortcut = event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopImmediatePropagation(); save(); } };
    const beforeLeave = event => { if (machine.current?.dirty || machine.current?.inFlight || machine.current?.metadataPending) { event.preventDefault(); event.returnValue = ''; } };
    const guard = () => !machine.current?.dirty || window.confirm('当前修改尚未保存。确定离开并丢弃这些修改？');
    routeGuard = guard;
    window.addEventListener('keydown', shortcut, true); window.addEventListener('beforeunload', beforeLeave);
    return () => { if (routeGuard === guard) routeGuard = () => true; window.removeEventListener('keydown', shortcut, true); window.removeEventListener('beforeunload', beforeLeave); };
  }, [save]);
  /** 只缓存有意义的场景内容；视角及选择变化不会触发远端保存。 */
  const change = useCallback((elements, appState, files) => {
    if (!active.current || !machine.current) return;
    const next = contentScene(elements, appState, files);
    const previous = machine.current.latest?.key;
    machine.current.capture(next);
    if (previous !== machine.current.latest?.key) {
      clearTimeout(timer.current);
      if (autoRef.current && machine.current.dirty && !machine.current.blocked) timer.current = setTimeout(save, 2000);
    }
  }, [save]);
  async function copyLink() {
    setCopyOpen(true); setCopied(false);
    try { await navigator.clipboard.writeText(fixedUrl); setCopied(true); } catch { /* 嵌入权限不足时仍显示可手动复制的链接。 */ }
  }
  /** 显式保存标题；响应只更新标题和 revision，不替换当前场景。 */
  async function submitRename(event) {
    event.preventDefault();
    const editor = machine.current;
    if (!editor || !renameTitle.trim()) return;
    setRenameBusy(true); setRenameError(''); clearTimeout(timer.current);
    const result = await editor.rename(renameTitle.trim());
    if (active.current) {
      if (result) { setCanvas(current => ({ ...current, title: result.title, storage: result.storage })); setRenameOpen(false); }
      else setRenameError(editor.error || '标题未保存，请先处理版本冲突。');
      setRenameBusy(false);
    }
  }
  function leave() { navigate('/'); }
  function reload() {
    if (!window.confirm('重新读取将丢弃当前未保存修改。可先导出 .excalidraw 备份。确定继续？')) return;
    setLoadId(value => value + 1);
  }
  if (error) return <main className="center"><div className="panel"><h2>画布读取失败</h2><p className="error" role="alert">{error}</p><button onClick={() => setLoadId(value => value + 1)}>重试</button><button onClick={() => navigate('/')}>返回列表</button></div></main>;
  if (missing) return <main className="center"><form className="panel missing-canvas" onSubmit={confirmCreate}>
    <div className="eyebrow">{createConflict ? '同名画布已由其他页面创建' : '此链接尚未创建画布'}</div><h1>{createConflict ? '画布已存在' : '是否新建画布'}</h1><p className="muted">{createConflict ? '打开已有画布不会修改它的标题与内容。' : '确认后保存到当前连接的 FlowUs 空间，并在此地址直接编辑。'}</p>
    <label>画布标题<input value={createTitle} maxLength={100} required disabled={creating || createConflict} onChange={event => setCreateTitle(event.target.value)} /></label>
    <div className="missing-slug"><span className="muted">链接标识</span><strong>{slug}</strong></div>
    <label>完整嵌入链接<input readOnly value={fixedUrl} onFocus={event => event.target.select()} /></label>
    {createError && <p className="error" role="alert">{createError}</p>}
    <div className="dialog-actions"><button type="button" disabled={creating} onClick={() => navigate('/')}>返回首页</button>{createConflict ? <button type="button" className="primary" onClick={() => setLoadId(value => value + 1)}>打开已有画布</button> : <button className="primary" disabled={creating || !createTitle.trim()}>{creating ? '正在创建…' : '确认新建画布'}</button>}</div>
  </form></main>;
  if (!canvas) return <main className="center" role="status">正在读取画布…</main>;
  return <div className="editor-page"><header className="editor-header"><button onClick={leave} title="返回画布列表" aria-label="返回画布列表">←</button><h1 title={canvas.title}>{canvas.title}</h1><button className="rename-trigger" aria-label="修改画布标题" title="修改画布标题" onClick={() => { clearTimeout(timer.current); setRenameTitle(canvas.title); setRenameError(''); setRenameOpen(true); }} disabled={state.status === 'conflict'}>✎</button><span className={`save-status ${state.status}`} role="status">{STATUS[state.status]}{!autoSave && <small> · 手动</small>}</span><div className="editor-actions"><button onClick={copyLink}>嵌入链接</button><button onClick={onSettings} aria-label="通用设置">设置</button><button className="primary" onClick={save} disabled={!state.dirty || state.status === 'conflict'}>保存</button></div></header>
    {(state.status === 'error' || state.status === 'conflict' || state.status === 'confirming') && <div className="save-error" role="alert"><span>{state.status === 'conflict' ? 'FlowUs 中已有更新。当前修改仍保留在页面，请先导出备份，再重新读取。' : state.status === 'confirming' ? '网络中断，保存结果待确认。重试会确认同一次操作，当前编辑仍保留。' : `保存未完成：${state.error}。当前修改仍保留在页面。`}</span><button onClick={() => downloadScene(api.current, canvas.title)}>导出备份</button>{state.status === 'conflict' ? <button onClick={reload}>重新读取</button> : <button onClick={save}>重试保存</button>}</div>}
    {canvas.missingAssets?.length > 0 && <p className="storage-warning">有图片无法读取，已保留占位与原引用。请恢复FlowUs附件后重新读取，或明确删除画布中对应图片；不会自动丢弃引用。</p>}
    {canvas.storage?.warning && <p className="storage-warning" role="status">累计上传估算已超过提示阈值。自动回收开启时，未使用的应用图片按 general settings 中的宽限期移入 FlowUs 回收站。历史上传对象不会自动清理；回收站操作不保证释放实际存储空间。</p>}
    {copyOpen && <section className="embed-bar"><div><strong>{copied ? '固定链接已复制' : '复制固定嵌入链接'}</strong><span> 嵌入页内切换后，FlowUs 原嵌入地址可能仍指向列表。请用此链接替换。</span></div><input aria-label="画布固定链接" readOnly value={fixedUrl} onFocus={event => event.target.select()} /><button onClick={() => setCopyOpen(false)} aria-label="关闭嵌入链接">✕</button></section>}
    {renameOpen && <div className="modal-backdrop" onClick={() => { if (!renameBusy) setRenameOpen(false); }}><form className="panel rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title" onSubmit={submitRename} onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape' && !renameBusy) setRenameOpen(false); }}>
      <h2 id="rename-title">修改画布标题</h2><label>标题<input value={renameTitle} maxLength={100} required autoFocus disabled={renameBusy} onChange={event => setRenameTitle(event.target.value)} /></label>
      <p className="muted">仅保存标题，链接标识保持不变。未保存的绘图继续保留在当前页面。</p>
      {renameError && <p className="error" role="alert">{renameError}</p>}<div className="dialog-actions"><button type="button" disabled={renameBusy} onClick={() => setRenameOpen(false)}>取消</button><button className="primary" disabled={renameBusy || !renameTitle.trim() || renameTitle.trim() === canvas.title}>{renameBusy ? '正在保存标题…' : '保存标题'}</button></div>
    </form></div>}
    <div className="drawing"><Excalidraw key={`${slug}:${loadId}`} theme={theme} langCode="zh-CN" name={canvas.title} initialData={{ ...canvas.scene, scrollToContent: true }} onChange={change} excalidrawAPI={value => { api.current = value; }} UIOptions={{ canvasActions: { saveToActiveFile: false, toggleTheme: false } }}>
      <MainMenu><MainMenu.DefaultItems.LoadScene /><MainMenu.DefaultItems.Export /><MainMenu.DefaultItems.SaveAsImage /><MainMenu.Item onSelect={() => save()} shortcut="⌘ / Ctrl + S">保存到 FlowUs</MainMenu.Item><MainMenu.Separator /><MainMenu.DefaultItems.ClearCanvas /><MainMenu.DefaultItems.ChangeCanvasBackground /></MainMenu>
    </Excalidraw></div>
  </div>;
}

/** 读取会话与全局偏好并选择路由；所有持久化均通过 FlowUs 服务。 */
function App() {
  const [session, setSession] = useState(null); const [path, setPath] = useState(window.location.pathname); const [error, setError] = useState('');
  const [settings, setSettings] = useState(null); const [settingsOpen, setSettingsOpen] = useState(false); const [settingsBusy, setSettingsBusy] = useState(false); const [settingsError, setSettingsError] = useState('');
  useEffect(() => { request('/api/session').then(setSession).catch(failure => setError(failure.message)); }, []);
  useEffect(() => {
    const route = event => {
      if (restoringRoute) { restoringRoute = false; return; }
      const nextIndex = Number(event.state?.canvasIndex ?? routeIndex);
      if (!event.approvedNavigation && !routeGuard()) {
        restoringRoute = true;
        window.history.go(routeIndex - nextIndex); // 取消后退时恢复原历史项，编辑器保持挂载。
        return;
      }
      routeIndex = event.approvedNavigation ? routeIndex : nextIndex;
      setPath(window.location.pathname);
    };
    window.addEventListener('popstate', route); return () => window.removeEventListener('popstate', route);
  }, []);
  useEffect(() => {
    if (!session?.authenticated) return;
    let cancelled = false; setSettings(null);
    request('/api/settings').then(body => { if (!cancelled) setSettings(body); }).catch(failure => { if (!cancelled) setError(failure.message); });
    return () => { cancelled = true; };
  }, [session]);
  async function toggle(autoSave) {
    const previous = settings;
    setSettingsBusy(true); setSettingsError('');
    setSettings({ ...settings, settings: { ...settings.settings, autoSave } }); // 立即停止或启动自动保存。
    try { setSettings(await request('/api/settings', { method: 'PUT', headers: { 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ revision: settings.revision, settings: { ...settings.settings, autoSave } }) })); }
    catch (failure) {
      setSettings(previous); // 偏好保存失败时恢复已确认的设置。
      setSettingsError(failure.status === 409 ? '设置已在其他页面更新，已读取最新设置。请再次选择。' : failure.message);
      if (failure.status === 409) { try { setSettings(await request('/api/settings')); } catch { /* 原设置仍留在界面。 */ } }
    } finally { setSettingsBusy(false); }
  }
  async function logout() {
    try { await request('/api/logout', { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken }, body: '{}' }); images.items.clear(); previews.cache.clear(); setSession({ authenticated: false }); }
    catch (failure) { setError(failure.message); }
  }
  if (error) return <main className="center"><div className="panel"><p className="error" role="alert">{error}</p><button onClick={() => window.location.reload()}>重新连接</button></div></main>;
  if (!session) return <main className="center" role="status">正在连接…</main>;
  if (!session.authenticated) return <Login onLogin={setSession} />;
  if (!settings) return <main className="center" role="status">正在读取通用设置…</main>;
  const route = canvasRoute(path);
  if (route.kind === 'invalid') return <main className="center"><div className="panel invalid-canvas"><h2>画布链接无效</h2><p role="alert">链接标识须为1–80位小写字母、数字、下划线或连字符，且以字母或数字开头。</p><button onClick={() => navigate('/')}>返回首页</button></div></main>;
  return <>{route.kind === 'canvas' ? <CanvasEditor key={route.slug} slug={route.slug} session={session} autoSave={settings.settings.autoSave !== false} onSettings={() => setSettingsOpen(true)} /> : <CanvasList session={session} onSettings={() => setSettingsOpen(true)} onLogout={logout} />}{settingsOpen && <Settings settings={settings.settings} onToggle={toggle} busy={settingsBusy} error={settingsError} onClose={() => setSettingsOpen(false)} />}</>;
}

createRoot(document.getElementById('root')).render(<App />);
