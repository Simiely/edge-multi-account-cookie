/**
 * lib/storage.js - 数据层
 *
 * 职责：
 *  - storage.local 读写 cookie_switcher_data（账号数据）
 *  - 数据版本迁移（v2 → v3：cookie value 加密落库 + partitionKey/storeId 补全）
 *  - 主密钥（Master Key）的落盘管理（有锁时被锁派生密钥包裹）
 *  - 账号 CRUD：saveAccount / deleteAccount / renameAccount / getDomainAccounts
 *
 * 依赖：chrome.storage + lib/crypto.js
 */

const STORAGE_KEY = 'cookie_switcher_data';
const DATA_VERSION = 3;

// 墓碑（tombstone）TTL：软删除标记保留 30 天，之后物理清理（v2.10.0）
// 语义：删除需跨设备传播（备份/同步携带墓碑），但墓碑不能永久累积；
// 远端固定保留最新 1 份备份，30 天远大于同步周期，足够安全。
const TOMBSTONE_TTL = 30 * 24 * 60 * 60 * 1000;

// 判断账号是否为墓碑（已软删除）
function isTombstone(entry) {
  return !!(entry && entry.deleted);
}

/**
 * 清理超过 TTL 的过期墓碑（v2.10.0）。就地修改 data 并返回清理数。
 * 在保存/同步后调用：墓碑存活足够久（传播删除）后被物理移除。
 */
function purgeOldTombstones(data) {
  const cutoff = Date.now() - TOMBSTONE_TTL;
  let purged = 0;
  if (!data || !data.accounts) return 0;
  for (const domain of Object.keys(data.accounts)) {
    const names = Object.keys(data.accounts[domain]);
    for (const name of names) {
      const e = data.accounts[domain][name];
      if (e && e.deleted && e.deletedAt && e.deletedAt < cutoff) {
        delete data.accounts[domain][name];
        purged++;
      }
    }
    if (Object.keys(data.accounts[domain]).length === 0) delete data.accounts[domain];
  }
  return purged;
}

// 主密钥键
const MK_KEY = 'cookie_switcher_mk';          // 落盘值：无锁=明文 base64；有锁=锁包裹密文
const MK_WRAPPED_FLAG = 'cookie_switcher_mk_wrapped'; // true = MK 被锁包裹
const MK_SESSION_KEY = 'cookie_switcher_mk_session';  // storage.session：会话内明文缓存

// ============================================================
//  Raw data 读写 + 迁移
// ============================================================

async function loadRawData() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const data = result[STORAGE_KEY] || { version: DATA_VERSION, accounts: {} };
  return migrate(data);
}

async function saveRawData(data) {
  await chrome.storage.local.set({ [STORAGE_KEY]: data });
}

/**
 * 版本迁移管线（惰性：每次读取时检测）。
 * v2 → v3：
 *   - 补全 partitionKey / storeId 字段（无则 undefined）
 *   - 不再加密 cookie value（明文方案：避免 AES 膨胀超 4096 上限；与浏览器自身 Cookies 数据库明文一致）
 * 迁移失败不抛错：返回原数据 + 标记 migrationPending，下次重试。
 */
async function migrate(data) {
  if (!data || data.version === DATA_VERSION) return data;

  if (data.version < 3) {
    try {
      const accounts = data.accounts || {};
      // 逐条补全字段（map 内不能 await，故用 for 循环）
      for (const domain of Object.keys(accounts)) {
        for (const name of Object.keys(accounts[domain])) {
          const entry = accounts[domain][name];
          if (!entry || !Array.isArray(entry.cookies)) continue;
          entry.cookies = entry.cookies.map((c) => ({
            ...c,
            partitionKey: c.partitionKey || undefined,
            storeId: c.storeId || undefined
          }));
        }
      }
      data.version = 3;
      await saveRawData(data);
      return data;
    } catch (e) {
      // 迁移失败：降级返回原数据并标记待迁移
      console.warn('migrate failed:', e);
      data.migrationPending = true;
      return data;
    }
  }

  data.version = DATA_VERSION;
  return data;
}

