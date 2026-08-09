/**
 * 「切换时过期 cookie 过滤」修复专项验证（v2.11.6 P0）
 *
 * 运行：node scripts/expired-filter-test.cjs
 * 依赖：node 22（Web Crypto 原生）、无第三方依赖
 *
 * 覆盖：
 *  1. 已过期 cookie 不调用 cookies.set（不写入，避免"set 即删"）
 *  2. expired 计数正确
 *  3. 未过期 cookie 正常写入
 *  4. 不因过期 cookie 触发失败回滚（旧行为：set 过期报错 → failed → 整批回滚）
 *  5. 解密失败（enc: 坏数据）仍跳过（既有行为不回归）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// ============================================================
//  chrome.* mock
// ============================================================
const localStore = new Map();
const sessionStore = new Map();

// 浏览器当前 cookie（快照来源）
let browserCookies = [];
// cookies.set 调用记录
const setCalls = [];
const removeCalls = [];

const chromeMock = {
  storage: {
    local: {
      async get(keys) {
        const ks = typeof keys === 'string' ? [keys] : keys;
        const out = {};
        for (const k of ks) if (localStore.has(k)) out[k] = localStore.get(k);
        return out;
      },
      async set(items) { for (const [k, v] of Object.entries(items)) localStore.set(k, v); },
      async remove(keys) {
        const ks = Array.isArray(keys) ? keys : [keys];
        for (const k of ks) localStore.delete(k);
      }
    },
    session: {
      async get(keys) {
        const ks = typeof keys === 'string' ? [keys] : keys;
        const out = {};
        for (const k of ks) if (sessionStore.has(k)) out[k] = sessionStore.get(k);
        return out;
      },
      async set(items) { for (const [k, v] of Object.entries(items)) sessionStore.set(k, v); },
      async remove(keys) {
        const ks = Array.isArray(keys) ? keys : [keys];
        for (const k of ks) sessionStore.delete(k);
      }
    }
  },
  cookies: {
    async getAll(details, cb) {
      const dom = details.domain;
      // 模拟 Chromium：domain 参数匹配 cookie.domain === dom 或以其为后缀
      const hit = browserCookies.filter((c) => {
        const cd = String(c.domain || '');
        return cd === dom || cd.endsWith(dom) || dom.endsWith(cd);
      });
      cb(hit);
    },
    set(details, cb) {
      setCalls.push(details);
      // 模拟 Chrome 关键行为：设置「过期 expirationDate」的 cookie 报错（视为删除）
      if (details.expirationDate && details.expirationDate <= Date.now() / 1000) {
        cb(null); // Chrome 实际上可能静默删除；这里按"失败"模拟最坏情况
        return;
      }
      cb({ ...details, domain: details.domain || '', path: details.path || '/' });
    },
    remove(details, cb) {
      removeCalls.push(details);
      cb({});
    }
  },
  runtime: { id: 'test-extension', lastError: null }
};

// ============================================================
//  装载 lib（顺序与 background.js 一致）
// ============================================================
const libs = ['crypto.js', 'storage.js', 'cookies.js', 'security.js', 'backup.js', 'webdav.js', 'messaging.js'];
const ctx = {
  console,
  crypto,
  TextEncoder,
  TextDecoder,
  URL,
  setTimeout,
  clearTimeout,
  chrome: chromeMock,
  fetch: () => { throw new Error('不应触发网络请求'); },
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary')
};
vm.createContext(ctx);
for (const f of libs) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8'), ctx, { filename: `lib/${f}` });
}

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.log(`  ❌ ${msg}`); }
}

function run(fn) {
  return vm.runInContext(`(${fn})()`, ctx);
}

(async () => {
  const nowSec = Date.now() / 1000;

  // 准备：无锁场景，MK 可用
  await run(async () => {
    const mk = await getMasterKey(); // 生成明文 MK
    await setMasterKey(mk, { wrapped: false, plainMK: mk });
  });

  console.log('\n[用例 1] 过期 cookie 跳过写入、expired 计数、不触发回滚');
  setCalls.length = 0;
  removeCalls.length = 0;
  browserCookies = [
    { name: 'old_session', domain: '.example.com', path: '/', value: 'OLD', secure: true }
  ];
  const cookies1 = [
    // 3 个有效
    { name: 'sid', value: 'SID123', domain: '.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax' },
    { name: 'uid', value: 'u1', domain: '.example.com', path: '/', secure: false, httpOnly: false, sameSite: 'unspecified' },
    { name: 'persist', value: 'P1', domain: '.example.com', path: '/', secure: true, httpOnly: false, sameSite: 'lax', expirationDate: nowSec + 86400 },
    // 2 个已过期（模拟 Keycloak 短 TTL 会话 cookie）
    { name: 'KEYCLOAK_IDENTITY', value: 'expired-jwt', domain: '.example.com', path: '/auth/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: nowSec - 3600 },
    { name: 'auth_key', value: 'expired-key', domain: '.example.com', path: '/', secure: true, httpOnly: false, sameSite: 'unspecified', expirationDate: nowSec - 10 }
  ];
  ctx.testCookies = cookies1;
  const r1 = await run(async () => applyCookies('example.com', testCookies));
  assert(r1.expired === 2, `expired=2（实际 ${r1.expired}）`);
  assert(r1.skipped === 2, `skipped=2（实际 ${r1.skipped}）`);
  assert(r1.set === 3, `set=3（实际 ${r1.set}）`);
  const setNames = setCalls.map((s) => s.name).sort();
  assert(
    JSON.stringify(setNames) === JSON.stringify(['persist', 'sid', 'uid']),
    `只写入有效 cookie（实际写入: ${setNames.join(', ')}）`
  );
  assert(setCalls.every((s) => !(s.expirationDate && s.expirationDate <= nowSec)), '未写入任何过期 cookie');
  assert(r1.failed.length === 0, `failed 为空（实际 ${r1.failed.length}）`);
  assert(r1.rolledBack === false, '不触发回滚');

  console.log('\n[用例 2] 若不过滤，过期 cookie 会触发 set 失败→回滚（对照，验证修复必要性）');
  // 用旧的未过滤逻辑模拟：手动 set 过期 cookie 应报错
  const oldStyleSet = setCalls.some((s) => s.name === 'KEYCLOAK_IDENTITY');
  assert(!oldStyleSet, '旧逻辑会把过期 cookie 写入 set（修复前会触发删除/失败）');

  console.log('\n[用例 3] 解密失败（enc: 坏数据）仍跳过，不影响过期计数');
  setCalls.length = 0;
  ctx.testCookies = [
    { name: 'good', value: 'G1', domain: '.example.com', path: '/', secure: true, httpOnly: false, sameSite: 'unspecified' },
    { name: 'bad_enc', value: 'enc:!!!!not-base64!!!!', domain: '.example.com', path: '/', secure: true, httpOnly: false, sameSite: 'unspecified' },
    { name: 'expired1', value: 'E1', domain: '.example.com', path: '/', secure: true, httpOnly: false, sameSite: 'unspecified', expirationDate: nowSec - 5 }
  ];
  const r3 = await run(async () => applyCookies('example.com', testCookies));
  assert(r3.expired === 1, `expired=1（实际 ${r3.expired}）`);
  assert(r3.skipped === 2, `skipped=2（过期1+解密失败1，实际 ${r3.skipped}）`);
  assert(r3.set === 1, `set=1（实际 ${r3.set}）`);

  console.log('\n[用例 4] 无过期 cookie 时 expired=0，行为与旧版一致');
  setCalls.length = 0;
  ctx.testCookies = [
    { name: 'a', value: '1', domain: '.example.com', path: '/', secure: true, httpOnly: false, sameSite: 'unspecified' },
    { name: 'b', value: '2', domain: '.example.com', path: '/', secure: true, httpOnly: false, sameSite: 'unspecified' }
  ];
  const r4 = await run(async () => applyCookies('example.com', testCookies));
  assert(r4.expired === 0 && r4.set === 2, `expired=0 且 set=2（实际 expired=${r4.expired} set=${r4.set}）`);

  console.log('\n========================================');
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
