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
const backupStatus = $('backupStatus');
const dataStatus = $('dataStatus');

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

  // 状态栏
  await loadStatBar(opts);

  // 一次性迁移：旧 enc: 加密数据 → 明文存储（幂等；MK 不可用则静默等下次）
  try {
    await sendMessage('data.migratePlain');
  } catch (e) { /* 忽略：MK 不可用或已迁移 */ }
}

/**
 * 顶部状态栏：账号总数 / 密码锁 / 上次备份 / WebDAV。
 */
async function loadStatBar(opts) {
  // 账号总数
  try {
    const data = await loadRawDataStat();
    const count = Object.values(data.accounts || {}).reduce((n, d) => n + Object.keys(d).length, 0);
    document.getElementById('statAccounts').textContent = count;
  } catch (e) {
    document.getElementById('statAccounts').textContent = '-';
  }

  // 密码锁
  const pinEl = document.getElementById('statPin');
  pinEl.textContent = opts.pinSet ? '已开启' : '未开启';
  pinEl.className = 'stat-value ' + (opts.pinSet ? 'pill' : 'gray');

  // 上次备份
  const backupEl = document.getElementById('statBackup');
  if (opts.webdav && opts.webdav.lastBackupAt) {
    const d = new Date(opts.webdav.lastBackupAt);
    backupEl.textContent = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } else {
    backupEl.textContent = '从未';
  }

  // WebDAV
  const wdEl = document.getElementById('statWebdav');
  if (opts.webdav && opts.webdav.url) {
    wdEl.textContent = '已配置';
    wdEl.className = 'stat-value green';
  } else {
    wdEl.textContent = '未配置';
    wdEl.className = 'stat-value gray';
  }
}

/**
 * 读取原始数据（仅统计账号数，不触达加密）。
 */
async function loadRawDataStat() {
  const result = await chrome.storage.local.get('cookie_switcher_data');
  const data = result['cookie_switcher_data'] || { accounts: {} };
  // v2.10.0：统计不含墓碑（已删除账号）
  const active = {};
  for (const domain of Object.keys(data.accounts || {})) {
    const names = Object.keys(data.accounts[domain]).filter((n) => !data.accounts[domain][n].deleted);
    if (names.length) {
      active[domain] = {};
      for (const n of names) active[domain][n] = data.accounts[domain][n];
    }
  }
  data.accounts = active;
  return data;
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

  // 数据管理：清空本地账号数据
  document.getElementById('btnClearData').addEventListener('click', handleClearData);

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

    // v2.7.4：智能合并（同名账号取最新），无需选择模式
    const fmtResult = (r) => {
      const parts = [];
      if (r.imported) parts.push(`新增 ${r.imported}`);
      if (r.updated) parts.push(`更新 ${r.updated}`);
      if (r.skipped) parts.push(`保留 ${r.skipped} 个本地更新`);
      return parts.join('，') || '无变化';
    };
    // 先自动尝试（有锁用密码锁密码；无锁直接 NEED_PIN）
    try {
      const r = await sendMessage('backup.import', { blob: json.data, pin: '' });
      showMsg(backupStatus, `✅ 导入完成：${fmtResult(r)}`, 'success');
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
    const r = await sendMessage('backup.import', { blob: json.data, pin: pwd });
    showMsg(backupStatus, `✅ 导入完成：${fmtResult(r)}`, 'success');
  } catch (err) {
    showMsg(backupStatus, `导入失败：${err.message}`, 'error');
  }

  fileInput.value = '';
}

// ============================================================
//  数据管理：清空本地账号数据
// ============================================================

async function handleClearData() {
  // 第一步确认
  const first = confirm('确定要清空扩展本地保存的全部账号数据吗？\n\n清空仅影响本机（不删除远端备份、不会同步删除其他设备）。\n若已配置 WebDAV，下次同步可从远端备份恢复。');
  if (!first) return;
  // 第二步确认（输入确认词，防误触）
  const word = prompt('此操作不可恢复。\n请输入「清空」以确认执行：');
  if (word !== '清空') {
    showMsg(dataStatus, '已取消：输入内容不匹配', 'warning');
    return;
  }
  try {
    const btn = document.getElementById('btnClearData');
    btn.disabled = true;
    btn.textContent = '清空中...';
    await sendMessage('data.clearAll');
    // v2.11.4：清空 = 仅本机物理清空（不传播删除；如已配置 WebDAV 下次同步可从远端恢复）
    showMsg(dataStatus, '✅ 已清空本地账号数据（仅本机；已配置 WebDAV 时下次同步可从远端恢复；密码锁 / WebDAV 配置保留）', 'success');
    await loadSettings(); // 刷新状态栏（账号数归零）
  } catch (e) {
    showMsg(dataStatus, `清空失败：${e.message}`, 'error');
  } finally {
    const btn = document.getElementById('btnClearData');
    btn.disabled = false;
    btn.textContent = '清空本地账号数据';
  }
}

// ============================================================
//  Helpers
// ============================================================
// showMsg 已下沉至 ui/ui-helpers.js（options.html 先于本文件引入），
// options.js 与 webdav-options.js 共用同一份实现，避免跨文件全局函数依赖。
