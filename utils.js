/**
 * Cookie Switcher - Security & Utility Module
 * Uses Web Crypto API (AES-GCM) for local data encryption.
 * No external dependencies.
 */

// ============================================================
//  Encryption (Web Crypto API - AES-GCM)
// ============================================================

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

/**
 * Derive an AES-GCM key from a PIN using PBKDF2.
 * @param {string} pin - User's PIN
 * @param {Uint8Array} salt - Salt for PBKDF2
 * @returns {CryptoKey}
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

/**
 * Encrypt plaintext with a PIN.
 * @param {string} plaintext - Data to encrypt
 * @param {string} pin - Encryption PIN
 * @returns {Promise<string>} Base64-encoded ciphertext (salt + iv + data)
 */
async function encrypt(plaintext, pin) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(pin, salt);
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    enc.encode(plaintext)
  );
  // Pack: salt (16) + iv (12) + ciphertext
  const packed = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
  packed.set(salt, 0);
  packed.set(iv, salt.length);
  packed.set(new Uint8Array(ciphertext), salt.length + iv.length);
  return btoa(String.fromCharCode(...packed));
}

/**
 * Decrypt ciphertext with a PIN.
 * @param {string} encoded - Base64-encoded ciphertext (salt + iv + data)
 * @param {string} pin - Decryption PIN
 * @returns {Promise<string>} Decrypted plaintext
 */
async function decrypt(encoded, pin) {
  try {
    const packed = new Uint8Array(atob(encoded).split('').map(c => c.charCodeAt(0)));
    const salt = packed.slice(0, SALT_LENGTH);
    const iv = packed.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const data = packed.slice(SALT_LENGTH + IV_LENGTH);
    const key = await deriveKey(pin, salt);
    const decrypted = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv },
      key,
      data
    );
    return new TextDecoder().decode(decrypted);
  } catch (e) {
    throw new Error('解密失败：PIN 错误或数据已损坏');
  }
}

// ============================================================
//  Storage helpers
// ============================================================

const STORAGE_KEY = 'cookie_switcher_data';

/**
 * Get extension's storage data structure version.
 */
const DATA_VERSION = 2;

/**
 * Load saved accounts from storage.
 * Returns the raw data object.
 */
async function loadRawData() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || { version: DATA_VERSION, accounts: {} };
}

/**
 * Save raw data to storage.
 */
async function saveRawData(data) {
  await chrome.storage.local.set({ [STORAGE_KEY]: data });
}

/**
 * Get all saved accounts for a given domain.
 * @param {string} domain - e.g. "www.example.com"
 * @returns {Promise<object>} { accountName: { cookies, localStorage, ... } }
 */
async function getDomainAccounts(domain) {
  const data = await loadRawData();
  return data.accounts[domain] || {};
}

/**
 * Save a new account for a domain.
 * @param {string} domain
 * @param {string} name - Account name
 * @param {Array} cookies - Array of cookie objects
 * @param {object} localStorageData - { key: value }
 * @param {string} group - Optional group name
 */
async function saveAccount(domain, name, cookies, localStorageData, group, pin) {
  const data = await loadRawData();
  if (!data.accounts[domain]) {
    data.accounts[domain] = {};
  }

  const accountEntry = {
    cookies: cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite || 'unspecified',
      expirationDate: c.expirationDate || undefined
    })),
    localStorage: localStorageData || {},
    group: group || '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  data.accounts[domain][name] = accountEntry;
  await saveRawData(data);
}

/**
 * Delete an account.
 */
async function deleteAccount(domain, name) {
  const data = await loadRawData();
  if (data.accounts[domain] && data.accounts[domain][name]) {
    delete data.accounts[domain][name];
    if (Object.keys(data.accounts[domain]).length === 0) {
      delete data.accounts[domain];
    }
    await saveRawData(data);
  }
}

/**
 * Delete all accounts for a domain (used when clearing).
 */
async function deleteDomainAccounts(domain) {
  const data = await loadRawData();
  if (data.accounts[domain]) {
    delete data.accounts[domain];
    await saveRawData(data);
  }
}

// ============================================================
//  Cookie operations
// ============================================================

/**
 * Get all cookies for a given domain.
 * @param {string} domain
 * @returns {Promise<Array>}
 */
async function getCookies(domain) {
  return new Promise((resolve, reject) => {
    chrome.cookies.getAll({ domain }, (cookies) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(cookies || []);
      }
    });
  });
}

/**
 * Set a single cookie.
 * @param {object} cookie - Cookie object with name, value, domain, path, secure, etc.
 * @returns {Promise}
 */
async function setCookie(cookie) {
  return new Promise((resolve, reject) => {
    const url = `${cookie.secure ? 'https' : 'http'}://${cookie.domain}${cookie.path || '/'}`;
    chrome.cookies.set({
      url,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      secure: !!cookie.secure,
      httpOnly: !!cookie.httpOnly,
      sameSite: cookie.sameSite || 'unspecified',
      expirationDate: cookie.expirationDate
    }, (c) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(c);
      }
    });
  });
}

/**
 * Remove a single cookie.
 */
