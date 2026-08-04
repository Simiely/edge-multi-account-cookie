/**
 * lib/crypto.js - 加密层（纯 Web Crypto，零 chrome API，可被 SW / 页面共享）
 *
 * 职责：
 *  - PBKDF2 密钥派生（密码锁 / 导出加密）
 *  - AES-GCM 加解密（含分块 base64，防大数组栈溢出）
 *  - 设备主密钥（Master Key）管理：随机 256bit，可被锁派生密钥包裹
 *  - cookie value 加密/解密（使用主密钥，不依赖密码）
 *
 * 注意：本文件不得引用 chrome.* 与任何 lib 模块，保证可独立加载与单测。
 */

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const PBKDF2_ITERATIONS = 600000;   // OWASP 2023+ 建议 ≥ 60 万
const OLD_PBKDF2_ITERATIONS = 100000; // v2.2 及更早备份文件的旧迭代次数（兼容导入）
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const CHUNK_SIZE = 8192;            // 分块 base64，防 Maximum call stack size exceeded

// ============================================================
//  Base64 / bytes helpers
// ============================================================

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ============================================================
//  Key derivation (PBKDF2)
// ============================================================

/**
 * 从口令派生 AES-GCM 密钥。
 * @param {string} pin
 * @param {Uint8Array} salt
 * @returns {Promise<CryptoKey>}
 */
async function deriveKey(pin, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

// ============================================================
//  AES-GCM encrypt / decrypt（口令版本，用于导出/导入与密码锁）
// ============================================================

/**
 * 用口令加密（salt + iv 随密文打包，输出 base64）。
 */
async function encrypt(plaintext, pin) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(pin, salt);
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv }, key, enc.encode(plaintext)
  );
  const packed = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
  packed.set(salt, 0);
  packed.set(iv, salt.length);
  packed.set(new Uint8Array(ciphertext), salt.length + iv.length);
  return bytesToBase64(packed);
}

/**
 * 用口令解密（指定迭代次数）。
 * @param {string} encoded - Base64（salt+iv+data）
 * @param {string} pin - 口令
 * @param {number} iterations - PBKDF2 迭代次数
 * @returns {Promise<string>}
 */
async function decryptWithIterations(encoded, pin, iterations) {
  const packed = base64ToBytes(encoded);
  const salt = packed.slice(0, SALT_LENGTH);
  const iv = packed.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const data = packed.slice(SALT_LENGTH + IV_LENGTH);
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ['decrypt']
  );
  const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

/**
 * 用口令解密。优先新迭代次数（60 万），失败回退旧迭代次数（10 万，兼容 v2.2 及更早备份文件）。
 * 两者都失败才抛"解密失败"。
 */
async function decrypt(encoded, pin) {
  try {
    return await decryptWithIterations(encoded, pin, PBKDF2_ITERATIONS);
  } catch (e) {
    try {
      return await decryptWithIterations(encoded, pin, OLD_PBKDF2_ITERATIONS);
    } catch (e2) {
      throw new Error('解密失败：密码错误或数据已损坏');
    }
  }
}

// ============================================================
//  Master Key（主密钥）—— cookie value 本地落库加密
// ============================================================

/**
 * 生成随机主密钥，返回 base64 编码的原始 256bit 密钥。
 */
function generateMasterKey() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64(raw);
}

/**
 * 导入主密钥（base64 → CryptoKey）。
 */
async function importMasterKey(mkB64) {
  return crypto.subtle.importKey(
    'raw', base64ToBytes(mkB64), ALGORITHM, false, ['encrypt', 'decrypt']
  );
}

/**
 * 用主密钥加密任意字符串（cookie value 等）。返回 base64（iv + 密文）。
 * 失败（如密钥损坏）抛错，调用方应降级处理。
 */
async function encryptWithKey(plaintext, mkB64) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await importMasterKey(mkB64);
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, enc.encode(plaintext));
  const packed = new Uint8Array(iv.length + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64(packed);
}

/**
 * 用主密钥解密。失败返回 null（不抛错，便于调用方对坏数据降级）。
 */
async function decryptWithKey(encoded, mkB64) {
  try {
    const packed = base64ToBytes(encoded);
    const iv = packed.slice(0, IV_LENGTH);
    const data = packed.slice(IV_LENGTH);
    const key = await importMasterKey(mkB64);
    const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, data);
    return new TextDecoder().decode(decrypted);
  } catch (e) {
    return null;
  }
}

/**
 * 用口令包裹主密钥（有密码锁时，MK 落盘前先加密）。输出 base64。
 */
async function wrapMasterKey(mkB64, pin) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(pin, salt);
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv }, key, enc.encode(mkB64)
  );
  const packed = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
  packed.set(salt, 0);
  packed.set(iv, salt.length);
  packed.set(new Uint8Array(ciphertext), salt.length + iv.length);
  return bytesToBase64(packed);
}

/**
 * 用口令解包主密钥。失败返回 null。
 */
async function unwrapMasterKey(encoded, pin) {
  try {
    const packed = base64ToBytes(encoded);
    const salt = packed.slice(0, SALT_LENGTH);
    const iv = packed.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const data = packed.slice(SALT_LENGTH + IV_LENGTH);
    const key = await deriveKey(pin, salt);
    const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, data);
    return new TextDecoder().decode(decrypted);
  } catch (e) {
    return null;
  }
}
