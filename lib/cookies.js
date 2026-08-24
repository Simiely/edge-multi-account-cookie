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

/**
 * cookie 唯一键。必须包含 partitionKey——
 * CHIPS（Chrome 119+）下 partitioned 与非 partitioned cookie 可同名同域同路径并存，
 * 仅用 name|domain|path 去重会把其中一套合并丢失（保存漏存）或清除时漏删旧 partition。
 * partitionKey（{topLevelSite, hasCrossSiteAncestor}）做稳定序列化。
 */
function cookieKey(c) {
  const pk = c && c.partitionKey;
  let p = '';
  if (pk && typeof pk === 'object') p = JSON.stringify(pk);
  else if (pk) p = String(pk);
  return `${c.name}|${c.domain}|${c.path}|${p}`;
}

/**
 * 获取某域名及所有子域的 Cookie。
 * 修复：chrome.cookies.getAll({domain}) 只精确匹配该域，不返回子域（如 ums.huaban.com）。
 * 同时查：主域 / 带点号 / 父域链，合并去重（name+domain+path+partitionKey 唯一）。
 */
function getCookies(domain) {
  return new Promise(async (resolve) => {
    try {
      const queries = new Set([domain, '.' + domain]);
      // 父域链：www.huaban.com → .huaban.com（可能含更多层级）
      const parts = domain.split('.');
      for (let i = 1; i < parts.length - 1; i++) {
        const parent = parts.slice(i).join('.');
        queries.add(parent);
        queries.add('.' + parent);
      }
      const results = await Promise.all(
        [...queries].map((d) => new Promise((r) => chrome.cookies.getAll({ domain: d }, (c) => r(c || []))))
      );
      const seen = new Set();
      const merged = [];
      for (const list of results) {
        for (const c of list) {
          const key = cookieKey(c);
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(c);
        }
      }
      resolve(merged);
    } catch (e) {
      resolve([]);
    }
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
 * 流程：过滤（过期/坏数据）→ 快照当前 → 清除 → 写入 → 失败则回滚。
 * v2.11.6：恢复过期过滤（P0 回归修复，v2.5.0 曾有过、v2.6.0 移除）。
 * 原因：Chrome cookies.set 对「过期 expirationDate」视为删除操作（set 即删），
 *   切换时写回已过期 cookie 会触发 set 失败 → 计入 failed → 整批回滚（切换假失败），
 *   或立即删除刚写入的 cookie → 登录态 cookie 丢失 → "切换后无法登录"。
 *   过期 cookie 本已无法建立登录态，跳过是正确行为；expired 计数供 UI 提示重新保存。
 * @param {string} domain
 * @param {Array} cookies - 存储中的账号 cookie（value 为 'enc:' 密文）
 * @returns {Promise<{cleared:number, set:number, skipped:number, expired:number, failed:Array, rolledBack:boolean, snapshotFailed:boolean}>}
 */
async function applyCookies(domain, cookies) {
  const mk = await getMasterKey();

  // 过滤：已过期跳过 + 解密失败跳过（均不写入、不参与已知列表清除）
  const now = Date.now() / 1000;
  const valid = [];
  let skipped = 0;
  let expired = 0;
  for (const c of cookies || []) {
    if (c.expirationDate && c.expirationDate <= now) { expired++; skipped++; continue; }
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

  // 清除（v2.11.1 双保险：不依赖单一 getAll 上下文）
  // ① 按待写入的已知列表逐个 remove（remove 只需 url+name，不需要 getAll——
  //    Edge SW 中 getAll 读不到 cookie，此路径在 SW/popup 双上下文都可靠）
  // ② 快照补充移除（getAll 可靠时，把浏览器里其他同域 cookie 也一并清掉）
  let cleared = 0;
  const knownKeys = new Set(valid.map((c) => cookieKey(c)));
  for (const c of valid) {
    try { await removeCookie(c); cleared++; } catch (e) { /* ignore */ }
  }
  for (const c of snapshot) {
    if (knownKeys.has(cookieKey(c))) continue;
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

  return { cleared, set: valid.length - failed.length, skipped, expired, failed, rolledBack, snapshotFailed };
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

/**
 * 共享的账号切换核心（v2.9.x 重构）：写 cookie + localStorage + reload。
 * popup（经消息层 account.switch）与 background 右键菜单共用，消除原两处各写一遍的重复实现。
 * 主密钥守卫统一内置：未解锁则抛错，避免 applyCookies 静默跳过所有 cookie 的"假成功"。
 * @param {string} domain
 * @param {string} name
 * @param {object} account - 含 cookies / localStorage
 * @param {{tabId?:number, reload?:boolean}} [opts]
 * @returns {Promise<object>} applyCookies 结果（含 failed / snapshotFailed，供调用方判断）
 */
async function switchAccount(domain, name, account, opts = {}) {
  const { tabId = 0, reload = true } = opts;
  // 主密钥守卫（统一）：未解锁直接抛错，绝不让 applyCookies 静默跳过所有 cookie
  const mk = await getMasterKey();
  if (!mk) throw new Error('主密钥不可用：请先解锁密码锁');
  const r = await applyCookies(domain, account.cookies || []);
  if (Object.keys(account.localStorage || {}).length > 0 && tabId > 0) {
    await setTabLocalStorage(tabId, account.localStorage);
  }
  // v2.11.9：sessionStorage 替换式——有快照则整槽写入，无快照则清空当前 tab 的 session。
  // 避免上一账号留在 sessionStorage 的 token 干扰切换（sessionStorage 不随 cookie 清除、绑定单 tab）。
  if (tabId > 0) {
    const ss = account.sessionStorage || {};
    if (Object.keys(ss).length > 0) await setTabSessionStorage(tabId, ss);
    else await clearTabSessionStorage(tabId);
  }
  // reload 让登录立即生效
  if (reload && tabId > 0) await chrome.tabs.reload(tabId);
  return r;
}

// ============================================================
//  sessionStorage（scripting API，per-tab）
//  v2.11.9：browsingData 无 sessionStorage 类型且其绑定单一 tab，
//  必须经注入脚本逐 tab 读写。刷新标签页不丢 sessionStorage，须先清再 reload。
// ============================================================

async function getTabSessionStorage(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const data = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          data[key] = sessionStorage.getItem(key);
        }
        return data;
      }
    });
    return results[0]?.result || {};
  } catch (e) {
    return {};
  }
}

async function setTabSessionStorage(tabId, ssData) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (data) => {
        sessionStorage.clear();
        for (const [key, value] of Object.entries(data)) {
          sessionStorage.setItem(key, value);
        }
      },
      args: [ssData]
    });
  } catch (e) { /* non-critical */ }
}

