import { mkdir, open, lstat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { hashPassword } from '../server/auth.mjs';

/** 本机交互创建独立密码哈希和会话密钥；不回显密码，已有秘密文件不覆盖。 */
async function createSecrets() {
  if (!process.stdin.isTTY) throw new Error('请在交互终端运行，以隐藏密码输入');
  await mkdir('secrets', { recursive: true, mode: 0o700 });
  for (const name of ['password-hash', 'session-secret']) {
    const exists = await lstat(`secrets/${name}`).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (exists) throw new Error(`secrets/${name} 已存在；请先按维护文档备份并移走两个秘密文件`); // 输入密码前检查整组文件，避免常见的部分创建。
  }
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const input = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stdout.write('设置共享访问密码（至少12字符，输入隐藏）：');
  let password;
  try { password = await input.question(''); } finally { input.close(); process.stdout.write('\n'); }
  if (password.length < 12) throw new Error('密码至少需要12字符');
  for (const [name, value] of [['password-hash', hashPassword(password)], ['session-secret', randomBytes(32).toString('hex')]]) {
    const file = await open(`secrets/${name}`, 'wx', 0o600); // 独占新建，防止意外重置现有登录。
    try { await file.writeFile(value); } finally { await file.close(); }
  }
  console.log('已创建 secrets/password-hash 与 secrets/session-secret');
}

await createSecrets();
