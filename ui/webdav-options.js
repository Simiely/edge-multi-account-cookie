/**
 * ui/webdav-options.js - 设置页 WebDAV 区块 UI 逻辑
 * 由 options.html 在 options.js 之前引入。
 * 依赖：lib/messaging.js（sendMessage）、options.js 的 showMsg。
 */

// 默认 WebDAV 服务器（与 lib/webdav.js 的 DEFAULT_WEBDAV_URL 保持一致；URL 留空时使用）
const DEFAULT_WEBDAV_URL = 'http://192.168.2.1:6086';

/**
 * 归一化 URL（与 lib/webdav.js normalizeWebdavUrl 一致）：仅去空白；留空用默认。
 * 不自动补协议——用户填什么就是什么。
 */
function normalizeWebdavUrl(url) {
  const t = String(url || '').trim();
  return t || DEFAULT_WEBDAV_URL;
}

// ============================================================
//  WebDAV DOM
// ============================================================

const webdavUrl = document.getElementById('webdavUrl');
const webdavUser = document.getElementById('webdavUser');
const webdavPass = document.getElementById('webdavPass');
const webdavKeep = document.getElementById('webdavKeep');
const webdavSchedule = document.getElementById('webdavSchedule');
const btnWebdavTest = document.getElementById('btnWebdavTest');
const btnWebdavSave = document.getElementById('btnWebdavSave');
const btnWebdavPush = document.getElementById('btnWebdavPush');
const btnWebdavPull = document.getElementById('btnWebdavPull');
const btnWebdavRemove = document.getElementById('btnWebdavRemove');
const webdavStatus = document.getElementById('webdavStatus');

// ============================================================
//  填充已保存配置（options.js loadSettings 调用）
// ============================================================

function fillWebdavSettings(webdav) {
  if (!webdav) return;
  // URL 若为默认服务器则不回填（保持界面简洁，留空即用默认）
  webdavUrl.value = (webdav.url && webdav.url !== DEFAULT_WEBDAV_URL) ? webdav.url : '';
  webdavUser.value = webdav.user || '';
  webdavKeep.value = webdav.keep || 1;
  webdavSchedule.value = webdav.schedule || 'manual';
  webdavPass.value = '';
  webdavPass.placeholder = '已保存（留空保持不变）';
}

function bindWebdavEvents() {
  btnWebdavTest.addEventListener('click', handleWebdavTest);
  btnWebdavSave.addEventListener('click', handleWebdavSave);
  btnWebdavPush.addEventListener('click', handleWebdavPush);
  btnWebdavPull.addEventListener('click', handleWebdavPull);
  btnWebdavRemove.addEventListener('click', handleWebdavRemove);
}

// ============================================================
//  逻辑
// ============================================================

/**
 * 确保主密钥在会话中可用（有锁且未解锁时引导用户输入密码）。
 * @returns {Promise<boolean>}
 */
async function ensureMasterKeyUnlocked() {
  const opts = await sendMessage('options.get');
  if (!opts.mkWrapped) return true; // MK 明文落盘，直接可用
  // 尝试直接读取（可能已在弹窗解锁过，会话缓存有效）
  const chk = await sendMessage('masterkey.available');
  if (chk.available) return true;
  // 未解锁：要求输入密码锁密码
  const pwd = prompt('🔐 主密钥已加密，输入密码锁密码以解锁（用于加密 WebDAV 凭据）：');
  if (!pwd) return false;
  const r = await sendMessage('pin.unlock', { pin: pwd });
  if (!r.ok) {
    showMsg(webdavStatus, r.locked ? `已锁定，请 ${r.retryAfterSeconds}s 后重试` : '密码错误', 'error');
    return false;
  }
  return true;
}

/**
 * 按需申请 WebDAV 服务器域名权限（必须在用户手势上下文调用）。
 */
async function ensureWebdavPermission(url) {
  try {
    const u = new URL(url);
    const origin = `${u.protocol}//${u.hostname}/*`;
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        showMsg(webdavStatus, `未授权访问 ${u.hostname}，WebDAV 功能不可用`, 'error');
        return false;
      }
    }
    return true;
  } catch (e) {
    // permissions API 不可用时继续（连接测试以实际结果为准）
    return true;
  }
}

function collectWebdavConfig() {
  return {
    url: webdavUrl.value.trim(),
    user: webdavUser.value.trim(),
    pass: webdavPass.value.trim(),
    keep: parseInt(webdavKeep.value, 10) || 1,
    schedule: webdavSchedule.value
  };
}

async function handleWebdavTest() {
  const cfg = collectWebdavConfig();
  // 用户名/密码留空时：若已保存过配置则交由 SW 复用已存凭据，否则报错
  if (!cfg.user && !cfg.pass) {
    const opts = await sendMessage('options.get');
    const saved = opts && opts.webdav;
    if (!saved || !saved.user) {
      showMsg(webdavStatus, '请填写用户名与密码', 'error');
      return;
    }
    // 已保存配置 → 需解锁主密钥才能解密已存密码
    if (!(await ensureMasterKeyUnlocked())) return;
  } else {
    if (!(await ensureWebdavPermission(normalizeWebdavUrl(cfg.url)))) return;
  }
  btnWebdavTest.disabled = true;
  btnWebdavTest.textContent = '测试中...';
  try {
    const r = await sendMessage('webdav.test', cfg);
    showMsg(webdavStatus, `✅ 连接成功，服务器上检测到 ${r.count} 个项目`, 'success');
  } catch (e) {
    showMsg(webdavStatus, `连接失败：${e.message}`, 'error');
  } finally {
    btnWebdavTest.disabled = false;
    btnWebdavTest.textContent = '🔌 连接测试';
  }
}