// ============================================================
//  Master Key 管理
// ============================================================

/**
 * 一次性迁移：把所有 enc: 加密的 cookie value 解密为明文存储（旧版明文方案）。
 * 幂等：无 enc: 数据时直接返回；MK 不可用（锁未解锁）时返回 MK_UNAVAILABLE，调用方稍后重试。
 * @returns {Promise<{converted:number, failed:number, error?:string}>}
 */
async function migratePlainValues() {
  const data = await loadRawData();
  let converted = 0;
  let failed = 0;
  const mk = await getMasterKey();
  if (!mk) return { converted: 0, failed: 0, error: 'MK_UNAVAILABLE' };

  for (const domain of Object.keys(data.accounts || {})) {
    for (const name of Object.keys(data.accounts[domain] || {})) {
      const entry = data.accounts[domain][name];
      if (!entry || !Array.isArray(entry.cookies)) continue;
      for (const c of entry.cookies) {
        if (typeof c.value === 'string' && c.value.startsWith('enc:')) {
          const dec = await decryptWithKey(c.value.slice(4), mk);
          if (dec !== null) { c.value = dec; converted++; }
          else { failed++; }
        }
      }
    }
  }

  if (converted > 0 || failed > 0) await saveRawData(data);
  return { converted, failed };
}

/**
 * 获取主密钥（优先会话缓存）。
 *  - 无 MK：生成并明文落盘 + 写会话缓存
 *  - 无锁（明文落盘）：返回明文并写会话缓存
 *  - 有锁且本会话已解锁：返回会话缓存明文
 *  - 有锁且本会话未解锁：返回 null（调用方需提示用户先解锁）
 * @returns {Promise<string|null>} base64 主密钥
 */
async function getMasterKey() {
  // 1) 会话缓存优先（解锁后 / 明文场景）
  const session = await chrome.storage.session.get(MK_SESSION_KEY);
  if (session[MK_SESSION_KEY]) return session[MK_SESSION_KEY];

  // 2) 落盘读取
  const result = await chrome.storage.local.get([MK_KEY, MK_WRAPPED_FLAG]);
  const mk = result[MK_KEY];
  if (!mk) {
    const fresh = generateMasterKey();
    await chrome.storage.local.set({ [MK_KEY]: fresh, [MK_WRAPPED_FLAG]: false });
    try {
      await chrome.storage.session.set({ [MK_SESSION_KEY]: fresh });
    } catch (e) { /* session 不可用（罕见）则跳过 */ }
    return fresh;
  }

  // 3) 未包裹：明文，直接写会话缓存
  if (!result[MK_WRAPPED_FLAG]) {
    try {
      await chrome.storage.session.set({ [MK_SESSION_KEY]: mk });
    } catch (e) { /* ignore */ }
    return mk;
  }

  // 4) 已包裹但会话未解锁：需用户先输入密码锁
  return null;
}

/**
 * 解锁主密钥（密码锁验证通过后调用）。
 * @param {string} pin
 * @returns {Promise<string|null>} 明文 MK；失败返回 null
 */
async function unlockMasterKey(pin) {
  const result = await chrome.storage.local.get(MK_KEY);
  const wrapped = result[MK_KEY];
  if (!wrapped) return getMasterKey();
  const mk = await unwrapMasterKey(wrapped, pin);
  if (mk) {
    try {
      await chrome.storage.session.set({ [MK_SESSION_KEY]: mk });
    } catch (e) { /* ignore */ }
  }
  return mk;
}

/**
 * 由 security 层调用：
 *  - 上锁：mkB64 = 锁包裹密文，wrapped=true（同时写会话明文）
 *  - 关锁：mkB64 = 明文，wrapped=false（同时写会话明文）
 */
