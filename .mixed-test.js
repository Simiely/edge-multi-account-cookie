// 验证：旧 enc: 加密数据 + 新明文数据 混合共存，切换全部正常
const fs = require('fs');
const vm = require('vm');
const ROOT = __dirname;

const store = {};
globalThis.chrome = {
  storage: {
    local: { get: async (k) => { const ks = Array.isArray(k) ? k : [k]; const out = {}; for (const kk of ks) if (store[kk] !== undefined) out[kk] = store[kk]; return out; }, set: async (o) => Object.assign(store, o), remove: async (k) => { delete store[k]; } },
    session: { get: async (k) => { const ks = Array.isArray(k) ? k : [k]; const out = {}; for (const kk of ks) if (store['sess_' + kk] !== undefined) out[kk] = store['sess_' + kk]; return out; }, set: async (o) => { for (const [k, v] of Object.entries(o)) store['sess_' + k] = v; }, remove: async (k) => { delete store['sess_' + k]; } }
  },
  cookies: { getAll: (d, cb) => cb([]), set: (d, cb) => { globalThis.__sets = globalThis.__sets || []; globalThis.__sets.push(d); cb({}); }, remove: (d, cb) => cb() },
  runtime: { id: 't', lastError: null }
};

['lib/crypto.js','lib/storage.js','lib/cookies.js','lib/security.js','lib/messaging.js','lib/backup.js','lib/webdav.js',
 'handlers/tab.js','handlers/account.js','handlers/settings.js','handlers/backup.js','handlers/webdav.js'].forEach((f) =>
  vm.runInThisContext(fs.readFileSync(f, 'utf8'), { filename: f }));

(async () => {
  let pass = 0, fail = 0;
  const check = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' | ' + n); c ? pass++ : fail++; };

  // 模拟历史 v2.5 加密数据（MK 在 storage）
  store['cookie_switcher_mk'] = 'F9kR8QpzL2mN4vX7T1cY0bW6dS3aH5eJ';
  const mk = store['cookie_switcher_mk'];
  const enc1 = 'enc:' + await encryptWithKey('session-token-A', mk);
  const enc2 = 'enc:' + await encryptWithKey('z'.repeat(3000), mk);
  store['cookie_switcher_data'] = { version: 3, accounts: {
    'ex.com': {
      '旧加密号': { cookies: [
        { name: 'token', value: enc1, domain: 'ex.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax' },
        { name: 'big', value: enc2, domain: 'ex.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax' }
      ], localStorage: {}, group: '', createdAt: 1, updatedAt: 1 }
    }
  }};

  // 切换旧加密号 → 应解密并写入明文
  globalThis.__sets = [];
  const r1 = await ACCOUNT_ACTIONS['account.switch']({ domain: 'ex.com', name: '旧加密号', tabId: 1 });
  const t1 = globalThis.__sets.find((s) => s.name === 'token');
  const b1 = globalThis.__sets.find((s) => s.name === 'big');
  check('1. 旧加密数据切换无失败', r1.failed.length === 0);
  check('2. 小 token 解密正确', t1 && t1.value === 'session-token-A');
  check('3. 3000B 大加密数据解密写入', b1 && b1.value.length === 3000 && b1.value.length <= 4096);

  // 新保存明文账号 → 明文直写
  const r2 = await ACCOUNT_ACTIONS['account.save']({ domain: 'ex.com', name: '新明文号', group: '', tabId: 1 });
  check('4. 新账号明文保存', r2.saved === 1);
  const stored = store['cookie_switcher_data'].accounts['ex.com']['新明文号'];
  check('5. 新数据无 enc: 前缀', stored.cookies.length === 0 || !stored.cookies.some((c) => String(c.value).startsWith('enc:')));

  console.log('\n结果: ' + pass + ' PASS / ' + fail + ' FAIL');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
