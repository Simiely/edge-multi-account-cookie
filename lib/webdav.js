/**
 * lib/webdav.js - WebDAV 协议客户端（Phase 3.5）
 *
 * 职责：
 *  - WebDAV 配置持久化（密码用主密钥加密）
 *  - 协议方法：PROPFIND / GET / PUT / DELETE（+ Basic Auth）
 *  - 备份编排：连接测试 / 上传（含保留策略）/ 下载恢复
 *
 * 依赖：chrome.storage + lib/crypto.js + lib/storage.js（getMasterKey 加密密码）
 * 注意：必须由 Service Worker 执行（host_permissions 绕过 CORS）。
 */

const WEBDAV_KEY = 'cookie_switcher_webdav';
const BACKUP_FILE_PREFIX = 'cookie-switcher-backup-';
const BACKUP_FILE_EXT = '.json';
const DEFAULT_KEEP = 1;
// 默认 WebDAV 服务器（URL 留空时自动使用；方便本机/内网快速配置）
const DEFAULT_WEBDAV_URL = 'http://192.168.2.1:6086';
// 备份目录（固定）：workbuddy/网页账号管理/（URL 编码）
const BACKUP_DIR = 'workbuddy/%E7%BD%91%E9%A1%B5%E8%B4%A6%E5%8F%B7%E7%AE%A1%E7%90%86';

// ============================================================
//  配置持久化
// ============================================================

/**
 * 读取配置。密码字段 passEnc（主密钥加密）。
 */
async function getWebdavConfig() {
  const result = await chrome.storage.local.get(WEBDAV_KEY);
  return result[WEBDAV_KEY] || null;
}

async function setWebdavConfig(config) {
  await chrome.storage.local.set({ [WEBDAV_KEY]: config });
}

async function clearWebdavConfig() {
  await chrome.storage.local.remove(WEBDAV_KEY);
}

/**
 * 保存配置（密码用主密钥加密存储，杜绝明文）。
 * v2.9.0：保留份数/自动备份计划已移除——远端固定保留最新 1 份（webdavPush 用 DEFAULT_KEEP），
 * 不再写入 keep/schedule 字段（旧配置残留字段无害，不再读取）。
 */
async function saveWebdavConfig({ url, user, pass }) {
  const mk = await getMasterKey();
  if (!mk) throw new Error('无法获取主密钥，请先解锁密码锁');
  const passEnc = await encryptWithKey(String(pass || ''), mk);
  const existing = await getWebdavConfig();
  // 密码留空 = 保持不变
  const finalPassEnc = String(pass || '') ? passEnc : (existing && existing.passEnc);
  if (!finalPassEnc) throw new Error('请输入 WebDAV 密码');
  await setWebdavConfig({
    // URL 留空 → 默认服务器；无协议 → 自动补 http://
    url: normalizeWebdavUrl(url).replace(/\/+$/, ''),
    user: String(user || ''),
    passEnc: finalPassEnc,
    lastBackupAt: (existing && existing.lastBackupAt) || 0
  });
}

/**
 * 读取解密后的配置（仅 SW 内存中使用，不落盘明文）。
 */
async function getWebdavConfigDecrypted() {
  const cfg = await getWebdavConfig();
  if (!cfg) return null;
  const mk = await getMasterKey();
  if (!mk) return null;
  const pass = await decryptWithKey(cfg.passEnc, mk);
  if (pass === null) return null;
  return { ...cfg, pass };
}

// ============================================================
//  协议层
// ============================================================

function basicAuthHeader(user, pass) {
  return 'Basic ' + btoa(unescape(encodeURIComponent(`${user}:${pass}`)));
}

async function webdavRequest(method, url, user, pass, body, headers = {}) {
  return fetch(url, {
    method,
    headers: { 'Authorization': basicAuthHeader(user, pass), ...headers },
    body: body || undefined
  });
}

/**
 * 计算备份目录：{base}/workbuddy/网页账号管理/（固定目录，不含用户名）
 */
function backupDir(config) {
  const { url } = config;
  const base = String(url || '').replace(/\/+$/, '');
  return `${base}/${BACKUP_DIR}`;
}

/**
 * 确保备份目录存在。逐级创建（MKCOL 只能建一层；workbuddy/网页账号管理 两级都要保证）。
 * PROPFIND 探测 → 404 则 MKCOL；405=已存在视同成功。
 */
async function ensureBackupDir(config) {
  const dir = backupDir(config);
  // 逐级：base → base/workbuddy → base/workbuddy/网页账号管理
  const base = String(config.url || '').replace(/\/+$/, '');
  const levels = [base + '/workbuddy', dir];
  for (const level of levels) {
    const probe = await webdavRequest('PROPFIND', level, config.user, config.pass, undefined, { 'Depth': '0' });
    if (probe.status === 401 || probe.status === 403) throw new Error('认证失败，请检查用户名/密码');
    if (probe.status !== 404) continue; // 已存在（207/200/405 等）
    const mk = await webdavRequest('MKCOL', level, config.user, config.pass);
    if (mk.status !== 201 && mk.status !== 405) throw new Error(`创建备份目录失败：HTTP ${mk.status}`);
  }
  return dir;
}

/**
 * PROPFIND 列目录（Depth:1），返回文件/子目录名数组。
 */
