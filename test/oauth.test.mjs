import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { CliOAuth } from '../server/oauth.mjs';

/** 临时假 profile 不访问真实授权；测试结束删除目录。 */
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'helix-oauth-'));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 2000000000000;
  let profile = { authMode: 'oauth', baseUrl: 'https://api.flowus.cn', issuerBaseUrl: 'https://api.flowus.cn', workspaceId: 'test-workspace', accessToken: 'fake-access-only-for-tests', refreshToken: 'fake-refresh-only-for-tests', accessTokenExpiresAtUnix: now / 1000 + 3600, refreshTokenExpiresAtUnix: now / 1000 + 86400 };
  const write = async patch => { profile = { ...profile, ...patch }; await writeFile(join(dir, 'credentials.json'), JSON.stringify(profile), { mode: 0o600 }); };
  await write();
  const calls = [];
  const provider = new CliOAuth({ configDir: dir, cliPath: '/test/flowus', workspaceId: 'test-workspace', now: () => now, env: { FLOWUS_TOKEN: 'fake-ambient-token', FLOWUS_BASE_URL: 'https://wrong.invalid', PATH: '/test' }, execFileImpl: async (...args) => { calls.push(args); return { stdout: JSON.stringify({ ok: true, data: { workspace_id: 'test-workspace' } }) }; }, ...overrides });
  return { dir, provider, calls, write, setNow: value => { now = value; }, now: () => now };
}

test('OAuth 必须显式使用独立绝对目录及 CLI 路径', () => {
  for (const configDir of [undefined, '', '.', '/', join(homedir(), '.flowus')]) assert.throws(() => new CliOAuth({ configDir, cliPath: '/test/flowus' }));
  assert.throws(() => new CliOAuth({ configDir: '/test/profile', cliPath: 'flowus' }));
});

test('首次检查并缓存 access token，清除环境中的旧 token 和地址', async t => {
  const f = await fixture(t);
  assert.equal(await f.provider.getToken(), 'fake-access-only-for-tests');
  assert.equal(await f.provider.getToken(), 'fake-access-only-for-tests');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0][1], ['--json', 'whoami']);
  assert.equal(f.calls[0][2].env.FLOWUS_CONFIG_DIR, f.dir);
  assert(!('FLOWUS_TOKEN' in f.calls[0][2].env));
  assert(!('FLOWUS_BASE_URL' in f.calls[0][2].env));
  assert.equal(JSON.stringify(f.provider), '{}');
});

test('并发首读与 force 共用一次检查，每十分钟再验', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 20 }, () => f.provider.getToken(true)));
  assert.equal(f.calls.length, 1);
  f.setNow(f.now() + 600000);
  await f.provider.getToken();
  assert.equal(f.calls.length, 2);
  await f.provider.getToken(true);
  assert.equal(f.calls.length, 3);
});

test('接近到期时调用 CLI，读取 CLI 更新后的 token', async t => {
  const f = await fixture(t);
  await f.write({ accessTokenExpiresAtUnix: f.now() / 1000 + 120 });
  await f.provider.getToken();
  f.setNow(f.now() + 61000);
  await f.write({ accessToken: 'fake-rotated-access', accessTokenExpiresAtUnix: f.now() / 1000 + 3600 });
  assert.equal(await f.provider.getToken(), 'fake-rotated-access');
  assert.equal(f.calls.length, 2);
});

test('CLI 错误不泄露 stdout、stderr、凭据或继续提供旧缓存', async t => {
  let fail = false;
  const f = await fixture(t, { execFileImpl: async () => {
    if (fail) throw Object.assign(new Error('fake-secret-error'), { stdout: 'fake-secret-stdout', stderr: 'fake-secret-stderr' });
    return { stdout: JSON.stringify({ ok: true, data: { workspace_id: 'test-workspace' } }) };
  } });
  await f.provider.getToken(); fail = true;
  for (const force of [true, false]) await assert.rejects(f.provider.getToken(force), error => error.status === 503 && !/fake-secret/.test(String(error)) && !error.cause);
});

test('拒绝错误身份、过期授权、环境兼容 token 回退和宽松文件权限', async t => {
  const f = await fixture(t);
  for (const patch of [{ workspaceId: 'wrong' }, { workspaceId: 'test-workspace', accessToken: '', token: 'fake-legacy' }, { accessToken: 'fake-good', accessTokenExpiresAtUnix: f.now() / 1000 }, { accessTokenExpiresAtUnix: f.now() / 1000 + 3600, authMode: 'manual' }]) {
    await f.write(patch);
    await assert.rejects(f.provider.getToken(true), { status: 503 });
  }
  await f.write({ authMode: 'oauth' });
  await chmod(join(f.dir, 'credentials.json'), 0o644);
  await assert.rejects(f.provider.getToken(true), { status: 503 });
});

test('拒绝凭据符号链接和可被其他用户访问的配置目录', async t => {
  const f = await fixture(t);
  const path = join(f.dir, 'credentials.json');
  await rm(path); await symlink('/does-not-exist', path);
  await assert.rejects(f.provider.getToken(), { status: 503 });
  await chmod(f.dir, 0o755);
  await assert.rejects(f.provider.getToken(), { status: 503 });
  assert.equal(f.calls.length, 0);
});
