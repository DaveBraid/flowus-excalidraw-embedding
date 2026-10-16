import { readFileSync } from 'node:fs';
import { Auth } from '../server/auth.mjs';

// 仅在容器内签发短会话验证封写，任何令牌与密钥都不输出。
const auth = new Auth(readFileSync(process.env.SESSION_SECRET_FILE, 'utf8').trim(), readFileSync(process.env.PASSWORD_HASH_FILE, 'utf8').trim(), { ttl: 30 });
const issued = auth.issue();
const response = await fetch('http://127.0.0.1:3000/api/settings', { method: 'PUT', headers: {
  Cookie: `${auth.cookieName}=${issued.token}`, Origin: process.env.PUBLIC_ORIGIN, 'Content-Type': 'application/json', 'X-CSRF-Token': issued.csrfToken,
}, body: JSON.stringify({ revision: 'maintenance-probe-deliberately-invalid', settings: { autoSave: true } }) });
console.log(JSON.stringify({ maintenanceWriteStatus: response.status }));
if (response.status !== 503) throw new Error('维护封写未生效，停止迁移');
