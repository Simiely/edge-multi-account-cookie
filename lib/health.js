/**
 * lib/health.js - 会话健康层（纯函数 + fetch，popup / SW 双端可用）
 *
 * 职责：
 *  - 保存前去重：同名 cookie 多条时保留域 cookie（domain 带前导点），
 *    并识别"多套会话混存"给出警告（P0-① 的根因修复）
 *  - 会话存活探测：Keycloak realm 提取 + userinfo 接口探测（P0-②）
 *  - JWT 解析工具：KEYCLOAK_IDENTITY 取 sub / exp（供 UI 展示过期时间）
 *
 * 注意：本文件不引用 chrome.*（fetch 双端均有），
 *       可被 popup.html 与 background.js（importScripts）同时加载。
 */

// ============================================================
//  Cookie 去重 / 会话混存检测
// ============================================================

/**
 * 保存前清洗 cookie 数组：
 *  - 同名 cookie 多条时，保留"域 cookie"（domain 带前导点，子域共享、通常更完整）
 *  - value 相同的冗余条目静默丢弃；value 不同则警告（疑似多套会话混存）
 * @param {Array} cookies - 原始抓取结果
 * @returns {{deduped:Array, removed:Array, warnings:Array<string>}}
 */
function dedupeCookies(cookies) {
  const byName = new Map();
  for (const c of cookies || []) {
    if (!byName.has(c.name)) byName.set(c.name, []);
    byName.get(c.name).push(c);
  }

  const deduped = [];
  const removed = [];
  const warnings = [];

  for (const [name, list] of byName) {
    if (list.length === 1) { deduped.push(list[0]); continue; }

    // 优先 domain 带前导点的（域 cookie）；无则保留第一条
    const dotted = list.filter((c) => String(c.domain || '').startsWith('.'));
    const keep = dotted.length > 0 ? dotted[0] : list[0];

    for (const c of list) {
      if (c === keep) continue;
      if (c.value !== keep.value) {
        warnings.push(
          `「${name}」存在 ${list.length} 个不同值（${list.map((x) => x.domain || '').join(', ')}），` +
          `已保留 ${keep.domain} —— 疑似多套会话混存，建议切换后确认登录状态`
        );
      }
      removed.push(c);
    }
    deduped.push(keep);
  }

  return { deduped, removed, warnings };
}

// ============================================================
//  会话存活探测（Keycloak userinfo）
// ============================================================

/**
 * 从 cookie 中提取 Keycloak realm 名。
 * 优先解析 cookie path（/auth/realms/{realm}/），兜底解析 KEYCLOAK_SESSION 值（realm/tenant/sid）。
 */
function extractRealm(cookies) {
  for (const c of cookies || []) {
    const m = String(c.path || '').match(/\/auth\/realms\/([^/]+)\//);
    if (m) return m[1];
  }
  for (const c of cookies || []) {
    if (c.name === 'KEYCLOAK_SESSION') {
      const parts = String(c.value).replace(/"/g, '').split('/');
      if (parts.length >= 3 && parts[0]) return parts[0];
    }
  }
  return null;
}

/**
 * 探测会话是否存活：请求 Keycloak userinfo 端点。
 *  - 200 → ok（会话有效）
 *  - 401/403 → expired（会话已失效，服务端不认）
 *  - 其他/异常 → unknown（无 realm / 权限不足 / 网络问题，不误报）
 *
 * @param {string} domain - 站点域名（如 www.codebuddy.cn）
 * @param {Array} cookies - 该账号已保存的 cookie 数组
 * @returns {Promise<{status:'ok'|'expired'|'unknown', reason?:string, checkedAt:number}>}
 */
async function probeSession(domain, cookies) {
  const checkedAt = Date.now();
  try {
    const realm = extractRealm(cookies);
    if (!realm) return { status: 'unknown', reason: 'no-realm', checkedAt };

    const url = `https://${domain}/auth/realms/${realm}/protocol/openid-connect/userinfo`;
    const resp = await fetch(url, { credentials: 'include', cache: 'no-store', redirect: 'follow' });
    if (resp.status === 200) return { status: 'ok', checkedAt };
    if (resp.status === 401 || resp.status === 403) return { status: 'expired', reason: `http-${resp.status}`, checkedAt };
    return { status: 'unknown', reason: `http-${resp.status}`, checkedAt };
  } catch (e) {
    // 无 host 权限 / CORS / 网络失败：无法判断，返回 unknown（不误报为失效）
    return { status: 'unknown', reason: (e && e.message) || 'network', checkedAt };
  }
}

// ============================================================
//  JWT 解析（仅解码，不验签）
// ============================================================

function base64UrlDecode(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  try {
    return decodeURIComponent(
      atob(padded).split('').map((ch) => '%' + ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    );
  } catch {
    try { return atob(padded); } catch { return null; }
  }
}

/**
 * 解析 JWT payload（不验签）。失败返回 null。
 */
function jwtPayload(jwt) {
  try {
    const parts = String(jwt || '').split('.');
    if (parts.length < 2) return null;
    const json = base64UrlDecode(parts[1]);
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
}

/**
 * 账号健康度展示信息：从 cookies 里找 KEYCLOAK_IDENTITY，返回签发/过期时间。
 * @returns {{iat?:number, exp?:number, sub?:string}|null}
 */
function sessionTokenInfo(cookies) {
  for (const c of cookies || []) {
    if (c.name === 'KEYCLOAK_IDENTITY') {
      const p = jwtPayload(c.value);
      if (p && p.exp) return { iat: p.iat, exp: p.exp, sub: p.sub };
    }
  }
  return null;
}
