/**
 * Cookie Switcher - Options Page Script
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

// Whitelist
const inputDomain = $('inputDomain');
const btnAddDomain = $('btnAddDomain');
const domainList = $('domainList');
const domainStatus = $('domainStatus');

// Backup
const btnExport = $('btnExport');
const fileInput = $('fileInput');
const backupStatus = $('backupStatus');

// ============================================================
//  Init
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  bindEvents();
});

async function loadSettings() {
  // PIN
  const pinSet = await isPinSet();
  pinEnabled.checked = pinSet;
  togglePinConfig(pinSet);

  // Whitelist
  await renderWhitelist();
}

function togglePinConfig(show) {
  const currentRow = document.getElementById('pinCurrentRow');
  if (show) {
    pinConfig.classList.remove('hidden');
    isPinSet().then(hasPin => {
      currentRow.style.display = hasPin ? 'flex' : 'none';
    });
  } else {
    pinConfig.classList.add('hidden');
  }
}

function bindEvents() {
  // Password toggle
  pinEnabled.addEventListener('change', async (e) => {
    if (pinEnabled.checked) {
      // Turn ON - show config
      togglePinConfig(true);
    } else {
      // Turn OFF - verify password first
      const hasPassword = await isPinSet();
      if (hasPassword) {
        const pwd = prompt('🔐 输入当前密码以关闭密码锁：');
        if (!pwd) {
          // Cancelled - restore toggle
          pinEnabled.checked = true;
          return;
        }
        const valid = await verifyPin(pwd);
        if (!valid) {
          showMsg(pinStatus, '密码错误，未能关闭', 'error');
          pinEnabled.checked = true; // restore
          return;
        }
      }
      // Disable password lock
      await setPin('');
      await chrome.storage.local.remove('cookie_switcher_pin');
      togglePinConfig(false);
      showMsg(pinStatus, '密码锁已关闭', 'success');
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
}

// ============================================================
//  PIN
// ============================================================

async function handleSavePin() {
  const hasPin = await isPinSet();
  const current = pinCurrent.value.trim();
  const newPin = pinNew.value.trim();
  const confirm = pinConfirm.value.trim();

  // Validate current PIN if changing
  if (hasPin) {
    if (!current) {
      showMsg(pinStatus, '请输入当前密码', 'error');
      return;
    }
    const valid = await verifyPin(current);
    if (!valid) {
      showMsg(pinStatus, '当前密码错误', 'error');
      return;
    }
  }

  if (!newPin) {
    showMsg(pinStatus, '请输入新密码', 'error');
    return;
  }
  if (newPin.length < 1) {
    showMsg(pinStatus, '密码不能为空', 'error');
    return;
  }
  if (newPin !== confirm) {
    showMsg(pinStatus, '两次输入的密码不一致', 'error');
    return;
  }

  await setPin(newPin);
  pinCurrent.value = '';
  pinNew.value = '';
  pinConfirm.value = '';
  // 密码已设置，显示"当前密码"行
  document.getElementById('pinCurrentRow').style.display = 'flex';
  showMsg(pinStatus, '密码设置已保存', 'success');
}

// ============================================================
//  Whitelist
// ============================================================

async function renderWhitelist() {
  const whitelist = await getWhitelist();
  domainList.innerHTML = '';

  if (whitelist.length === 0) {
    domainList.innerHTML = '<div style="font-size:12px;color:var(--text-secondary);padding:8px;">暂无域名，将允许所有网站</div>';
    return;
  }

  for (const domain of whitelist) {
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

async function handleAddDomain() {
  let domain = inputDomain.value.trim().toLowerCase();
  if (!domain) {
    showMsg(domainStatus, '请输入域名', 'error');
    return;
  }
  // Strip protocol and path
  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  // Remove leading www. for normalization
  domain = domain.replace(/^www\./, '');

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    showMsg(domainStatus, '域名格式不正确', 'error');
    return;
  }

  const whitelist = await getWhitelist();
  if (whitelist.includes(domain)) {
    showMsg(domainStatus, '该域名已在白名单中', 'error');
    return;
  }

  whitelist.push(domain);
  await setWhitelist(whitelist);
  inputDomain.value = '';
  await renderWhitelist();
  showMsg(domainStatus, `已添加 ${domain}`, 'success');
}

async function removeFromWhitelist(domain) {
  let whitelist = await getWhitelist();
  whitelist = whitelist.filter(d => d !== domain);
  await setWhitelist(whitelist);
  await renderWhitelist();
}

// ============================================================
//  Export / Import
// ============================================================

async function handleExport() {
  const pwd = prompt('🔐 输入导出密码（用于加密备份文件）：');
  if (!pwd) return;
  if (pwd.length < 1) {
    showMsg(backupStatus, '密码不能为空', 'error');
    return;
  }

  try {
    const encrypted = await exportData(pwd);
    const blob = new Blob(
      [JSON.stringify({ version: 2, data: encrypted }, null, 2)],
      { type: 'application/json' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cookie-switcher-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showMsg(backupStatus, '✅ 数据导出成功（使用设置的密码可解密导入）', 'success');
  } catch (e) {
    showMsg(backupStatus, `导出失败：${e.message}`, 'error');
  }
}

async function handleImport(e) {
  const file = e.target.files[0];
  if (!file) return;

  const pwd = prompt('🔐 输入导出时设置的密码以解密导入：');
  if (!pwd) {
    fileInput.value = '';
    return;
  }

  try {
    const text = await file.text();
    const json = JSON.parse(text);
    if (!json.data) {
      throw new Error('文件格式不正确');
    }
    await importData(json.data, pwd);
    showMsg(backupStatus, '✅ 数据导入成功！请刷新扩展', 'success');
  } catch (e) {
    showMsg(backupStatus, `导入失败：${e.message}`, 'error');
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
  }, 3500);
}
