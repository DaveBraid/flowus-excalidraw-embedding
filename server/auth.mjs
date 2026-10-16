import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** 用 scrypt 保存密码校验值；输入密码，输出带随机盐的哈希。 */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 1024) return false;
  const [kind, salt, digest] = encoded.split(':');
  if (kind !== 'scrypt' || !salt || !/^[0-9a-f]{128}$/.test(digest || '')) return false;
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(digest, 'hex'));
}
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** 签名会话不需要数据库；输入密钥/密码版本，输出会话及 CSRF 验证器。 */
export class Auth {
  constructor(key, passwordHash, { ttl = null, secure = true, now = () => Date.now() } = {}) {
    if (key.length < 32 || !passwordHash.startsWith('scrypt:')) throw new Error('Authentication secrets are not configured');
    this.key = key; this.passwordHash = passwordHash; this.ttl = ttl; this.secure = secure; this.now = now;
    this.cookieName = secure ? '__Host-draw' : 'draw-dev';
    this.version = this.sign(passwordHash).slice(0, 16);
  }
  sign(value) { return createHmac('sha256', this.key).update(value).digest('base64url'); }
  issue() {
    const now = this.now();
    const china = new Date(now + 8 * 3600000); // 固定采用北京时间，避免服务器时区影响。
    const expiresAt = this.ttl === null ? Date.UTC(china.getUTCFullYear(), china.getUTCMonth() + 1, 1) - 8 * 3600000 : now + this.ttl * 1000;
    const payload = Buffer.from(JSON.stringify({ exp: expiresAt, nonce: randomBytes(18).toString('hex'), ver: this.version })).toString('base64url');
    const token = `${payload}.${this.sign(payload)}`;
    return { token, expiresAt, csrfToken: this.sign(`csrf:${token}`) };
  }
  parse(token) {
    if (typeof token !== 'string' || token.length > 1024) return null;
    const pieces = token.split('.');
    if (pieces.length !== 2 || !equal(pieces[1], this.sign(pieces[0]))) return null;
    try {
      const payload = JSON.parse(Buffer.from(pieces[0], 'base64url').toString());
      if (!Number.isFinite(payload.exp) || payload.exp <= this.now() || payload.ver !== this.version) return null;
      return { token, expiresAt: payload.exp, csrfToken: this.sign(`csrf:${token}`) };
    } catch { return null; }
  }
  fromRequest(req) {
    const item = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${this.cookieName}=`));
    return this.parse(item?.slice(this.cookieName.length + 1));
  }
  cookie(token, clear = false) {
    const seconds = clear ? 0 : Math.max(0, Math.floor(((this.parse(token)?.expiresAt || this.now()) - this.now()) / 1000));
    return `${this.cookieName}=${clear ? '' : token}; Path=/; HttpOnly; Max-Age=${seconds}; ${this.secure ? 'Secure; SameSite=None; Partitioned' : 'SameSite=Lax'}`;
  }
  csrf(session, value) { return session && equal(session.csrfToken, value); }
}
