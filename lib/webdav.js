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
// 备份根目录（基于登录账号隔离）：workbuddy/<用户名>/
const BACKUP_ROOT = 'workbuddy';

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
 * schedule: 'manual' | 'daily' | 'weekly' → 映射为定时周期（分钟）。
 */
async function saveWebdavConfig({ url, user, pass, keep, schedule }) {
  const mk = await getMasterKey();
  if (!mk) throw new Error('无法获取主密钥，请先解锁密码锁');
  const passEnc = await encryptWithKey(String(pass || ''), mk);
  const existing = await getWebdavConfig();
  // 密码留空 = 保持不变
  const finalPassEnc = String(pass || '') ? passEnc : (existing && existing.passEnc);
  if (!finalPassEnc) throw new Error('请输入 WebDAV 密码');
  const periodMap = { manual: 0, daily: 1440, weekly: 10080 };
  await setWebdavConfig({
    // URL 留空 → 默认服务器；无协议 → 自动补 http://
    url: normalizeWebdavUrl(url).replace(/\/+$/, ''),
    user: String(user || ''),
    passEnc: finalPassEnc,
    keep: Number(keep) || DEFAULT_KEEP,
    schedule: schedule || 'manual',
    schedulePeriod: periodMap[schedule] || 0,
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
 * 计算备份目录：{base}/workbuddy/{用户名}/
 * 用户名 URL 编码（防特殊字符破坏路径）。
 */
function backupDir(config) {
  const { url, user } = config;
  const base = String(url || '').replace(/\/+$/, '');
  const uname = encodeURIComponent(String(user || 'default'));
  return `${base}/${BACKUP_ROOT}/${uname}`;
}

/**
 * 确保备份目录存在（PROPFIND 404 → MKCOL 创建；405=已存在可忽略）。
 */
async function ensureBackupDir(config) {
  const dir = backupDir(config);
  const probe = await webdavRequest('PROPFIND', dir, config.user, config.pass, undefined, { 'Depth': '0' });
  if (probe.status === 401 || probe.status === 403) throw new Error('认证失败，请检查用户名/密码');
  if (probe.status === 404) {
    const mk = await webdavRequest('MKCOL', dir, config.user, config.pass);
    // MKCOL 对已存在目录返回 405（Method Not Allowed）——视同成功
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
 * 下载最新备份，返回 { filename, content }。
 */
async function webdavPull(config) {
  const { user, pass } = config;
  const dir = backupDir(config);
  const files = await webdavList(config);
  const backups = files
    .filter(f => f.startsWith(BACKUP_FILE_PREFIX) && f.endsWith(BACKUP_FILE_EXT))
    .sort();
  if (backups.length === 0) throw new Error('远端没有备份文件');
  const latest = backups[backups.length - 1];
  const resp = await webdavRequest('GET', `${dir}/${latest}`, user, pass);
  if (resp.status === 401 || resp.status === 403) throw new Error('认证失败，请检查用户名/密码');
  if (!resp.ok) throw new Error(`下载失败：HTTP ${resp.status}`);
  return { filename: latest, content: await resp.text() };
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
