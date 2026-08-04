/**
 * Cookie Switcher - Options Page Script
 * 全部操作经 lib/messaging.js 走 Service Worker。
 */

const $ = (id) => document.getElementById(id);

// PIN
const pinEnabled = $('pinEnabled');
const pinConfig = $('pinConfig');
const pinCurrent = $('pinCurrent');
const pinNew = $('pinNew');
const pinConfirm = $('pinConfirm');
const btnSavePin = $('btnSavePin');
const pinStatus = $('pinStatus');
const lockBanner = $('lockBanner');

// Whitelist
const inputDomain = $('inputDomain');
const btnAddDomain = $('btnAddDomain');
const domainList = $('domainList');
const domainStatus = $('domainStatus');

// Backup
const btnExport = $('btnExport');
const fileInput = $('fileInput');
const importMode = $('importMode');
const backupStatus = $('backupStatus');

// WebDAV
const webdavUrl = $('webdavUrl');
const webdavUser = $('webdavUser');
const webdavPass = $('webdavPass');
const webdavKeep = $('webdavKeep');
const webdavSchedule = $('webdavSchedule');
const btnWebdavTest = $('btnWebdavTest');
const btnWebdavSave = $('btnWebdavSave');
const btnWebdavPush = $('btnWebdavPush');
const btnWebdavPull = $('btnWebdavPull');
const btnWebdavRemove = $('btnWebdavRemove');
const webdavStatus = $('webdavStatus');

// ============================================================
//  Init
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  bindEvents();
});

async function loadSettings() {
  const opts = await sendMessage('options.get');

  // PIN
  pinEnabled.checked = opts.pinSet;
  togglePinConfig(opts.pinSet);

  // Whitelist
  await renderWhitelist(opts.whitelist);

  // WebDAV（不回传密码，仅填充非敏感字段）
  if (opts.webdav) {
    webdavUrl.value = opts.webdav.url || '';
    webdavUser.value = opts.webdav.user || '';
    webdavKeep.value = opts.webdav.keep || 10;
    webdavSchedule.value = opts.webdav.schedule || 'manual';
    webdavPass.value = '';
    webdavPass.placeholder = '已保存（留空保持不变）';
  }
}

function togglePinConfig(show) {
  const currentRow = document.getElementById('pinCurrentRow');
  if (show) {
    pinConfig.classList.remove('hidden');
    currentRow.style.display = 'flex';
  } else {
    pinConfig.classList.add('hidden');
  }
}

function bindEvents() {
  // Password toggle
  pinEnabled.addEventListener('change', async (e) => {
    if (pinEnabled.checked) {
      const opts = await sendMessage('options.get');
      if (!opts.pinSet) {
        // 首次开启：直接显示配置区设置密码
        pinConfig.classList.remove('hidden');
        document.getElementById('pinCurrentRow').style.display = 'none';
      } else {
        togglePinConfig(true);
      }
    } else {
      // 关闭：需验证当前密码（走带锁校验）
      const hasPassword = await isPinSetLocal();
      if (hasPassword) {
        const pwd = prompt('🔐 输入当前密码以关闭密码锁：');
        if (!pwd) {
          pinEnabled.checked = true;
          return;
        }
        const r = await sendMessage('pin.verify', { pin: pwd });
        if (!r.ok) {
          showMsg(pinStatus, r.locked ? `已锁定，请 ${r.retryAfterSeconds}s 后重试` : '密码错误，未能关闭', 'error');
          pinEnabled.checked = true;
          return;
        }
      }
      // 关闭密码锁：用当前密码解包主密钥
      const current = prompt('再次输入当前密码以解密数据：') || '';
      try {
        await sendMessage('pin.set', { newPin: '', currentPin: current });
        togglePinConfig(false);
        showMsg(pinStatus, '密码锁已关闭', 'success');
        pinEnabled.checked = false;
      } catch (err) {
        showMsg(pinStatus, `关闭失败：${err.message}`, 'error');
        pinEnabled.checked = true;
      }
    }
  });

  btnSavePin.addEventListener('click', handleSavePin);

  // Whitelist
  btnAddDomain.addEventListener('click', handleAddDomain);
  inputDomain.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddDomain();
  });

  // Backup
  btnExport.addEventListener('click', handleExport);
  fileInput.addEventListener('change', handleImport);

  // WebDAV
  btnWebdavTest.addEventListener('click', handleWebdavTest);
  btnWebdavSave.addEventListener('click', handleWebdavSave);
  btnWebdavPush.addEventListener('click', handleWebdavPush);
  btnWebdavPull.addEventListener('click', handleWebdavPull);
  btnWebdavRemove.addEventListener('click', handleWebdavRemove);
}

async function isPinSetLocal() {
  const opts = await sendMessage('options.get');
  return opts.pinSet;
}

// ============================================================
//  PIN
// ============================================================

async function handleSavePin() {
  const opts = await sendMessage('options.get');
  const hasPin = opts.pinSet;
  const current = pinCurrent.value.trim();
  const newPin = pinNew.value.trim();
  const confirm = pinConfirm.value.trim();

  if (hasPin) {
    if (!current) {
      showMsg(pinStatus, '请输入当前密码', 'error');
      return;
    }
    const r = await sendMessage('pin.verify', { pin: current });
    if (!r.ok) {
      showMsg(pinStatus, r.locked ? `已锁定，请 ${r.retryAfterSeconds}s 后重试` : '当前密码错误', 'error');
      return;
    }
  }

  if (!newPin) {
    showMsg(pinStatus, '请输入新密码', 'error');
    return;
  }
  if (newPin.length < 4) {
    showMsg(pinStatus, '密码至少 4 位', 'error');
    return;
  }
  if (newPin !== confirm) {
    showMsg(pinStatus, '两次输入的密码不一致', 'error');
    return;
  }

  try {
    await sendMessage('pin.set', { newPin, currentPin: current });
    pinCurrent.value = '';
    pinNew.value = '';
    pinConfirm.value = '';
    document.getElementById('pinCurrentRow').style.display = 'flex';
    showMsg(pinStatus, '密码设置已保存', 'success');
    pinEnabled.checked = true;
  } catch (e) {
    showMsg(pinStatus, `保存失败：${e.message}`, 'error');
  }
}