async function setMasterKey(mkB64, opts = {}) {
  const { wrapped = false } = opts;
  await chrome.storage.local.set({ [MK_KEY]: mkB64, [MK_WRAPPED_FLAG]: wrapped });
  // 无论包裹与否，会话内缓存明文 MK（包裹场景由调用方传入解密后的明文）
  const plain = opts.plainMK || mkB64;
  try {
    await chrome.storage.session.set({ [MK_SESSION_KEY]: plain });
  } catch (e) { /* ignore */ }
}

async function isMasterKeyWrapped() {
  const result = await chrome.storage.local.get(MK_WRAPPED_FLAG);
  return !!result[MK_WRAPPED_FLAG];
}

/**
 * 清除会话缓存（弹窗锁定 / 关闭时可选调用）。
 */
async function clearMasterKeySession() {
  try {
    await chrome.storage.session.remove(MK_SESSION_KEY);
  } catch (e) { /* ignore */ }
}

// ============================================================
//  Account CRUD
// ============================================================

async function getDomainAccounts(domain) {
  const data = await loadRawData();
  const accounts = data.accounts[domain] || {};
  // v2.10.0：过滤墓碑（已删除账号不显示、不统计）
  const result = {};
  for (const name of Object.keys(accounts)) {
    if (!isTombstone(accounts[name])) result[name] = accounts[name];
  }
  return result;
}

/**
 * 保存账号。cookies 需调用方已加密（value: 'enc:' + base64）。
 * @param {string} domain
 * @param {string} name
 * @param {Array} cookies - 已加密的 cookie 数组
 * @param {object} localStorageData
 * @param {string} group
 */
async function saveAccount(domain, name, cookies, localStorageData, group) {
  const data = await loadRawData();
  if (!data.accounts[domain]) data.accounts[domain] = {};

  const now = Date.now();
  const existing = data.accounts[domain][name];
  data.accounts[domain][name] = {
    cookies: (cookies || []).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite || 'unspecified',
      expirationDate: c.expirationDate || undefined,
      partitionKey: c.partitionKey || undefined,
      storeId: c.storeId || undefined
    })),
    localStorage: localStorageData || {},
    group: group || (existing && existing.group) || '',
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    // 健康状态（v2.7.0）：保存视为"未知"，切换/体检后更新
    health: 'unknown',
    lastVerifiedAt: 0
  };
  await saveRawData(data);
  return data.accounts[domain][name];
}

/**
 * 更新账号健康状态（切换探测 / 每日体检调用）。
 * @param {string} domain
 * @param {string} name
 * @param {'ok'|'expired'|'unknown'} health
 */
async function updateAccountHealth(domain, name, health) {
  const data = await loadRawData();
  if (!data.accounts[domain] || !data.accounts[domain][name]) return false;
  data.accounts[domain][name].health = health;
  data.accounts[domain][name].lastVerifiedAt = Date.now();
  await saveRawData(data);
  return true;
}

async function deleteAccount(domain, name) {
  const data = await loadRawData();
  const entry = data.accounts[domain] && data.accounts[domain][name];
  if (!entry) return;
  // v2.10.0 软删除（墓碑）：保留骨架 + 删除时间戳，清空 cookies/localStorage。
  // 墓碑随导出/同步传播——其他设备读到后同样隐藏，解决"已删除账号被旧备份同步复活"。
  // 30 天后由 purgeOldTombstones 物理清理（TTL）。
  const now = Date.now();
  data.accounts[domain][name] = {
    name: entry.name || name,
    createdAt: entry.createdAt || now,
    updatedAt: now,
    deleted: true,
    deletedAt: now
  };
  await saveRawData(data);
}

/**
 * 重命名账号。旧名不存在返回 false；新名冲突返回 false。
 */
async function renameAccount(domain, oldName, newName) {
  const data = await loadRawData();
  if (!data.accounts[domain] || !data.accounts[domain][oldName]) return false;
  if (data.accounts[domain][newName]) return false;
  data.accounts[domain][newName] = data.accounts[domain][oldName];
  data.accounts[domain][newName].updatedAt = Date.now();
  delete data.accounts[domain][oldName];
  await saveRawData(data);
  return true;
}