async function clearTabSessionStorage(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => sessionStorage.clear()
    });
  } catch (e) { /* non-critical */ }
}

// ============================================================
//  深清（browsingData）——不可枚举站点存储兜底（v2.11.9）
//  IndexedDB / CacheStorage / Service Worker 无法经 JS 逐项枚举归因，
//  只能整 origin 清空。browsingData 无 sessionStorage 类型（见上）。
//  仅用于「登录新账号」等整站重置场景；切换账号不深清（会破坏刚写入的目标）。
// ============================================================

/**
 * 该域及父域链的 http/https origins 列表（browsingData.remove 的 origins 参数）。
 */
function parseOriginsForDomain(domain) {
  const origins = [];
  const seen = new Set();
  const add = (host) => {
    const norm = host || '';
    for (const proto of ['https', 'http']) {
      const o = `${proto}://${norm}/`;
      if (!seen.has(o)) { seen.add(o); origins.push(o); }
    }
  };
  const parts = String(domain || '').split('.');
  if (parts.length < 2) { add(domain); return origins; }
  // 父域链（如 www.foo.com → foo.com）与自身，覆盖授权到各层的 origin
  for (let i = 0; i < parts.length - 1; i++) add(parts.slice(i).join('.'));
  add(domain);
  return origins;
}

/**
 * 用 browsingData 彻底清空该域站点数据（含子域/父域 origin）。
 * 与 applyCookies 的「可枚举 cookie」互为兜底：深清覆盖 IndexedDB/SW/CacheStorage/缓存。
 * browsingData 权限即可，无需逐 origin host_permissions。
 * @returns {Promise<{ok:boolean, origins:Array, unsupported?:boolean, error?:string}>}
 */
async function deepClearSiteData(domain, dataToRemove) {
  const origins = parseOriginsForDomain(domain);
  if (!chrome.browsingData) {
    return { ok: false, unsupported: true, origins };
  }
  // 注意：webSQL 与 fileSystems 已在新版 Chrome/Edge 移除，作为 dataType 传入会被
  // 判定 "not supported" 抛出提醒，故不列入（FileSystem/WebSQL 本也罕用于登录态）。
  const targets = dataToRemove || {
    cookies: true,
    localStorage: true,
    indexedDB: true,
    cacheStorage: true,
    serviceWorkers: true,
    cache: true
  };
  return new Promise((resolve) => {
    chrome.browsingData.remove({ since: 0, origins }, targets, () => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message, origins });
      } else {
        resolve({ ok: true, origins });
      }
    });
  });
}