// ============================================================
//  Whitelist
// ============================================================

async function renderWhitelist(whitelist) {
  const list = whitelist || [];
  domainList.innerHTML = '';

  if (list.length === 0) {
    domainList.innerHTML = '<div style="font-size:12px;color:var(--text-secondary);padding:8px;">暂无域名，将允许所有网站</div>';
    return;
  }

  for (const domain of list) {
    const item = document.createElement('div');
    item.className = 'domain-item';

    const name = document.createElement('span');
    name.textContent = domain;
    item.appendChild(name);

    const btn = document.createElement('button');
    btn.className = 'remove-btn';
    btn.textContent = '✕';
    btn.addEventListener('click', async () => {
      await removeFromWhitelist(domain);
    });
    item.appendChild(btn);

    domainList.appendChild(item);
  }
}

async function fetchWhitelist() {
  const opts = await sendMessage('options.get');
  return opts.whitelist;
}

async function handleAddDomain() {
  let domain = inputDomain.value.trim().toLowerCase();
  if (!domain) {
    showMsg(domainStatus, '请输入域名', 'error');
    return;
  }
  domain = normalizeDomain(domain);

  if (!/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    showMsg(domainStatus, '域名格式不正确', 'error');
    return;
  }

  const whitelist = await fetchWhitelist();
  if (whitelist.includes(domain)) {
    showMsg(domainStatus, '该域名已在白名单中', 'error');
    return;
  }

  whitelist.push(domain);
  await sendMessage('whitelist.set', { domains: whitelist });
  inputDomain.value = '';
  await renderWhitelist(whitelist);
  showMsg(domainStatus, `已添加 ${domain}`, 'success');
}

async function removeFromWhitelist(domain) {
  let whitelist = await fetchWhitelist();
  whitelist = whitelist.filter((d) => d !== domain);
  await sendMessage('whitelist.set', { domains: whitelist });
  await renderWhitelist(whitelist);
}

// ============================================================
//  Export / Import
// ============================================================

async function handleExport() {
  const opts = await sendMessage('options.get');
  if (!opts.pinSet) {
    showMsg(backupStatus, '请先在「密码锁」中设置密码', 'error');
    return;
  }

  const pwd = prompt('🔐 输入导出加密密码（建议使用密码锁密码）：');
  if (!pwd) return;

  try {
    const data = await sendMessage('backup.export', { pin: pwd });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cookie-switcher-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showMsg(backupStatus, '✅ 数据导出成功（使用输入的密码可解密导入）', 'success');
  } catch (e) {
    showMsg(backupStatus, `导出失败：${e.message}`, 'error');
  }
}

async function handleImport(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const json = JSON.parse(text);
    if (!json.data) throw new Error('文件格式不正确');

    const pwd = prompt('🔐 输入该备份文件的解密密码：');
    if (!pwd) {
      fileInput.value = '';
      return;
    }

    const mode = importMode.value;
    const r = await sendMessage('backup.import', { blob: json.data, pin: pwd, mode });
    showMsg(backupStatus, `✅ 导入成功：新增 ${r.imported} 个账号${r.skipped ? `，跳过 ${r.skipped} 个同名账号` : ''}`, 'success');
  } catch (err) {
    showMsg(backupStatus, `导入失败：${err.message}`, 'error');
  }

  fileInput.value = '';
}

// ============================================================
//  WebDAV
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
    keep: parseInt(webdavKeep.value, 10) || 10,
    schedule: webdavSchedule.value
  };
}

async function handleWebdavTest() {
  const cfg = collectWebdavConfig();
  if (!cfg.url || !cfg.user || !cfg.pass) {
    showMsg(webdavStatus, '请先填写服务器 URL、用户名、密码', 'error');
    return;
  }
  if (!(await ensureWebdavPermission(cfg.url))) return;
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
  if (!cfg.url || !cfg.user) {
    showMsg(webdavStatus, '请填写服务器 URL 与用户名', 'error');
    return;
  }
  if (!(await ensureMasterKeyUnlocked())) return;
  if (!(await ensureWebdavPermission(cfg.url))) return;
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
    showMsg(webdavStatus, `✅ 备份已上传：${r.filename}`, 'success');
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
    const mode = importMode.value;
    btnWebdavPull.disabled = true;
    btnWebdavPull.textContent = '下载中...';
    const r = await sendMessage('webdav.pull', { mode });
    showMsg(webdavStatus, `✅ 已从 ${r.filename} 恢复：新增 ${r.imported} 个账号${r.skipped ? `，跳过 ${r.skipped}` : ''}`, 'success');
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
    webdavKeep.value = 10;
    webdavSchedule.value = 'manual';
    webdavPass.placeholder = 'WebDAV 密码';
    showMsg(webdavStatus, '✅ WebDAV 配置已清除', 'success');
  } catch (e) {
    showMsg(webdavStatus, `清除失败：${e.message}`, 'error');
  }
}

// ============================================================
//  Helpers
// ============================================================

function showMsg(el, msg, type) {
  el.textContent = msg;
  el.className = `status-msg show ${type}`;
  setTimeout(() => {
    el.className = 'status-msg';
  }, 4000);
}
