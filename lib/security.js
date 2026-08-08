/**
 * lib/security.js - 安全策略层
 *
 * 职责：
 *  - 密码锁：PBKDF2 盐值哈希验证（兼容旧 SHA-256 hex 格式并自动迁移）
 *  - 防暴力破解：连续失败锁定 + 指数冷却
 *  - 主密钥联动：设置/更换/关闭密码锁时包裹/恢复主密钥
 *
 * 依赖：chrome.storage + lib/crypto.js + lib/storage.js
 */

const PIN_KEY = 'cookie_switcher_pin';      // { format:'pbkdf2', salt, hash } | 旧格式: hex 字符串
const LOCK_KEY = 'cookie_switcher_lock';    // { failCount, lockedUntil }

const MAX_FAILS = 5;                        // 连续失败阈值
const BASE_LOCK_MS = 60 * 1000;             // 首次锁定 60s

// ============================================================
//  密码锁
// ============================================================

async function isPinSet() {
  const result = await chrome.storage.local.get(PIN_KEY);
  return !!result[PIN_KEY];
}

/**
 * 设置/更换/关闭密码锁。
 * @param {string} pin - 新密码；空字符串 = 关闭
 * @param {string} [oldPin] - 锁已存在时用于解锁主密钥的旧密码
 */
async function setPin(pin, oldPin) {
  // 获取明文主密钥（本会话已解锁直接用；否则尝试用旧密码解锁）
  let mk = await getMasterKey();
  if (!mk && oldPin) mk = await unlockMasterKey(oldPin);
  if (!mk) throw new Error('无法获取主密钥，请先解锁');

  if (!pin) {
    // 关闭密码锁：MK 明文落盘
    await setMasterKey(mk, { wrapped: false, plainMK: mk });
    await chrome.storage.local.remove(PIN_KEY);
    await resetPinFailures();
    return;
  }

  // 设置/更换：生成盐 + PBKDF2 哈希（deriveBits 派生 256bit 字节，避免密钥不可导出的问题）
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  const hashHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
  await chrome.storage.local.set({
    [PIN_KEY]: { format: 'pbkdf2', salt: bytesToBase64(salt), hash: hashHex }
  });
  // 用新密码包裹 MK 落盘（数据从此受锁保护），会话内仍缓存明文
  const wrapped = await wrapMasterKey(mk, pin);
  await setMasterKey(wrapped, { wrapped: true, plainMK: mk });
  await resetPinFailures();
}

/**
 * 校验密码。兼容旧 SHA-256 hex 格式；验证通过后异步迁移为新格式。
 * @returns {Promise<boolean>}
 */
async function verifyPin(pin) {
  const result = await chrome.storage.local.get(PIN_KEY);
  const stored = result[PIN_KEY];
  if (!stored) return true; // 无密码锁
  const enc = new TextEncoder();

  if (typeof stored === 'string') {
    // 旧格式：SHA-256 hex
    const hash = await crypto.subtle.digest('SHA-256', enc.encode(pin));
    const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
    const ok = hashHex === stored;
    if (ok) {
      // 迁移到 PBKDF2 新格式（旧格式下 MK 未包裹，直接落新格式）；失败不阻塞验证结果
      try { await setPin(pin, pin); } catch (e) { /* ignore */ }
    }
    return ok;
  }

  // 新格式：PBKDF2
  try {
    if (!stored || stored.format !== 'pbkdf2') return false;
    const salt = base64ToBytes(stored.salt);
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      keyMaterial,
      256
    );
    const hashHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex === stored.hash;
  } catch (e) {
    return false; // 盐值/哈希损坏 → 视为密码错误
  }
}

// ============================================================
//  防暴力破解
// ============================================================

async function getLockState() {
  const result = await chrome.storage.local.get(LOCK_KEY);
  return result[LOCK_KEY] || { failCount: 0, lockedUntil: 0 };
}

/**
 * 检查当前是否锁定。返回 { locked, retryAfterSeconds }。
 */
async function checkPinLock() {
  const lock = await getLockState();
  const now = Date.now();
  if (lock.lockedUntil && lock.lockedUntil > now) {
    return { locked: true, retryAfterSeconds: Math.ceil((lock.lockedUntil - now) / 1000) };
  }
  return { locked: false, retryAfterSeconds: 0 };
}

async function recordPinFailure() {
  const lock = await getLockState();
  const failCount = lock.failCount + 1;
  // 指数冷却：每超过一个 MAX_FAILS 阈值，锁定时间翻倍
  const thresholdTier = Math.floor((failCount - 1) / MAX_FAILS);
  const lockMs = BASE_LOCK_MS * Math.pow(2, thresholdTier);
  // 仅当达到阈值才真正锁定；阈值内的失败只累计次数，不锁（避免一次手误被锁 60s）
  const lockedUntil = failCount >= MAX_FAILS ? Date.now() + lockMs : 0;
  await chrome.storage.local.set({
    [LOCK_KEY]: { failCount, lockedUntil }
  });
  return { failCount, lockedUntil };
}

async function resetPinFailures() {
  await chrome.storage.local.set({ [LOCK_KEY]: { failCount: 0, lockedUntil: 0 } });
}

/**
 * 带锁校验密码（统一入口）。
 * @returns {Promise<{ok:boolean, locked:boolean, retryAfterSeconds:number}>}
 */
async function verifyPinWithLock(pin) {
  const lockCheck = await checkPinLock();
  if (lockCheck.locked) {
    return { ok: false, locked: true, retryAfterSeconds: lockCheck.retryAfterSeconds };
  }
  const ok = await verifyPin(pin);
  if (ok) {
    await resetPinFailures();
    return { ok: true, locked: false, retryAfterSeconds: 0 };
  }
  const fail = await recordPinFailure();
  const retryAfter = fail.lockedUntil > Date.now() ? Math.ceil((fail.lockedUntil - Date.now()) / 1000) : 0;
  return { ok: false, locked: retryAfter > 0, retryAfterSeconds: retryAfter };
}

// ============================================================
//  PIN 会话缓存（用于备份自动加解密；仅 storage.session，不落盘）
// ============================================================

const PIN_SESSION_KEY = 'cookie_switcher_pin_session';

/**
 * 缓存明文 PIN 到会话（解锁成功后调用）。仅会话内有效，浏览器关闭即清空。
 */
async function cachePinInSession(pin) {
  try {
    await chrome.storage.session.set({ [PIN_SESSION_KEY]: String(pin) });
  } catch (e) { /* session 不可用则跳过（无缓存时导出回退为手动输入） */ }
}

/**
 * 读取会话缓存的明文 PIN（用于备份自动加解密）。
 * @returns {Promise<string|null>} 未解锁/无缓存返回 null
 */
async function getCachedPin() {
  try {
    const r = await chrome.storage.session.get(PIN_SESSION_KEY);
    return r[PIN_SESSION_KEY] || null;
  } catch (e) {
    return null;
  }
}

/**
 * 清除会话 PIN 缓存（关闭密码锁时调用）。
 */
async function clearPinSessionCache() {
  try {
    await chrome.storage.session.remove(PIN_SESSION_KEY);
  } catch (e) { /* ignore */ }
}
