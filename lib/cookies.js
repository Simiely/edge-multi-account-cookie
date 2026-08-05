/**
 * lib/cookies.js - Cookie / 页面数据操作层
 *
 * 职责：
 *  - chrome.cookies 读写（partitionKey/storeId 全链路透传，P0 修复）
 *  - applyCookies：过期过滤 + 快照 + 失败回滚（P2 增强）
 *  - localStorage 读写（scripting API）
 *  - 域名工具（前导点号处理、base domain）
 *
 * 依赖：chrome.* + lib/crypto.js（解密 value）
 */

// ============================================================
//  Cookie helpers
// ============================================================

/**
 * 由 cookie 对象构造合法 URL。domain 前导点号必须去掉（MV3 坑）。
 */
function cookieUrl(cookie) {
  const domain = cookie.domain?.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
  const path = cookie.path || '/';
  return `${cookie.secure ? 'https' : 'http'}://${domain}${path}`;
}

function getCookies(domain) {
  return new Promise((resolve) => {
    chrome.cookies.getAll({ domain }, (cookies) => {
      resolve(cookies || []);
    });
  });
}

function setCookie(cookie) {
  return new Promise((resolve, reject) => {
    const details = {
      url: cookieUrl(cookie),
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      secure: !!cookie.secure,
      httpOnly: !!cookie.httpOnly,
      sameSite: cookie.sameSite || 'unspecified',
      expirationDate: cookie.expirationDate
    };
    // P0 修复：Partitioned Cookie（CHIPS）与 storeId 透传
    if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
    if (cookie.storeId) details.storeId = cookie.storeId;
    chrome.cookies.set(details, (c) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(c);
      }
    });
  });
}

function removeCookie(cookie) {
  return new Promise((resolve, reject) => {
    const details = { url: cookieUrl(cookie), name: cookie.name };
    if (cookie.storeId) details.storeId = cookie.storeId;
    if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
    chrome.cookies.remove(details, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

async function clearDomainCookies(domain) {
  const cookies = await getCookies(domain);
  let removed = 0;
  const failedCookies = [];
  for (const c of cookies) {
    try {
      await removeCookie(c);
      removed++;
    } catch (e) {
      failedCookies.push({ name: c.name, domain: c.domain, path: c.path, error: e.message });
    }
  }
  return { removed, total: cookies.length, failedCookies };
}

/**
 * 恢复快照（回滚用）。逐个 setCookie，忽略失败（尽力而为）。
 */
async function restoreCookies(snapshot) {
  for (const c of snapshot) {
    try {
      await setCookie(c);
    } catch (e) { /* best-effort */ }
  }
}

/**
 * 切换账号：应用一组 cookie。
 * 流程：解密 → 快照当前 → 清除 → 写入 → 失败则回滚。
 * 不做过期过滤（用户要求：过期由网站自行处理，程序不干预）。
 * @param {string} domain
 * @param {Array} cookies - 存储中的账号 cookie（value 为 'enc:' 密文）
 * @returns {Promise<{cleared:number, set:number, skipped:number, failed:Array, rolledBack:boolean, snapshotFailed:boolean}>}
 */
async function applyCookies(domain, cookies) {
  const mk = await getMasterKey();

  // 解密（仅解密失败视为坏数据跳过，不做过期判断）
  const valid = [];
  let skipped = 0;
  for (const c of cookies || []) {
    let value = c.value;
    if (typeof value === 'string' && value.startsWith('enc:')) {
      const dec = await decryptWithKey(value.slice(4), mk);
      if (dec === null) { skipped++; continue; } // 解密失败视为坏数据，跳过
      value = dec;
    }
    valid.push({ ...c, value });
  }

  // 快照（回滚用）——失败则标记，避免静默丢失回滚能力
  let snapshot = [];
  let snapshotFailed = false;
  try { snapshot = await getCookies(domain); } catch (e) { snapshotFailed = true; }

  // 清除
  let cleared = 0;
  for (const c of snapshot) {
    try { await removeCookie(c); cleared++; } catch (e) { /* ignore */ }
  }

  // 写入
  const failed = [];
  for (const c of valid) {
    try {
      await setCookie(c);
    } catch (e) {
      failed.push({ name: c.name, error: e.message });
    }
  }

  // 失败回滚：快照成功才回滚；快照失败时如实上报（由调用方决定是否提示）
  let rolledBack = false;
  if (failed.length > 0 && snapshot.length > 0) {
    try {
      await restoreCookies(snapshot);
      rolledBack = true;
    } catch (e) { /* ignore */ }
  }

  return { cleared, set: valid.length - failed.length, skipped, failed, rolledBack, snapshotFailed };
}

// ============================================================
//  localStorage（scripting API）
// ============================================================

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
    return {};
  }
}

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
  } catch (e) { /* non-critical */ }
}

async function clearTabLocalStorage(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => localStorage.clear()
    });
  } catch (e) { /* non-critical */ }
}

// ============================================================
//  Domain helpers
// ============================================================

function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