async function removeCookie(cookie) {
  return new Promise((resolve, reject) => {
    const url = `${cookie.secure ? 'https' : 'http'}://${cookie.domain}${cookie.path || '/'}`;
    chrome.cookies.remove({
      url,
      name: cookie.name,
      storeId: cookie.storeId
    }, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Clear all cookies for a domain.
 * @param {string} domain
 */
async function clearDomainCookies(domain) {
  const cookies = await getCookies(domain);
  for (const c of cookies) {
    try {
      await removeCookie(c);
    } catch (e) {
      // Skip failed removals
    }
  }
}

/**
 * Write a batch of cookies to the browser (switching accounts).
 * First clears existing cookies for the domain, then writes new ones.
 */
async function applyCookies(domain, cookies) {
  // Clear existing cookies
  await clearDomainCookies(domain);
  // Write new cookies
  for (const c of cookies) {
    try {
      await setCookie(c);
    } catch (e) {
      console.warn('Failed to set cookie:', c.name, e);
    }
  }
}

// ============================================================
//  localStorage operations (via scripting API)
// ============================================================

/**
 * Get localStorage data from the current tab's page.
 * @param {number} tabId
 * @returns {Promise<object>}
 */
async function getTabLocalStorage(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const data = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          data[key] = localStorage.getItem(key);
        }
        return data;
      }
    });
    return results[0]?.result || {};
  } catch (e) {
    // scripting may fail on some pages (chrome://, etc.)
    return {};
  }
}

/**
 * Set localStorage data on the current tab's page.
 * @param {number} tabId
 * @param {object} lsData - { key: value, ... }
 */
async function setTabLocalStorage(tabId, lsData) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (data) => {
        localStorage.clear();
        for (const [key, value] of Object.entries(data)) {
          localStorage.setItem(key, value);
        }
      },
      args: [lsData]
    });
  } catch (e) {
    // non-critical
  }
}

/**
 * Clear localStorage on the current tab's page.
 * @param {number} tabId
 */
async function clearTabLocalStorage(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => localStorage.clear()
    });
  } catch (e) {
    // non-critical
  }
}

// ============================================================
//  Domain helpers
// ============================================================

/**
 * Extract the readable domain from a URL.
 */
function extractDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return '';
  }
}

/**
 * Extract base domain (e.g. "example.com" from "www.example.com").
 * Uses a simple public suffix heuristic.
 */
function getBaseDomain(hostname) {
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  // Handle common 2-part TLDs like .com.cn, .co.jp
  const twoPartTLDs = [
    'com.cn', 'net.cn', 'org.cn', 'gov.cn',
    'co.jp', 'ne.jp', 'or.jp',
    'co.uk', 'org.uk', 'ac.uk',
    'com.au', 'net.au',
    'co.kr', 'or.kr'
  ];
  const lastTwo = parts.slice(-2).join('.');
  if (twoPartTLDs.includes(lastTwo)) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

// ============================================================
//  PIN management
// ============================================================

const PIN_STORAGE_KEY = 'cookie_switcher_pin';

/**
 * Check if a PIN is set.
 */
async function isPinSet() {
  const result = await chrome.storage.local.get(PIN_STORAGE_KEY);
  return !!result[PIN_STORAGE_KEY];
}

/**
 * Set/change the PIN. Stores a SHA-256 hash (not the plain PIN).
 */
async function setPin(pin) {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(pin));
  const hashHex = Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  await chrome.storage.local.set({ [PIN_STORAGE_KEY]: hashHex });
}

/**
 * Verify a PIN against the stored hash.
 */
async function verifyPin(pin) {
  const result = await chrome.storage.local.get(PIN_STORAGE_KEY);
  const storedHash = result[PIN_STORAGE_KEY];
  if (!storedHash) return true; // No PIN set
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(pin));
  const hashHex = Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return hashHex === storedHash;
}

// ============================================================
//  Export / Import
// ============================================================

/**
 * Export all data encrypted with a PIN.
 */
async function exportData(pin) {
  const data = await loadRawData();
  const json = JSON.stringify(data);
  return encrypt(json, pin);
}

/**
 * Import data from an encrypted blob.
 */
async function importData(encryptedBlob, pin) {
  const json = await decrypt(encryptedBlob, pin);
  const data = JSON.parse(json);
  await saveRawData(data);
  return data;
}

// ============================================================
//  Whiteslist management
// ============================================================

const WHITELIST_KEY = 'cookie_switcher_whitelist';

async function getWhitelist() {
  const result = await chrome.storage.local.get(WHITELIST_KEY);
  return result[WHITELIST_KEY] || [];
}

async function setWhitelist(domains) {
  await chrome.storage.local.set({ [WHITELIST_KEY]: domains });
}

async function isDomainAllowed(domain) {
  const whitelist = await getWhitelist();
  if (whitelist.length === 0) return true; // Empty = allow all
  return whitelist.some(d => domain === d || domain.endsWith('.' + d));
}

// ============================================================
//  Notification helper
// ============================================================

function showStatus(element, message, type = 'success', duration = 2500) {
  element.textContent = message;
  element.className = `status-bar show ${type}`;
  if (duration > 0) {
    setTimeout(() => {
      element.className = 'status-bar';
    }, duration);
  }
}