async function handleWebdavSave() {
  const cfg = collectWebdavConfig();
  // URL 可留空（自动使用默认服务器），仅用户名必填
  if (!cfg.user) {
    showMsg(webdavStatus, '请填写用户名', 'error');
    return;
  }
  if (!(await ensureMasterKeyUnlocked())) return;
  if (!(await ensureWebdavPermission(normalizeWebdavUrl(cfg.url)))) return;
  try {
    await sendMessage('webdav.save', cfg);
    webdavPass.value = '';
    webdavPass.placeholder = '已保存（留空保持不变）';
    showMsg(webdavStatus, '✅ WebDAV 配置已保存（密码已加密存储）', 'success');
  } catch (e) {
    showMsg(webdavStatus, `保存失败：${e.message}`, 'error');
  }
}

async function handleWebdavPush() {
  try {
    if (!(await ensureMasterKeyUnlocked())) return;
    btnWebdavPush.disabled = true;
    btnWebdavPush.textContent = '上传中...';
    const r = await sendMessage('webdav.push');
    showMsg(webdavStatus, `✅ 备份已上传：${r.path || r.filename}`, 'success');
  } catch (e) {
    showMsg(webdavStatus, `上传失败：${e.message}`, 'error');
  } finally {
    btnWebdavPush.disabled = false;
    btnWebdavPush.textContent = '📤 立即备份';
  }
}

async function handleWebdavPull() {
  try {
    if (!(await ensureMasterKeyUnlocked())) return;
    btnWebdavPull.disabled = true;
    btnWebdavPull.textContent = '核对中...';

    // v2.7.3：第一步先下载并做差异核对预览，用户确认后才真正导入（防旧备份覆盖新数据）
    const p = await sendMessage('webdav.preview');

    const fmtTime = (ts) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '（旧备份无时间标记）';
    const lines = [];
    // v2.7.5：已自动筛选数据最新的一份
    lines.push(`🔍 已自动筛选 ${p.totalBackups || 1} 份备份，选中数据最新的一份：${p.filename}`);
    lines.push(`远端导出时间：${fmtTime(p.remoteExportedAt)}`);
    lines.push(`远端账号：${p.remoteAccountCount} 个 | 本地账号：${p.localAccountCount} 个`);
    if (p.toAdd.length) lines.push(`\n🆕 远端新增（本地没有）：${p.toAdd.length} 个\n  ${p.toAdd.slice(0, 8).join('\n  ')}${p.toAdd.length > 8 ? '\n  ...' : ''}`);
    if (p.toOverwrite.length) lines.push(`\n🔄 同名但远端更新：${p.toOverwrite.length} 个（智能合并会采用远端新版本）\n  ${p.toOverwrite.slice(0, 8).join('\n  ')}${p.toOverwrite.length > 8 ? '\n  ...' : ''}`);
    if (p.localOnly.length) lines.push(`\nℹ️ 本地独有（远端没有）：${p.localOnly.length} 个（智能合并保留）`);

    // 危险判定：远端比本地旧 → 警告
    const staleRisk = p.remoteExportedAt > 0 && !p.remoteNewer && p.localLatestUpdatedAt > p.remoteExportedAt;
    if (staleRisk) {
      lines.push(`\n⚠️ 危险提示：远端备份比本地数据旧，智能合并会保留本地新版本，但不会回退。`);
    }

    const ok = confirm(`【下载恢复前核对】\n\n${lines.join('\n')}\n\n智能合并：同一账号自动取最新版本，确认恢复？`);
    if (!ok) {
      showMsg(webdavStatus, '已取消：未导入任何数据', 'warning');
      return;
    }

    btnWebdavPull.textContent = '下载中...';
    // v2.7.4：智能合并（同名取最新），无需选择模式
    const r = await sendMessage('webdav.pull', {});
    const fmtResult = (() => {
      const parts = [];
      if (r.imported) parts.push(`新增 ${r.imported}`);
      if (r.updated) parts.push(`更新 ${r.updated}`);
      if (r.skipped) parts.push(`保留 ${r.skipped} 个本地更新`);
      return parts.join('，') || '无变化';
    })();
    showMsg(webdavStatus, `✅ 已从 ${r.filename} 恢复：${fmtResult}`, 'success');
  } catch (e) {
    showMsg(webdavStatus, `恢复失败：${e.message}`, 'error');
  } finally {
    btnWebdavPull.disabled = false;
    btnWebdavPull.textContent = '📥 下载恢复';
  }
}

async function handleWebdavRemove() {
  if (!confirm('确定清除 WebDAV 配置吗？远端备份文件不会被删除。')) return;
  try {
    await sendMessage('webdav.remove');
    webdavUrl.value = '';
    webdavUser.value = '';
    webdavPass.value = '';
    webdavKeep.value = 1;
    webdavSchedule.value = 'manual';
    webdavPass.placeholder = 'WebDAV 密码';
    showMsg(webdavStatus, '✅ WebDAV 配置已清除', 'success');
  } catch (e) {
    showMsg(webdavStatus, `清除失败：${e.message}`, 'error');
  }
}
