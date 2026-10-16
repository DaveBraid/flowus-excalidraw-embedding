import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Auth, verifyPassword } from './auth.mjs';
import { FlowUs, ServiceError, secret, validSlug } from './flowus.mjs';
import { Canvases } from './storage.mjs';
import { CliOAuth } from './oauth.mjs';
import { startAssetCollector } from './gc.mjs';

/** 读取有大小限制的 JSON 请求，避免无界内存分配。 */
async function jsonBody(req, limit = 32 * 1024 ** 2) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new ServiceError(415, '需要 JSON 请求');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new ServiceError(413, '请求体超过容量限制'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new ServiceError(400, 'JSON 格式错误'); }
}

/** 创建 HTTP 服务；依赖可注入以验证鉴权、项目边界及失败行为。 */
export function createApp({ auth, canvases, origin, readOnly = false, dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist') }) {
  const attempts = new Map(); let activeLogin = false;
  const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  const handle = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'self' https://flowus.cn https://*.flowus.cn; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, origin); const path = url.pathname;
      if (path === '/healthz' && req.method === 'GET') return send(res, 200, { ok: true });
      const session = auth.fromRequest(req);
      const cacheable = req.method === 'GET' && /^\/api\/(settings|canvases(?:\/[^/]+(?:\/assets\/[^/]+|\/thumbnail)?)?)$/.test(path);
      if (session && cacheable && canvases.api?.reads && !canvases.api.reads.scope.getStore()) {
        return canvases.readOnly(() => handle(req, res), url.searchParams.get('fresh') === '1');
      }
      if (path === '/api/session' && req.method === 'GET') return send(res, 200, session ? { authenticated: true, csrfToken: session.csrfToken, expiresAt: session.expiresAt } : { authenticated: false });
      if (path.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method)) {
        if (req.headers.origin !== origin) throw new ServiceError(403, '请求来源无效'); // 同源校验覆盖登录 CSRF。
      }
      if (path === '/api/login' && req.method === 'POST') {
        // 仅信任同机反向代理覆盖的客户端地址；每地址限制并保护 scrypt CPU。
        const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
        const now = Date.now();
        for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
        const attempt = attempts.get(ip) || { count: 0, until: now + 15 * 60000 };
        if (attempt.count >= 8 || activeLogin || attempts.size > 10000) throw new ServiceError(429, '登录尝试过多，请稍后重试');
        attempt.count++; attempts.set(ip, attempt); // 请求体到达前原子占位，慢请求和并发请求共用配额。
        if (Number(req.headers['content-length']) > 100000) throw new ServiceError(413, '请求体超过容量限制');
        let body; let bodyTimer;
        try {
          body = await Promise.race([
            jsonBody(req, 100000), // 登录请求仅接受 100 KB。
            new Promise((_, reject) => { bodyTimer = setTimeout(() => {
              res.setHeader('Connection', 'close'); req.pause?.(); // 超时响应后关闭连接，不保留未读请求体。
              reject(new ServiceError(408, '登录请求超时，请重试'));
            }, 10000); }),
          ]);
        } finally { clearTimeout(bodyTimer); }
        activeLogin = true;
        let valid;
        try { valid = verifyPassword(body?.password, auth.passwordHash); } finally { activeLogin = false; }
        if (!valid) throw new ServiceError(401, '密码不正确');
        attempts.delete(ip);
        const issued = auth.issue(); res.setHeader('Set-Cookie', auth.cookie(issued.token));
        return send(res, 200, { authenticated: true, csrfToken: issued.csrfToken, expiresAt: issued.expiresAt });
      }
      if (path.startsWith('/api/')) {
        if (!session) throw new ServiceError(401, '请先登录');
        if (!['GET', 'HEAD'].includes(req.method) && !auth.csrf(session, req.headers['x-csrf-token'])) throw new ServiceError(403, '会话校验失败，请重新登录');
        if (readOnly && !['GET', 'HEAD'].includes(req.method) && path !== '/api/logout') { res.setHeader('Retry-After', '30'); throw new ServiceError(503, '正在迁移存储，暂时只读；请保留本地修改，完成后重新加载'); }
        if (path === '/api/logout' && req.method === 'POST') { res.setHeader('Set-Cookie', auth.cookie('', true)); return send(res, 200, { ok: true }); }
        if (path === '/api/settings' && req.method === 'GET') return send(res, 200, await canvases.settings());
        if (path === '/api/settings' && req.method === 'PUT') return send(res, 200, await canvases.settings(await jsonBody(req, 100000)));
        if (path === '/api/canvases' && req.method === 'GET') return send(res, 200, await canvases.list());
        if (path === '/api/canvases' && req.method === 'POST') return send(res, 201, await canvases.create(await jsonBody(req, 100000)));
        const operation = path.match(/^\/api\/canvases\/([^/]+)\/operations\/([^/]+)$/);
        if (operation && req.method === 'GET') return send(res, 200, await canvases.operationStatus(decodeURIComponent(operation[1]), decodeURIComponent(operation[2])));
        const management = path.match(/^\/api\/canvases\/([^/]+)\/manage$/);
        if (management && req.method === 'POST') return send(res, 200, await canvases.manage(decodeURIComponent(management[1]), await jsonBody(req, 100000)));
        const thumbnail = path.match(/^\/api\/canvases\/([^/]+)\/thumbnail$/);
        if (thumbnail && ['GET', 'PUT'].includes(req.method)) return send(res, 200, await canvases.thumbnail(decodeURIComponent(thumbnail[1]), url.searchParams.get('revision'), req.method === 'PUT' ? await jsonBody(req, 150000) : undefined));
        const asset = path.match(/^\/api\/canvases\/([^/]+)\/assets\/([^/]+)$/);
        if (asset && req.method === 'GET') return send(res, 200, await canvases.asset(decodeURIComponent(asset[1]), decodeURIComponent(asset[2]), url.searchParams.get('hash')));
        const preview = path.match(/^\/api\/canvases\/([^/]+)\/preview$/);
        if (preview && req.method === 'GET') return send(res, 200, await canvases.preview(decodeURIComponent(preview[1]), url.searchParams.get('revision')));
        const match = path.match(/^\/api\/canvases\/([^/]+)$/);
        if (match) {
          const slug = decodeURIComponent(match[1]);
          if (req.method === 'GET') return send(res, 200, await canvases.load(slug, url.searchParams.get('manifest') === '1'));
          if (req.method === 'PUT') return send(res, 200, await canvases.save(slug, await jsonBody(req)));
        }
        throw new ServiceError(404, '接口不存在');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new ServiceError(405, '方法不支持');
      const match = path.match(/^\/c\/([^/]+)\/?$/);
      let file;
      if (path === '/' || (match && validSlug(decodeURIComponent(match[1])))) file = resolve(dist, 'index.html');
      else if (/^\/(assets|fonts|excalidraw-assets)\/[a-zA-Z0-9_./-]+$/.test(path) && !path.includes('..')) file = resolve(dist, `.${path}`);
      else if (path === '/favicon.svg') file = resolve(dist, 'favicon.svg');
      else throw new ServiceError(404, '页面不存在');
      if (!file.startsWith(resolve(dist) + '/')) throw new ServiceError(404, '资源不存在');
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.json': 'application/json' }[extname(file)] || 'application/octet-stream';
      if (!(await stat(file)).isFile()) throw new ServiceError(404, '资源不存在');
      // 仅带构建指纹的资源长期缓存；HTML和API继续no-store。
      if (/^\/assets\/.+-[\w-]{8,}\.(js|css|woff2?)$/.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      let served = file;
      if (/\.(js|css)$/.test(file)) {
        res.setHeader('Vary', 'Accept-Encoding');
        const accepts = String(req.headers['accept-encoding'] || '').split(',').map(part => part.trim().split(';'));
        for (const [encoding, suffix] of [['br', '.br'], ['gzip', '.gz']]) {
          if (!accepts.some(([name, ...params]) => name === encoding && !params.some(p => /^q=0(?:\.0*)?$/.test(p.trim())))) continue;
          if (await stat(file + suffix).then(s => s.isFile()).catch(() => false)) { served = file + suffix; res.setHeader('Content-Encoding', encoding); break; }
        }
      }
      const data = await readFile(served); res.writeHead(200, { 'Content-Type': mime }); res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      const status = error instanceof ServiceError ? error.status : error instanceof URIError ? 400 : error.code === 'ENOENT' ? 404 : 500;
      send(res, status, { error: status === 500 ? '服务发生错误，请稍后重试' : error.message, ...(error instanceof ServiceError && error.code ? { code: error.code } : {}) });
    }
  };
  return createServer(handle);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.FLOWUS_NATIVE_ROOT_ID || !process.env.FLOWUS_WORKSPACE_ID) throw new Error('请先配置工作区并运行 ops/init-native.mjs，将原生设置页ID填入 .env'); // 禁止新部署静默回退到旧JSON附件写入。
  const origin = process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:3000';
  const tokenProvider = new CliOAuth({ configDir: process.env.FLOWUS_CONFIG_DIR, cliPath: process.env.FLOWUS_CLI_PATH || '/usr/local/bin/flowus', workspaceId: process.env.FLOWUS_WORKSPACE_ID });
  const auth = new Auth(secret('SESSION_SECRET'), secret('PASSWORD_HASH'), { secure: !origin.startsWith('http://127.0.0.1') && !origin.startsWith('http://localhost') });
  const canvases = new Canvases(new FlowUs({ tokenProvider }), {
    rootId: process.env.FLOWUS_ROOT_ID, uploadPageId: process.env.FLOWUS_UPLOAD_PAGE_ID, nativeRootId: process.env.FLOWUS_NATIVE_ROOT_ID || '',
    budgetBytes: Number(process.env.CANVAS_UPLOAD_BUDGET_BYTES || 2147483648), // 每张画布累计成功上传估算的软提示阈值，默认2 GiB。
    settingsBudgetBytes: Number(process.env.SETTINGS_UPLOAD_BUDGET_BYTES || 67108864), // 全局偏好累计上传软提示预留，默认64 MiB。
  });
  const server = createApp({ auth, canvases, origin, readOnly: process.env.DRAW_READ_ONLY === '1' });
  const stopCollector = process.env.DRAW_READ_ONLY === '1' ? async () => {} : startAssetCollector(canvases); // 只读维护不登记或回收任何附件。
  server.requestTimeout = 180000; // 图片请求允许 3 分钟传输，正文始终限制大小。
  server.headersTimeout = 10000;
  server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Excalidraw FlowUs service ready'));
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (stopping) return; stopping = true;
    await Promise.all([stopCollector(), new Promise(done => server.close(done))]); process.exit(0); // 同时等待保存与后台回收退出。
  });
}
