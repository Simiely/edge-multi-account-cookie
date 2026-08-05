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

// Backup
const btnExport = $('btnExport');
const fileInput = $('fileInput');
const importMode = $('importMode');
const backupStatus = $('backupStatus');

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

  // WebDAV（逻辑在 ui/webdav-options.js）
  fillWebdavSettings(opts.webdav);
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
      // 关闭密码锁：需验证当前密码（走带锁校验），验证通过后复用同一密码解包主密钥
      const hasPassword = await isPinSetLocal();
      let pwd = '';
      if (hasPassword) {
        pwd = prompt('🔐 输入当前密码以关闭密码锁：');
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
      try {
        // 关闭：MK 恢复明文落盘，弹窗不再要求密码（数据仍保留，只是不再受密码保护）
        await sendMessage('pin.set', { newPin: '', currentPin: pwd });
        togglePinConfig(false);
        showMsg(pinStatus, '密码锁已关闭，弹窗不再要求输入密码', 'success');
        pinEnabled.checked = false;
      } catch (err) {
        showMsg(pinStatus, `关闭失败：${err.message}`, 'error');
        pinEnabled.checked = true;
      }
    }
  });

  btnSavePin.addEventListener('click', handleSavePin);

  // Backup
  btnExport.addEventListener('click', handleExport);
  fileInput.addEventListener('change', handleImport);

  // WebDAV（事件绑定在 ui/webdav-options.js）
  bindWebdavEvents();
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
//  Export / Import
// ============================================================

async function handleExport() {
  // 有锁：自动用密码锁密码；无锁：弹窗输入口令。都不需要先设密码锁。
  try {
    const data = await sendMessage('backup.export', {});
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cookie-switcher-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showMsg(backupStatus, '✅ 数据导出成功（已用密码锁密码加密）', 'success');
  } catch (e) {
    if (e.message === 'NEED_PIN') {
      // 无密码锁（或无缓存 PIN）→ 弹窗让用户输入口令
      const pwd = prompt('🔐 输入导出加密密码（请牢记，导入时需输入相同密码）：');
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
      } catch (e2) {
        showMsg(backupStatus, `导出失败：${e2.message}`, 'error');
      }
      return;
    }
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

    const mode = importMode.value;
    // 先自动尝试（有锁用密码锁密码；无锁直接 NEED_PIN）
    try {
      const r = await sendMessage('backup.import', { blob: json.data, pin: '', mode });
      showMsg(backupStatus, `✅ 导入成功：新增 ${r.imported} 个账号${r.skipped ? `，跳过 ${r.skipped} 个同名账号` : ''}`, 'success');
      fileInput.value = '';
      return;
    } catch (err) {
      if (err.message !== 'NEED_PIN') throw err;
    }
    // 自动解密失败/无锁 → 弹窗手动输入口令
    const pwd = prompt('🔐 输入该备份文件的解密密码：');
    if (!pwd) {
      fileInput.value = '';
      return;
    }
    const r = await sendMessage('backup.import', { blob: json.data, pin: pwd, mode });
    showMsg(backupStatus, `✅ 导入成功：新增 ${r.imported} 个账号${r.skipped ? `，跳过 ${r.skipped} 个同名账号` : ''}`, 'success');
  } catch (err) {
    showMsg(backupStatus, `导入失败：${err.message}`, 'error');
  }

  fileInput.value = '';
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