/**
 * reload 该域及子域的所有已打开标签页（深清后让它们进入干净态）。
 * tabs.query({url}) 需 tabs 权限；无 host 权限时匹配有限，尽力而为。
 * @returns {Promise<number>} 实际 reload 的标签数
 */
async function reloadTabsForDomain(domain, { exceptTabId = -1 } = {}) {
  const patterns = [`*://${domain}/*`, `*://*.${domain}/*`];
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: patterns }); } catch (e) { return 0; }
  let count = 0;
  for (const t of tabs) {
    if (t.id === exceptTabId || t.id == null) continue;
    try { await chrome.tabs.reload(t.id); count++; } catch (e) { /* ignore */ }
  }
  return count;
}

// ============================================================
//  无痕（incognito）会话（v2.11.9）
//  高敏感站点隔离：在无痕 store（独立 release cookie store）注入账号快照，
//  关闭无痕窗口即整体清零，天然不与主会话串号。
//  需 manifest "incognito":"split" + 用户在扩展详情页启用无痕（见 UI 提示）。
//  读写均走 storeId（CHIPS 红线已内置于 remove/set）。
// ============================================================

async function findIncognitoStoreId() {
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    const s = (stores || []).find((x) => x.incognito);
    return s ? s.id : null;
  } catch (e) {
    return null;
  }
}

/**
 * 在无痕会话中打开某站点并注入该账号快照（cookie 写入无痕 store）。
 * localStorage/sessionStorage 在无痕首标签内灌入。
 * 无痕未开启/扩展未启用无痕返回 false（调用方提示）。
 */
async function openAccountInIncognito(domain, account) {
  const incogStoreId = await findIncognitoStoreId();
  if (incogStoreId) {
    for (const c of (account.cookies || [])) {
      try { await setCookie({ ...c, storeId: incogStoreId }); } catch (e) { /* 尽力 */ }
    }
  }
  let win;
  try {
    win = await chrome.windows.create({ incognito: true, url: `https://${domain}` });
  } catch (e) {
    return false;
  }
  const tabId = win && win.tabs ? win.tabs[0].id : undefined;
  if (tabId != null) {
    const ls = account.localStorage || {};
    const ss = account.sessionStorage || {};
    if (Object.keys(ls).length > 0) await setTabLocalStorage(tabId, ls);
    if (Object.keys(ss).length > 0) await setTabSessionStorage(tabId, ss);
  }
  return !!incogStoreId;
}

/**
 * 在指定 cookie store 内按域 + 父域抓取 cookie（无痕 store 走此路径）。
 */
function getCookiesForStore(domain, storeId) {
  return new Promise((resolve) => {
    try {
      const queries = new Set([domain, '.' + domain]);
      const parts = String(domain || '').split('.');
      for (let i = 1; i < parts.length - 1; i++) {
        const parent = parts.slice(i).join('.');
        queries.add(parent);
        queries.add('.' + parent);
      }
      Promise.all(
        [...queries].map((d) => new Promise((r) =>
          chrome.cookies.getAll({ domain: d, storeId }, (c) => r(c || []))))
      ).then((results) => {
        const seen = new Set();
        const merged = [];
        for (const list of results) {
          for (const c of list) {
            const key = cookieKey(c);
            if (seen.has(key)) continue;
            seen.add(key);
            // 归一化 storeId 落为无痕 store 来源标记
            merged.push({ ...c, storeId });
          }
        }
        resolve(merged);
      });
    } catch (e) {
      resolve([]);
    }
  });
}

/**
 * 从无痕会话抓取该域账号（cookie + 无痕标签页 localStorage/sessionStorage）。
 * 供「保存无痕账号」从普通 popup 调用：读无痕 store 快照后写回普通 storage（持久）。
 */
async function captureIncognitoAccount(domain) {
  const incogStoreId = await findIncognitoStoreId();
  let cookies = [];
  if (incogStoreId) cookies = await getCookiesForStore(domain, incogStoreId);

  let localStorageData = {};
  let sessionStorageData = {};
  try {
    const tabs = await chrome.tabs.query({
      incognito: true,
      url: [`*://${domain}/*`, `*://*.${domain}/*`]
    });
    if (tabs && tabs[0] && tabs[0].id != null) {
      localStorageData = await getTabLocalStorage(tabs[0].id);
      sessionStorageData = await getTabSessionStorage(tabs[0].id);
    }
  } catch (e) { /* ignore */ }

  return { cookies, localStorage: localStorageData, sessionStorage: sessionStorageData };
}
