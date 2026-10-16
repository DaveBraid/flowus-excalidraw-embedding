import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { ServiceError } from './flowus.mjs';

const execute = promisify(execFile);
const CHECK_INTERVAL = 10 * 60 * 1000; // 最多每十分钟交给官方 CLI 检查授权。
const EXPIRY_MARGIN = 60 * 1000; // 提前一分钟检查，避免请求途中到期。

/** 官方 CLI 独占刷新；输入独立目录和 CLI 路径，输出仅含 access token 的内存提供器。 */
export class CliOAuth {
  #token;
  #expiresAt = 0;
  #checkedAt = -Infinity;
  #pending;
  #configDir;
  #cliPath;
  #run;
  #now;
  #environment;
  #workspaceId;

  /** 必须显式指定独立 profile；拒绝静默回退到宿主机默认授权。 */
  constructor({ configDir, cliPath, workspaceId, execFileImpl = execute, now = Date.now, env = process.env } = {}) {
    if (typeof configDir !== 'string' || !isAbsolute(configDir) || resolve(configDir) === '/' || resolve(configDir) === resolve(homedir(), '.flowus')) {
      throw new TypeError('必须指定独立的 FlowUs OAuth 绝对目录');
    }
    if (typeof cliPath !== 'string' || !isAbsolute(cliPath)) throw new TypeError('必须指定官方 FlowUs CLI 的绝对路径');
    this.#configDir = resolve(configDir);
    this.#cliPath = resolve(cliPath);
    this.#workspaceId = workspaceId;
    this.#run = execFileImpl;
    this.#now = now;
    this.#environment = { ...env, FLOWUS_CONFIG_DIR: this.#configDir };
    delete this.#environment.FLOWUS_TOKEN; // 环境 token 的优先级高于独立 profile。
    delete this.#environment.FLOWUS_BASE_URL; // 固定使用官方生产 API。
  }

  /** 并发请求共用一次 CLI 检查；force 用于 401 后重验，刷新细节始终归 CLI。 */
  async getToken(force = false) {
    if (this.#pending) return this.#pending;
    const now = this.#now();
    if (!force && this.#token && now - this.#checkedAt < CHECK_INTERVAL && now < this.#expiresAt - EXPIRY_MARGIN) return this.#token;
    this.#pending = this.#check();
    try { return await this.#pending; } finally { this.#pending = undefined; }
  }

  /** 不记录 CLI stdout/stderr；凭据只从新服务器目录读取，不返回 refresh token。 */
  async #check() {
    this.#token = undefined; // 检查失败时拒绝继续使用旧缓存。
    try {
      const directory = await lstat(this.#configDir);
      if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)) throw new Error();
      this.#validateProfile(await this.#readProfile()); // 调用 CLI 前阻止错误地址、手动 token 或凭据链接。
      const result = await this.#run(this.#cliPath, ['--json', 'whoami'], {
        env: this.#environment, encoding: 'utf8', timeout: 30000, maxBuffer: 262144,
      });
      const identity = JSON.parse(result.stdout);
      if (identity.ok !== true || !identity.data?.workspace_id || (this.#workspaceId && identity.data.workspace_id !== this.#workspaceId)) throw new Error();
      const profile = await this.#readProfile();
      this.#validateProfile(profile);
      if (profile.workspaceId !== identity.data.workspace_id) throw new Error();
      const expiresAt = profile.accessTokenExpiresAtUnix * 1000;
      if (expiresAt <= this.#now() + EXPIRY_MARGIN) throw new Error();
      this.#expiresAt = expiresAt;
      this.#checkedAt = this.#now();
      this.#token = profile.accessToken;
      return this.#token;
    } catch {
      throw new ServiceError(503, 'FlowUs 独立 OAuth 授权不可用，请检查服务器授权');
    }
  }

  /** 检查独立 OAuth 元数据；到期 access token 可交给 CLI 刷新，过期 refresh 授权直接失败。 */
  #validateProfile(profile) {
    if (profile.authMode !== 'oauth' || profile.baseUrl !== 'https://api.flowus.cn' || profile.issuerBaseUrl !== 'https://api.flowus.cn' || typeof profile.workspaceId !== 'string' || !profile.workspaceId || (this.#workspaceId && profile.workspaceId !== this.#workspaceId)) throw new Error();
    if (typeof profile.accessToken !== 'string' || !profile.accessToken || /\s/.test(profile.accessToken) || typeof profile.refreshToken !== 'string' || !profile.refreshToken) throw new Error();
    if (!Number.isFinite(profile.accessTokenExpiresAtUnix) || !Number.isFinite(profile.refreshTokenExpiresAtUnix) || profile.refreshTokenExpiresAtUnix * 1000 <= this.#now()) throw new Error();
  }

  /** 官方文件为 credentials.json；accessTokenExpiresAtUnix 为秒，不读 token 兼容字段作回退。 */
  async #readProfile() {
    const file = await open(join(this.#configDir, 'credentials.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 65536 || (info.mode & 0o077)) throw new Error();
      return JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
  }
}
