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
  pinConfig.classList.toggle('hidden', !pinSet);

  // Whitelist
  await renderWhitelist();
}

function bindEvents() {
  // PIN toggle
  pinEnabled.addEventListener('change', async () => {
    if (pinEnabled.checked) {
      pinConfig.classList.remove('hidden');
    } else {
      // Disable PIN
      await setPin('');
      await chrome.storage.local.remove('cookie_switcher_pin');
      pinConfig.classList.add('hidden');
      showMsg(pinStatus, 'PIN 锁已关闭', 'success');
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
      showMsg(pinStatus, '请输入当前 PIN 码', 'error');
      return;
    }
    const valid = await verifyPin(current);
    if (!valid) {
      showMsg(pinStatus, '当前 PIN 码错误', 'error');
      return;
    }
  }

  if (!newPin) {
    showMsg(pinStatus, '请输入新 PIN 码', 'error');
    return;
  }
  if (!/^\d{4,10}$/.test(newPin)) {
    showMsg(pinStatus, 'PIN 码须为 4-10 位数字', 'error');
    return;
  }
  if (newPin !== confirm) {
    showMsg(pinStatus, '两次输入的 PIN 码不一致', 'error');
    return;
  }

  await setPin(newPin);
  pinCurrent.value = '';
  pinNew.value = '';
  pinConfirm.value = '';
  showMsg(pinStatus, 'PIN 码设置已保存', 'success');
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
  const hasPin = await isPinSet();
  if (!hasPin) {
    showMsg(backupStatus, '请先设置 PIN 码再导出数据（数据会被加密）', 'error');
    return;
  }

  // Get PIN from user
  const pin = prompt('请输入 PIN 码以加密导出数据：');
  if (!pin) return;

  const valid = await verifyPin(pin);
  if (!valid) {
    showMsg(backupStatus, 'PIN 码错误', 'error');
    return;
  }

  try {
    const encrypted = await exportData(pin);
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
    showMsg(backupStatus, '数据导出成功', 'success');
  } catch (e) {
    showMsg(backupStatus, `导出失败：${e.message}`, 'error');
  }
}

async function handleImport(e) {
  const file = e.target.files[0];
  if (!file) return;

  const pin = prompt('请输入 PIN 码以解密导入数据：');
  if (!pin) {
    fileInput.value = '';
    return;
  }

  try {
    const text = await file.text();
    const json = JSON.parse(text);
    if (!json.data) {
      throw new Error('文件格式不正确');
    }
    await importData(json.data, pin);
    showMsg(backupStatus, '数据导入成功！请重启扩展或刷新页面', 'success');
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
