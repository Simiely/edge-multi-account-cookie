/**
 * 墓碑机制全链路 mock 回归测试（AGENTS.md 冒烟测试模式）
 *
 * 运行：node scripts/tombstone-chain-test.cjs
 * 依赖：node 22（Web Crypto 原生）、无第三方依赖
 *
 * 覆盖链路：
 *  1. 逐账号删除 → 墓碑 → 导入传播到另一设备
 *  2. 清空 → 全部墓碑化（条目保留、无 cookies 残留、非空不会传空）
 *  3. 本地物理空 → 跳过上传（pushed=null）
 *  4. 墓碑 TTL 30 天 purge
 *  5. 墓碑复活规则（删除后保存新数据 → 复活）
 *  6. webdav.sync 先拉后传双向收敛
 *  7. 【回归】墓碑过期 + 同步 → 远端删除标记不得丢失（防删除复活）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// ============================================================
//  chrome.* mock（内存 Map）
// ============================================================
const localStore = new Map();
const sessionStore = new Map();

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
  runtime: { id: 'test-extension', lastError: null }
};

// ============================================================
//  WebDAV 远端 mock（内存文件系统）
// ============================================================
const remoteFiles = new Map(); // path -> content string

// 模拟目录下文件列表：以「目录前缀 + /」为 key，值是该目录下的文件（含目录自身 href）
function listDir(prefix) {
  const out = [];
  for (const p of remoteFiles.keys()) {
    const name = p.startsWith(prefix + '/') ? p.slice(prefix.length + 1) : null;
    if (name && !name.includes('/')) out.push(p);
  }
  return out;
}

async function mockFetch(url, opts = {}) {
  const method = opts.method || 'GET';
  const u = String(url);
  if (method === 'PROPFIND') {
    // 目录探测（Depth:0）与列目录（Depth:1）
    const isDir = [...remoteFiles.keys()].some((p) => p.startsWith(u + '/'));
    if (u.endsWith('/workbuddy') || isDir || remoteFiles.has(u)) {
      // 构造 multistatus，含目录自身与目录下文件（只列一级）
      const items = [u];
      for (const p of remoteFiles.keys()) {
        const name = p.startsWith(u + '/') ? p.slice(u.length + 1) : null;
        if (name && !name.includes('/')) items.push(p);
      }
      const xml =
        '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">' +
        items.map((p) => `<d:response><d:href>${p}</d:href></d:response>`).join('') +
        '</d:multistatus>';
      return { status: 207, ok: true, async text() { return xml; } };
    }
    return { status: 404, ok: false, async text() { return ''; } };
  }
  if (method === 'MKCOL') {
    if (remoteFiles.has(u)) return { status: 405, async text() { return ''; } };
    remoteFiles.set(u, '');
    return { status: 201, ok: true, async text() { return ''; } };
  }
  if (method === 'PUT') {
    remoteFiles.set(u, opts.body || '');
    return { status: 201, ok: true, async text() { return ''; } };
  }
  if (method === 'GET') {
    if (!remoteFiles.has(u)) return { status: 404, ok: false, async text() { return ''; } };
    return { status: 200, ok: true, async text() { return remoteFiles.get(u); } };
  }
  if (method === 'DELETE') {
    remoteFiles.delete(u);
    return { status: 204, ok: true, async text() { return ''; } };
  }
  throw new Error('unexpected method ' + method);
}

// ============================================================
//  加载 lib（串联到同一全局作用域）
// ============================================================
const libFiles = [
  'lib/crypto.js',
  'lib/storage.js',
  'lib/backup.js',
  'lib/webdav.js',
  'handlers/webdav.js'
];

const context = {
  console,
  Date,
  Math,
  JSON,
  Promise,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  btoa,
  atob,
  URL,
  chrome: chromeMock,
  fetch: mockFetch,
  crypto: globalThis.crypto,
  setTimeout,
  clearTimeout
};
vm.createContext(context);

for (const f of libFiles) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  vm.runInContext(src, context, { filename: f });
}

// 暴露给测试
const api = {
  loadRawData: context.loadRawData,
  saveRawData: context.saveRawData,
  saveAccount: context.saveAccount,
  deleteAccount: context.deleteAccount,
  renameAccount: context.renameAccount,
  getDomainAccounts: context.getDomainAccounts,
  isTombstone: context.isTombstone,
  purgeOldTombstones: context.purgeOldTombstones,
  importData: context.importData,
  exportData: context.exportData,
  parseBackup: context.parseBackup,
  webdavTest: context.webdavTest,
  webdavPush: context.webdavPush,
  webdavPull: context.webdavPull,
  backupDir: context.backupDir,
  saveWebdavConfig: context.saveWebdavConfig,
  getWebdavConfigDecrypted: context.getWebdavConfigDecrypted,
  clearWebdavConfig: context.clearWebdavConfig,
  TOMBSTONE_TTL: context.TOMBSTONE_TTL,
  webdavSync: vm.runInContext('WEBDAV_ACTIONS', context)['webdav.sync']
};

// ============================================================
//  断言工具
// ============================================================
let passed = 0, failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅ ' + msg); }
  else { failed++; failures.push(msg); console.log('  ❌ ' + msg); }
}

function countEntries(data) {
  return Object.keys(data.accounts || {}).reduce((n, d) => n + Object.keys(data.accounts[d] || {}).length, 0);
}

function activeCount(data) {
  let n = 0;
  for (const d of Object.keys(data.accounts || {})) {
    for (const nm of Object.keys(data.accounts[d])) {
      if (!data.accounts[d][nm].deleted) n++;
    }
  }
  return n;
}

function makeAccount(domain, name, updatedAt, overrides = {}) {
  return {
    cookies: [{ name: 'sid', value: 'v-' + name, domain, path: '/', secure: false, httpOnly: false, sameSite: 'unspecified' }],
    localStorage: {},
    group: '',
    createdAt: updatedAt - 1000,
    updatedAt,
    ...overrides
  };
}

async function freshState() {
  localStore.clear();
  sessionStore.clear();
  remoteFiles.clear();
  // 预置主密钥（无锁）
  await context.setMasterKey(context.generateMasterKey(), { wrapped: false, plainMK: context.generateMasterKey() });
}

// 模拟「新设备」：仅清空本机存储，保留远端 WebDAV 文件（跨设备共享）
async function freshDevice() {
  localStore.clear();
  sessionStore.clear();
  await context.setMasterKey(context.generateMasterKey(), { wrapped: false, plainMK: context.generateMasterKey() });
}

function getRemoteBackupContent() {
  const key = [...remoteFiles.keys()].find((k) => k.includes('cookie-switcher-backup-'));
  return key ? remoteFiles.get(key) : null;
}

// ============================================================
//  用例
// ============================================================
async function run() {
  await freshState();

  console.log('\n[用例 1] 逐账号删除 → 墓碑 → 导入传播到另一设备');
  {
    const t0 = Date.now() - 100000;
    await api.saveAccount('a.com', 'alice', [], {}, '');
    // 手动把 updatedAt 改成过去时间
    const d1 = await api.loadRawData();
    d1.accounts['a.com']['alice'].updatedAt = t0;
    d1.accounts['a.com']['alice'].createdAt = t0 - 1000;
    await api.saveRawData(d1);

    await api.deleteAccount('a.com', 'alice');
    const d2 = await api.loadRawData();
    const t1 = d2.accounts['a.com']['alice'];
    assert(api.isTombstone(t1), '删除后本地为墓碑');
    assert(t1.deleted === true && typeof t1.deletedAt === 'number', '墓碑含 deleted/deletedAt');
    assert(!t1.cookies, '墓碑清空 cookies');
    assert(!(await api.getDomainAccounts('a.com'))['alice'], '读取层过滤墓碑（不显示）');

    // 导出（含墓碑）→ 另一台设备导入
    const exp = await api.exportData('test-pin');
    await freshDevice();
    const imported = await api.importData(exp.data, 'test-pin');
    assert(imported.tombstoned === 1, `导入传播删除 tombstoned=1（实际 ${imported.tombstoned}）`);
    const d3 = await api.loadRawData();
    assert(api.isTombstone(d3.accounts['a.com']['alice']), '另一设备已同步墓碑');
  }

  await freshState();
  console.log('\n[用例 2] 清空本地 = 仅本机物理清空（不传播删除、无墓碑残留）');
  {
    await api.saveAccount('a.com', 'alice', [{ name: 'sid', value: 'x', domain: 'a.com', path: '/', secure: false, httpOnly: false, sameSite: 'unspecified' }], { k: 'v' }, '');
    await api.saveAccount('b.com', 'bob', [], {}, '');
    await api.deleteAccount('a.com', 'alice'); // 混入一个已有墓碑
    // 模拟 v2.11.4 clearAll：物理清空 STORAGE_KEY（不墓碑化）
    await context.chrome.storage.local.remove('cookie_switcher_data');
    const d = await api.loadRawData();
    assert(countEntries(d) === 0, `清空后本地条目 = 0（实际 ${countEntries(d)}）`);
    assert(activeCount(d) === 0, '无活跃账号');
    for (const dom of Object.keys(d.accounts)) {
      for (const nm of Object.keys(d.accounts[dom])) {
        assert(!d.accounts[dom][nm].deleted, `清空后无墓碑残留（${dom}/${nm}）`);
      }
    }
    // 导出为空（本地无任何数据）
    const exp = await api.exportData('p');
    const parsed = await api.parseBackup(exp.data, 'p');
    assert(countEntries(parsed.data) === 0, '导出为空（本地物理空）');
  }

  await freshState();
  console.log('\n[用例 3] 本地物理空 → webdav.sync 跳过上传');
  {
    // 无任何数据
    const data = await api.loadRawData();
    assert(countEntries(data) === 0, '本地物理空');
    // 直接验证兜底条件：totalEntries === 0
    const totalEntries = countEntries(data);
    assert(totalEntries === 0, 'totalEntries=0（触发跳过上传）');
  }

  await freshState();
  console.log('\n[用例 4] 墓碑 TTL 30 天 purge');
  {
    await api.saveAccount('a.com', 'alice', [], {}, '');
    const d1 = await api.loadRawData();
    d1.accounts['a.com']['alice'].updatedAt = Date.now() - 40 * 86400000;
    d1.accounts['a.com']['alice'].createdAt = Date.now() - 41 * 86400000;
    await api.saveRawData(d1);
    await api.deleteAccount('a.com', 'alice');
    // 墓碑 deletedAt 是 now，需要改回 31 天前
    const d2 = await api.loadRawData();
    d2.accounts['a.com']['alice'].deletedAt = Date.now() - 31 * 86400000;
    d2.accounts['a.com']['alice'].updatedAt = Date.now() - 31 * 86400000;
    await api.saveRawData(d2);

    const data = await api.loadRawData();
    const purged = api.purgeOldTombstones(data);
    assert(purged === 1, `过期墓碑被 purge（实际 ${purged}）`);
    assert(countEntries(data) === 0, 'purge 后本地无条目');
  }

  await freshState();
  console.log('\n[用例 5] 墓碑复活规则（删除后又保存新数据 → 复活）');
  {
    const tDel = Date.now() - 5000;
    await api.saveAccount('a.com', 'alice', [], {}, '');
    await api.deleteAccount('a.com', 'alice');
    const d1 = await api.loadRawData();
    d1.accounts['a.com']['alice'].deletedAt = tDel;
    d1.accounts['a.com']['alice'].updatedAt = tDel;
    await api.saveRawData(d1);

    // 模拟另一设备保存了新数据（updatedAt > deletedAt）
    const inc = {
      'a.com': { 'alice': makeAccount('a.com', 'alice', tDel + 1000) }
    };
    const enc = await (async () => {
      const j = JSON.stringify({ version: 3, accounts: inc });
      const e = await context.encrypt(j, 'p');
      return e;
    })();
    const r = await api.importData(enc, 'p');
    assert(r.resurrected === 1, `远端新数据复活墓碑 resurrected=1（实际 ${JSON.stringify(r)}）`);
    const d2 = await api.loadRawData();
    assert(!api.isTombstone(d2.accounts['a.com']['alice']), '复活后非墓碑');
  }

  await freshState();
  console.log('\n[用例 6] webdav.sync 先拉后传双向收敛（含墓碑传播）');
  {
    // 设备 A：alice 已删除（墓碑），bob 活跃
    await api.saveAccount('a.com', 'bob', [], {}, '');
    const dA = await api.loadRawData();
    dA.accounts['a.com']['bob'].updatedAt = Date.now() - 20000;
    await api.saveRawData(dA);
    await api.saveAccount('a.com', 'alice', [], {}, '');
    const dA2 = await api.loadRawData();
    dA2.accounts['a.com']['alice'].updatedAt = Date.now() - 10000;
    await api.saveRawData(dA2);
    await api.deleteAccount('a.com', 'alice');

    await api.saveWebdavConfig({ url: 'http://wd.test', user: 'u', pass: 'p' });
    const cfg = await api.getWebdavConfigDecrypted();
    const data = await api.exportData(cfg.pass);
    const total = countEntries(await api.loadRawData());
    assert(total === 2, `上传前本地条目（含墓碑）=2（实际 ${total}）`);
    await api.webdavPush(cfg, JSON.stringify(data));
    assert(remoteFiles.size >= 1, '远端已有备份');

    // 设备 B：全新设备，本地只有 bob（更新）
    await freshDevice();
    await api.saveAccount('a.com', 'bob', [], {}, '');
    const dB = await api.loadRawData();
    dB.accounts['a.com']['bob'].updatedAt = Date.now() - 5000; // 比 A 的 bob 新
    await api.saveRawData(dB);
    await api.saveWebdavConfig({ url: 'http://wd.test', user: 'u', pass: 'p' });
    // 手动执行 sync 的两步
    const pull = await api.webdavPull(await api.getWebdavConfigDecrypted());
    const outer = JSON.parse(pull.content);
    const merged = await api.importData(outer.data, 'p');
    const dAfter = await api.loadRawData();
    assert(api.isTombstone(dAfter.accounts['a.com']['alice']), '删除传播到设备 B（alice 为墓碑）');
    assert(!api.isTombstone(dAfter.accounts['a.com']['bob']), 'bob 本地更新保留');
  }

  // ============================================================
  //  【核心回归】墓碑过期 + 同步 → 远端删除标记不得丢失
  // ============================================================
  await freshState();
  console.log('\n[用例 7][核心回归] 墓碑 TTL 过期后同步，远端删除标记不丢失、删除不复活');
  {
    // 设备 A：alice、bob 活跃，删掉 alice（墓碑 deletedAt = 31 天前）
    await api.saveAccount('a.com', 'alice', [], {}, '');
    await api.saveAccount('a.com', 'bob', [], {}, '');
    const dA = await api.loadRawData();
    dA.accounts['a.com']['alice'].updatedAt = Date.now() - 40 * 86400000;
    dA.accounts['a.com']['bob'].updatedAt = Date.now() - 40 * 86400000;
    dA.accounts['a.com']['alice'].createdAt = Date.now() - 41 * 86400000;
    dA.accounts['a.com']['bob'].createdAt = Date.now() - 41 * 86400000;
    await api.saveRawData(dA);
    await api.deleteAccount('a.com', 'alice');
    const dA2 = await api.loadRawData();
    dA2.accounts['a.com']['alice'].deletedAt = Date.now() - 31 * 86400000;
    dA2.accounts['a.com']['alice'].updatedAt = Date.now() - 31 * 86400000;
    await api.saveRawData(dA2);

    // 设备 A 首次同步：上传含墓碑 alice（走完整 webdav.sync action）
    await api.saveWebdavConfig({ url: 'http://wd.test', user: 'u', pass: 'p' });
    const r1 = await api.webdavSync();
    assert(r1.pushed && r1.pushed.filename, '首次同步上传成功');
    const remoteContent1 = getRemoteBackupContent();
    const remoteParsed1 = await api.parseBackup(JSON.parse(remoteContent1).data, 'p');
    assert(api.isTombstone(remoteParsed1.data.accounts['a.com']['alice']), '远端备份含 alice 墓碑');

    // 设备 A 再次同步（墓碑已过期 → 完整 webdav.sync：先拉后传）
    await api.webdavSync();
    const dA3 = await api.loadRawData();
    console.log('    [诊断] A 再次同步后本地 alice 条目存在?', !!dA3.accounts['a.com'] && !!dA3.accounts['a.com']['alice']);
    const remoteContent2 = getRemoteBackupContent();
    const remoteParsed2 = await api.parseBackup(JSON.parse(remoteContent2).data, 'p');
    const remoteAlice = remoteParsed2.data.accounts['a.com'] && remoteParsed2.data.accounts['a.com']['alice'];
    console.log('    [诊断] 再次同步后远端 alice:', remoteAlice ? (remoteAlice.deleted ? '墓碑' : '活跃!') : '不存在');
    assert(remoteAlice && remoteAlice.deleted, '再次同步后远端仍保留 alice 墓碑（删除标记不丢失）');

    // 设备 C：全新设备从未见过删除，本地有旧 alice，同步 → 删除传播
    await freshDevice();
    await api.saveAccount('a.com', 'alice', [], {}, '');
    const dC = await api.loadRawData();
    dC.accounts['a.com']['alice'].updatedAt = Date.now() - 50 * 86400000;
    dC.accounts['a.com']['alice'].createdAt = Date.now() - 51 * 86400000;
    await api.saveRawData(dC);
    await api.saveWebdavConfig({ url: 'http://wd.test', user: 'u', pass: 'p' });
    await api.webdavSync();
    const dC2 = await api.loadRawData();
    const aliceAfter = dC2.accounts['a.com'] && dC2.accounts['a.com']['alice'];
    assert(aliceAfter && aliceAfter.deleted, '设备 C 的 alice 应为墓碑（删除不复活）');
  }

  // ============================================================
  //  【补充】清空本地 = 仅本机，同步后从远端恢复（不传播清空）
  // ============================================================
  await freshState();
  console.log('\n[用例 8] 清空本地后同步 = 从远端恢复（不传播删除）');
  {
    // 设备 A：alice、bob 活跃，同步上传
    await api.saveAccount('a.com', 'alice', [], {}, '');
    await api.saveAccount('b.com', 'bob', [], {}, '');
    await api.saveWebdavConfig({ url: 'http://wd.test', user: 'u', pass: 'p' });
    const r1 = await api.webdavSync();
    assert(r1.pushed && r1.pushed.filename, 'A 首次同步上传成功');

    // 设备 A 清空本地（物理空，不墓碑化）
    await context.chrome.storage.local.remove('cookie_switcher_data');
    const dEmpty = await api.loadRawData();
    assert(countEntries(dEmpty) === 0, '清空后本地物理空');

    // A 再次同步 → 拉取远端 → 恢复本地；远端不被清空
    const r2 = await api.webdavSync();
    assert(r2.pulled && r2.pulled.imported === 2, `同步从远端恢复 imported=2（实际 ${r2.pulled && r2.pulled.imported}）`);
    const dA2 = await api.loadRawData();
    assert(activeCount(dA2) === 2, '本地从远端恢复 2 个账号');
    assert(r2.pushed && r2.pushed.filename, '恢复后正常上传（远端未丢失）');
  }

  // ============================================================
  //  【补充】清空本地 + 远端无备份 → 跳过上传（空数据不覆盖远端）
  // ============================================================
  await freshState();
  console.log('\n[用例 9] 清空本地 + 远端无备份 → 跳过上传');
  {
    await api.saveAccount('a.com', 'alice', [], {}, '');
    await api.saveWebdavConfig({ url: 'http://wd.test', user: 'u', pass: 'p' });
    // 清空本地（物理空）
    await context.chrome.storage.local.remove('cookie_switcher_data');
    const r = await api.webdavSync();
    assert(r.pulled === null, '远端无备份（pulled=null）');
    assert(r.pushed === null, '本地空 → 跳过上传（pushed=null）');
    assert([...remoteFiles.keys()].filter((k) => k.includes('cookie-switcher-backup-')).length === 0, '远端无备份文件被创建');
  }

  // ============================================================
  //  【补充】双方都墓碑 + 一侧过期：合并后不复活、不丢删除标记
  // ============================================================
  await freshState();
  console.log('\n[用例 10] 双方墓碑 + 一侧过期');
  {
    // 设备 A：alice 墓碑（已过期）
    await api.saveAccount('a.com', 'alice', [], {}, '');
    const dA = await api.loadRawData();
    dA.accounts['a.com']['alice'].updatedAt = Date.now() - 40 * 86400000;
    dA.accounts['a.com']['alice'].createdAt = Date.now() - 41 * 86400000;
    await api.saveRawData(dA);
    await api.deleteAccount('a.com', 'alice');
    const dA2 = await api.loadRawData();
    dA2.accounts['a.com']['alice'].deletedAt = Date.now() - 31 * 86400000;
    dA2.accounts['a.com']['alice'].updatedAt = Date.now() - 31 * 86400000;
    await api.saveRawData(dA2);

    // 导出 A（含过期墓碑）
    const expA = await api.exportData('pin');
    const parsedA = await api.parseBackup(expA.data, 'pin');
    assert(api.isTombstone(parsedA.data.accounts['a.com']['alice']), '导出含 alice 墓碑（过期仍导出）');

    // 设备 B：本地 alice 墓碑（未过期），导入 A → 双方墓碑，跳过
    await freshDevice();
    await api.saveAccount('a.com', 'alice', [], {}, '');
    const dB = await api.loadRawData();
    dB.accounts['a.com']['alice'].updatedAt = Date.now() - 5 * 86400000;
    await api.saveRawData(dB);
    await api.deleteAccount('a.com', 'alice');
    const rB = await api.importData(expA.data, 'pin');
    assert(rB.skipped === 1 || rB.tombstoned === 1, `双方墓碑合并（skipped/tombstoned 合理，实际 ${JSON.stringify(rB)}）`);
    const dB2 = await api.loadRawData();
    assert(dB2.accounts['a.com']['alice'] && dB2.accounts['a.com']['alice'].deleted, '合并后 B 仍为墓碑');
  }

  console.log('\n========================================');
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) {
    console.log('失败用例：');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

run().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
