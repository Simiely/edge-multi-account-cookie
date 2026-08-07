/**
 * ui/webdav-options.js - 设置页 WebDAV 区块 UI 逻辑
 * 由 options.html 在 options.js 之前引入。
 * 依赖：lib/messaging.js（sendMessage）、ui/ui-helpers.js 的 showMsg（先于本文件引入）。
 * 注意：本文件顶部在加载时执行 document.getElementById（页面脚本模式，script 在 body 底部，DOM 已就绪）。
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
const btnWebdavSync = document.getElementById('btnWebdavSync');
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
  btnWebdavSync.addEventListener('click', handleWebdavSync);
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

/**
 * v2.9.0：测试保存 = 测试连接 + 连通后自动保存配置（无需单独"保存配置"按钮）。
 *  - 测试失败 → 不保存，提示错误
 *  - 测试成功 → 自动 webdav.save（密码留空时保留已存密码，keep/计划一并保存）
 */
async function handleWebdavTest() {
  const cfg = collectWebdavConfig();
  // URL 权限（保存与同步都需要）
  if (!(await ensureWebdavPermission(normalizeWebdavUrl(cfg.url)))) return;
  // 用户名/密码留空时：若已保存过配置则交由 SW 复用已存凭据，否则报错
  if (!cfg.user && !cfg.pass) {
    const opts = await sendMessage('options.get');
    const saved = opts && opts.webdav;
    if (!saved || !saved.user) {
      showMsg(webdavStatus, '请填写用户名与密码', 'error');
      return;
    }
  }
  // 测试（密码留空需解密已存密码）与自动保存都需要主密钥
  if (!(await ensureMasterKeyUnlocked())) return;
  btnWebdavTest.disabled = true;
  btnWebdavTest.textContent = '测试保存中...';
  try {
    // 1. 测试连接
    const r = await sendMessage('webdav.test', cfg);
    // 2. 连通 → 自动保存配置（保存逻辑复用 webdav.save）
    await sendMessage('webdav.save', cfg);
    webdavPass.value = '';
    webdavPass.placeholder = '已保存（留空保持不变）';
    showMsg(webdavStatus, `✅ 连接成功（检测到 ${r.count} 个项目），配置已自动保存`, 'success');
  } catch (e) {
    showMsg(webdavStatus, `测试失败：${e.message}（未保存配置）`, 'error');
  } finally {
    btnWebdavTest.disabled = false;
    btnWebdavTest.textContent = '🔌 测试保存';
  }
}

/**
 * v2.9.0：一键同步 = 先拉远端最新合并进本地 → 再上传合并后的全量（双向收敛，无损）。
 */
async function handleWebdavSync() {
  try {
    if (!(await ensureMasterKeyUnlocked())) return;
    btnWebdavSync.disabled = true;
    btnWebdavSync.textContent = '⏳ 同步中...';
    const r = await sendMessage('webdav.sync');

    const parts = [];
    if (r.pulled) {
      const p = r.pulled;
      const acts = [];
      if (p.imported) acts.push(`新增 ${p.imported}`);
      if (p.updated) acts.push(`更新 ${p.updated}`);
      if (p.skipped) acts.push(`保留 ${p.skipped} 个本地更新`);
      parts.push(`拉取「${p.filename}」${acts.length ? acts.join('、') : '无变化'}`);
    } else {
      parts.push('远端无备份，已创建首份');
    }
    parts.push(`上传「${r.pushed.filename}」`);
    showMsg(webdavStatus, `✅ 同步完成：${parts.join('；')}`, 'success');
  } catch (e) {
    showMsg(webdavStatus, `同步失败：${e.message}`, 'error');
  } finally {
    btnWebdavSync.disabled = false;
    btnWebdavSync.textContent = '🔄 一键同步';
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
