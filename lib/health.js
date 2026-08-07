/**
 * lib/health.js - 会话健康层（纯函数 + fetch，popup / SW 双端可用）
 *
 * 职责：
 *  - 会话存活探测：Keycloak realm 提取 + userinfo 接口探测（Bearer 认证）
 *
 * 历史说明（勿重蹈覆辙）：
 *  - v2.7.0 曾含"保存前去重"逻辑，按 name 去重误删 host-only cookie 导致登录失败（v2.7.2 P0 修复）。
 *    cookie 去重必须按 name+domain+path 粒度；域 cookie 与 host-only cookie 同名并存是浏览器合法状态。
 *  - v2.8.0 移除无调用的 JWT 解析工具（sessionTokenInfo/jwtPayload/base64UrlDecode）与
 *    只读诊断 detectDuplicateNames——均为死代码。
 *
 * 注意：本文件不引用 chrome.*（fetch 双端均有），
 *       可被 popup.html 与 background.js（importScripts）同时加载。
 */

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
 * 注意（坑 29）：MV3 SW 的 fetch 默认不带 SameSite cookie，且扩展上下文跨域 fetch
 * 需 host_permissions，否则 CORS 拦截——探测失败必须返回 unknown 而非 expired（不误报）。
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