async function webdavList(config) {
  const { user, pass } = config;
  const dir = backupDir(config);
  const resp = await webdavRequest('PROPFIND', dir, user, pass, undefined, {
    'Depth': '1',
    'Content-Type': 'application/xml'
  });
  if (resp.status === 401 || resp.status === 403) throw new Error('认证失败，请检查用户名/密码');
  if (resp.status === 404) return [];
  if (resp.status !== 207) throw new Error(`PROPFIND 失败：HTTP ${resp.status}`);
  const text = await resp.text();
  const names = [];
  const re = /<[a-zA-Z0-9_-]*:?href[^>]*>([^<]+)<\/[a-zA-Z0-9_-]*:?href>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const href = decodeURIComponent(m[1]).replace(/^https?:\/\/[^/]+/i, '');
    const name = href.split('/').filter(Boolean).pop();
    if (name) names.push(name);
  }
  return names;
}

/**
 * 连接测试：PROPFIND 备份目录（不存在视为可创建，返回成功）。
 */
async function webdavTest(config) {
  const list = await webdavList(config);
  return { ok: true, count: list.length };
}

/**
 * 上传备份。远端保留最近 keep 份（在 workbuddy/<用户名>/ 目录内）。
 * @param {object} config - 含 pass（明文，仅内存）
 * @param {string} content - 备份 JSON 字符串
 * @returns {Promise<string>} 远端文件名
 */
async function webdavPush(config, content) {
  const { user, pass, keep = DEFAULT_KEEP } = config;
  const dir = await ensureBackupDir(config);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const filename = `${BACKUP_FILE_PREFIX}${stamp}${BACKUP_FILE_EXT}`;
  const fileUrl = `${dir}/${filename}`;
  const resp = await webdavRequest('PUT', fileUrl, user, pass, content, {
    'Content-Type': 'application/json'
  });
  if (resp.status === 401 || resp.status === 403) throw new Error('认证失败，请检查用户名/密码');
  if (![200, 201, 204].includes(resp.status)) throw new Error(`上传失败：HTTP ${resp.status}`);

  // 保留策略：仅保留最近 keep 份备份文件
  try {
    const files = await webdavList(config);
    const backups = files
      .filter(f => f.startsWith(BACKUP_FILE_PREFIX) && f.endsWith(BACKUP_FILE_EXT))
      .sort();
    while (backups.length > keep) {
      const old = backups.shift();
      await webdavRequest('DELETE', `${dir}/${old}`, user, pass);
    }
  } catch (e) { /* 清理失败不阻断上传成功 */ }

  return filename;
}

/**
 * 从备份文件名解析 UTC 时间戳（与 __meta.exportedAt 同基准，均可与 Date.now() 比较）。
 * 文件名格式：cookie-switcher-backup-YYYYMMDDHHMMSS.json（UTC，秒级）
 * 解析失败返回 0。
 */
function parseBackupStamp(filename) {
  const m = String(filename || '').match(/(\d{14})/);
  if (!m) return 0;
  const s = m[1];
  return Date.UTC(
    +s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8),
    +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14)
  );
}

/**
 * 下载"数据最新"的备份（v2.7.5 内容感知自动筛选）：
 *  - 列出目录下所有备份文件
 *  - 逐个下载，优先按文件内 __meta.exportedAt（数据导出时间）判定新旧；
 *    旧格式备份无 meta 或解密失败时，回退用文件名时间戳（UTC）参与比较
 *  - 单个文件下载失败/损坏自动跳过；认证失败整体终止
 *  - 返回选中的 { filename, content, exportedAt, meta }
 */
async function webdavPull(config) {
  const { user, pass } = config;
  const dir = backupDir(config);
  const files = await webdavList(config);
  const backups = files
    .filter(f => f.startsWith(BACKUP_FILE_PREFIX) && f.endsWith(BACKUP_FILE_EXT))
    .sort();
  if (backups.length === 0) throw new Error('远端没有备份文件');

  let best = null; // { filename, content, exportedAt, meta }
  for (const name of backups) {
    let content;
    try {
      const resp = await webdavRequest('GET', `${dir}/${name}`, user, pass);
      if (resp.status === 401 || resp.status === 403) throw new Error('认证失败');
      if (!resp.ok) continue; // 单个文件下载失败：跳过
      content = await resp.text();
    } catch (e) {
      if (e && e.message === '认证失败') throw new Error('认证失败，请检查用户名/密码');
      continue;
    }

    let exportedAt = parseBackupStamp(name); // 回退：文件名时间戳
    let meta = null;
    try {
      const outer = JSON.parse(content);
      // v2.7.3+：__meta 在加密内容内，需解密读取（口令=WebDAV 密码，仅内存）
      if (outer && typeof outer.data === 'string' && outer.data) {
        const parsed = await parseBackup(outer.data, pass);
        meta = parsed.meta;
        if (meta && meta.exportedAt) exportedAt = meta.exportedAt;
      }
    } catch (e) { /* 旧格式 / 解密失败：保留文件名时间戳 */ }

    if (!best || exportedAt > best.exportedAt) {
      best = { filename: name, content, exportedAt, meta };
    }
  }

  if (!best) throw new Error('远端没有可用的备份文件');
  return { ...best, totalBackups: backups.length };
}

/**
 * 归一化 WebDAV URL：仅去空白；留空用默认服务器。
 * 不自动补协议——用户填什么就是什么，格式由 isValidWebdavUrl 把关。
 */
function normalizeWebdavUrl(url) {
  const t = String(url || '').trim();
  return t || DEFAULT_WEBDAV_URL;
}

/**
 * 校验 URL 是否为 http(s) 的 WebDAV 地址。
 */
function isValidWebdavUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
}
