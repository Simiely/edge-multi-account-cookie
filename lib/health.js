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
//  会话混存检测（只读，不修改数据）
// ============================================================

/**
 * 检测同名不同 domain 的 cookie（域 cookie 与 host-only cookie 并存）。
 * ⚠️ v2.7.2 修正：这是浏览器合法状态（Keycloak 常同时设置 .domain 与 domain 两套），
 * 保存/切换**不得**按 name 去重删除——v2.7.0 曾因此删掉 host-only cookie 导致登录失败。
 * 本函数仅用于诊断提示，绝不返回"去重后的数据"。
 * @param {Array} cookies - 账号已保存的 cookie 数组
 * @returns {{warnings:Array<string>}}
 */
function detectDuplicateNames(cookies) {
  const byName = new Map();
  for (const c of cookies || []) {
    if (!byName.has(c.name)) byName.set(c.name, []);
    byName.get(c.name).push(c);
  }
  const warnings = [];
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    const domains = list.map((x) => x.domain || '').join(' / ');
    warnings.push(`「${name}」存在 ${list.length} 个条目（${domains}）—— 域 cookie 与 host-only cookie 并存属正常，请勿手动删除`);
  }
  return { warnings };
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
 *  - 其他/异常 → unknown（无 realm / 无 token / 权限不足 / 网络问题，不误报）
 *
 * 认证方式：Keycloak userinfo 标准认证为 Authorization: Bearer <access_token>，
 * 而 access token 即保存的 KEYCLOAK_IDENTITY 值——优先用 Bearer 方式（可靠）。
 * 兜底：无 KEYCLOAK_IDENTITY 时退回 cookie 方式（部分站点 cookie 可认证）。
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
    // 优先 Bearer token（Keycloak 标准）：token = KEYCLOAK_IDENTITY 值
    let token = null;
    for (const c of cookies || []) {
      if (c.name === 'KEYCLOAK_IDENTITY' && c.value) { token = String(c.value); break; }
    }

    const resp = token
      ? await fetch(url, {
          headers: { 'Authorization': 'Bearer ' + token },
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'follow'
        })
      : await fetch(url, { credentials: 'include', cache: 'no-store', redirect: 'follow' });

    if (resp.status === 200) return { status: 'ok', checkedAt };
    if (resp.status === 401 || resp.status === 403) {
      return { status: 'expired', reason: token ? 'bearer-http-' + resp.status : 'cookie-http-' + resp.status, checkedAt };
    }
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
