/**
 * Cookie Switcher - Popup Script
 * 全部操作经 lib/messaging.js 走 Service Worker（权限集中、WebDAV 前置）。
 */

let currentDomain = '';
let currentTabId = -1;
let unlocked = false;

const $ = (id) => document.getElementById(id);
const domainText = $('domainText');
const inputName = $('inputName');
const inputGroup = $('inputGroup');
const btnSave = $('btnSave');
const btnRefresh = $('btnRefresh');
const btnOptions = $('btnOptions');
const btnLoginNew = $('btnLoginNew');
const statusBar = $('statusBar');
const accountList = $('accountList');
const emptyState = $('emptyState');
const sectionTitle = $('sectionTitle');
const grantBanner = $('grantBanner');
const lockOverlay = $('lockOverlay');
const lockInput = $('lockInput');
const btnUnlock = $('btnUnlock');
const lockMsg = $('lockMsg');

// 分组折叠状态（会话内记忆）
const collapsedGroups = new Set();

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  await initLock();
});

// ============================================================
//  锁屏
// ============================================================

async function initLock() {
  const opts = await sendMessage('options.get');
  if (opts.pinSet) {
    lockOverlay.classList.add('show');
    lockInput.focus();
  } else {
    await boot();
  }
}

async function handleUnlock() {
  const pin = lockInput.value;
  if (!pin) { showLockMsg('请输入密码', 'error'); return; }
  const r = await sendMessage('pin.unlock', { pin });
  if (r.ok) {
    unlocked = true;
    lockOverlay.classList.remove('show');
    lockInput.value = '';
    showLockMsg('');
    await boot();
  } else if (r.locked) {
    showLockMsg(`尝试次数过多，请 ${r.retryAfterSeconds}s 后重试`, 'error');
  } else {
    showLockMsg('密码错误', 'error');
    lockInput.value = '';
    lockInput.focus();
  }
}

function showLockMsg(msg, type = '') {
  lockMsg.textContent = msg;
  lockMsg.className = 'lock-msg' + (type ? ' ' + type : '');
}

// ============================================================
//  初始化
// ============================================================

async function boot() {
  await initCurrentTab();
  await renderAccountList();
}

async function initCurrentTab() {
  const info = await sendMessage('tab.getCurrent');
  if (!info.supported) {
    domainText.textContent = '不支持该页面';
    btnSave.disabled = true;
    btnLoginNew.disabled = true;
    return;
  }
  currentDomain = info.domain;
  currentTabId = info.tabId;
  domainText.textContent = currentDomain;

  if (!currentDomain) return;

  const opts = await sendMessage('options.get');
  if (!opts.pinSet) {
    // 无锁时主密钥未解锁（MK 明文落盘，getMasterKey 直接可用）——无需额外处理
  }

  // 白名单检查
  if (!(await isDomainAllowed(currentDomain))) {
    showStatus(statusBar, `域名 ${currentDomain} 不在白名单中`, 'error', 0);
    btnSave.disabled = true;
    btnLoginNew.disabled = true;
    return;
  }

  await verifyCookieAccess();
}

async function verifyCookieAccess() {
  try {
    const url = `*://${currentDomain}/*`;
    const hasPerm = await chrome.permissions.contains({ origins: [url] });
    if (!hasPerm) {
      grantBanner.style.display = 'block';
      grantBanner.innerHTML = `
        <div style="padding:10px;background:rgba(255,146,146,0.12);border:1px solid rgba(255,146,146,0.3);border-radius:8px;margin-bottom:10px;">
          <div style="font-size:13px;margin-bottom:8px;">
            ⚠️ 需要授权才能操作 <strong>${currentDomain}</strong> 的 Cookie
          </div>
          <button id="btnGrantPerm" style="padding:6px 16px;border:none;border-radius:6px;background:#ff9292;color:#fff;cursor:pointer;font-size:13px;font-weight:500;">
            ✅ 授权访问此网站
          </button>
        </div>
      `;
      document.getElementById('btnGrantPerm').addEventListener('click', requestHostPermission);
      btnSave.disabled = true;
      btnLoginNew.disabled = true;
    }
  } catch (e) {
    // permissions API 不可用，静默继续
  }
}

async function requestHostPermission() {
  try {
    // 注意：permissions.request 必须在用户手势上下文（popup 页面）直接调用，
    // 不能走 sendMessage 到 SW——SW 无手势上下文会报 "must be called during a user gesture"
    const url = `*://${currentDomain}/*`;
    const granted = await chrome.permissions.request({ origins: [url] });
    if (granted) {
      showStatus(statusBar, `✓ 已获得 ${currentDomain} 的访问权限`, 'success');
      grantBanner.style.display = 'none';
      btnSave.disabled = false;
      btnLoginNew.disabled = false;
    } else {
      showStatus(statusBar, '你拒绝了权限请求，部分功能不可用', 'error');
    }
  } catch (e) {
    showStatus(statusBar, `权限请求失败：${e.message}`, 'error');
  }
}

// ============================================================
//  账号列表
// ============================================================

function isAccountExpired(account) {
  const cookies = account.cookies || [];
  if (cookies.length === 0) return false;
  const now = Date.now() / 1000;
  // 全部 Cookie 均过期 → 视为过期账号；存在会话 cookie（无 expirationDate）则不标记
  const allExpired = cookies.every((c) => c.expirationDate && c.expirationDate <= now);
  return allExpired && cookies.some((c) => c.expirationDate);
}

async function renderAccountList() {
  accountList.innerHTML = '';
  if (!currentDomain) {
    emptyState.style.display = 'block';
    sectionTitle.textContent = '已保存的账号';
    return;
  }

  const accounts = await sendMessage('account.list', { domain: currentDomain });
  const entries = Object.entries(accounts);

  if (entries.length === 0) {
    emptyState.style.display = 'block';
    sectionTitle.textContent = '已保存的账号';
    return;
  }

  emptyState.style.display = 'none';
  sectionTitle.textContent = `已保存的账号（${entries.length}）`;

  // 稳定排序：group 升序 → updatedAt 降序
  entries.sort(([, a], [, b]) => {
    const ga = (a.group || '').localeCompare(b.group || '');
    if (ga !== 0) return ga;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  let currentGroup = null;
  for (const [name, account] of entries) {
    const group = account.group || '';
    if (group !== currentGroup) {
      currentGroup = group;
      accountList.appendChild(createGroupHeader(group));
      if (collapsedGroups.has(group)) continue;
    }

    accountList.appendChild(createAccountCard(name, account, group));
  }
}

function createGroupHeader(group) {
  const header = document.createElement('div');
  header.className = 'group-header';
  const label = document.createElement('span');
  label.textContent = group || '未分组';
  const toggle = document.createElement('span');
  toggle.className = 'group-toggle';
  toggle.textContent = collapsedGroups.has(group) ? '▸' : '▾';
  header.appendChild(label);
  header.appendChild(toggle);
  header.addEventListener('click', () => {
    if (collapsedGroups.has(group)) {
      collapsedGroups.delete(group);
    } else {
      collapsedGroups.add(group);
    }
    renderAccountList();
  });
  return header;
}

function createAccountCard(name, account, group) {
  const card = document.createElement('div');
  card.className = 'account-card';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = name.charAt(0).toUpperCase();
  card.appendChild(avatar);

  const info = document.createElement('div');
  info.className = 'info';

  const nameEl = document.createElement('div');
  nameEl.className = 'name';
  nameEl.textContent = name;
  info.appendChild(nameEl);

  const meta = document.createElement('div');
  meta.className = 'group-tag';
  const cookieCount = (account.cookies || []).length;
  meta.textContent = `${cookieCount} 个 Cookie`;
  if (group) meta.textContent += ` · ${group}`;
  info.appendChild(meta);

  // 过期提示
  if (isAccountExpired(account)) {
    const expired = document.createElement('div');
    expired.className = 'expired-tag';
    expired.textContent = '⚠ 该账号 Cookie 已全部过期';
    info.appendChild(expired);
  }

  card.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'actions';

  const editBtn = document.createElement('button');
  editBtn.className = 'btn-edit';
  editBtn.textContent = '✎';
  editBtn.title = '编辑（重命名/分组）';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handleEditAccount(name);
  });
  actions.appendChild(editBtn);

  const switchBtn = document.createElement('button');
  switchBtn.className = 'btn-switch-icon';
  switchBtn.textContent = '▶';
  switchBtn.title = '切换到该账号';
  switchBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handleSwitchAccount(name, account);
  });
  actions.appendChild(switchBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn-delete';
  deleteBtn.textContent = '✕';
  deleteBtn.title = '删除该账号';
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handleDeleteAccount(name);
  });
  actions.appendChild(deleteBtn);

  card.appendChild(actions);

  card.addEventListener('click', () => {
    handleSwitchAccount(name, account);
  });

  return card;
}

// ============================================================
//  事件绑定
// ============================================================

function bindEvents() {
  btnSave.addEventListener('click', handleSaveAccount);
  inputName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSaveAccount();
  });
  btnRefresh.addEventListener('click', async () => {
    await initCurrentTab();
    await renderAccountList();
  });
  btnOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  btnLoginNew.addEventListener('click', handleLoginNew);
  btnUnlock.addEventListener('click', handleUnlock);
  lockInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleUnlock();
  });
}

// ============================================================
//  保存 / 切换 / 删除 / 编辑
// ============================================================

async function handleSaveAccount() {
  const name = inputName.value.trim();
  if (!name) {
    showStatus(statusBar, '请输入账号名称', 'error');
    inputName.focus();
    return;
  }
  if (!currentDomain) {
    showStatus(statusBar, '无法获取当前网站域名', 'error');
    return;
  }

  btnSave.disabled = true;
  btnSave.textContent = '⏳ 保存中...';

  try {
    const group = inputGroup.value.trim();
    const r = await sendMessage('account.save', { domain: currentDomain, name, group, tabId: currentTabId });

    if (r.saved === 0) {
      showStatus(statusBar, `⚠️ 已保存「${name}」但没有读取到任何 Cookie。可能缺少主机权限，请点击上方的「授权访问此网站」按钮`, 'error');
    } else {
      showStatus(statusBar, `✓ 已保存「${name}」(${r.saved} 个 Cookie${r.lsKeys ? ` + ${r.lsKeys} 项页面数据` : ''})`);
    }
    inputName.value = '';
    inputGroup.value = '';
    await renderAccountList();
  } catch (e) {
    showStatus(statusBar, `保存失败：${e.message}`, 'error');
  } finally {
    btnSave.disabled = false;
    btnSave.textContent = '💾 保存当前账号';
  }
}

async function handleSwitchAccount(name, account) {
  showStatus(statusBar, `⏳ 正在切换到「${name}」...`, 'success', 0);

  try {
    const r = await sendMessage('account.switch', { domain: currentDomain, name, tabId: currentTabId });

    let msg = `✓ 已切换到「${name}」`;
    if (r.skipped > 0) msg += `（${r.skipped} 个过期 Cookie 已跳过）`;
    if (r.failed.length > 0) msg += `（${r.failed.length} 个写入失败）`;
    if (r.rolledBack) msg += '，已回滚';
    showStatus(statusBar, msg, r.failed.length > 0 ? 'warning' : 'success');

    if (r.failed.length === 0 || r.rolledBack) {
      await chrome.tabs.reload(currentTabId);
    }
  } catch (e) {
    showStatus(statusBar, `切换失败：${e.message}`, 'error');
  }
}

async function handleDeleteAccount(name) {
  if (!confirm(`确定要删除「${name}」的账号数据吗？`)) return;
  try {
    await sendMessage('account.delete', { domain: currentDomain, name });
    showStatus(statusBar, `✓ 已删除「${name}」`);
    await renderAccountList();
  } catch (e) {
    showStatus(statusBar, `删除失败：${e.message}`, 'error');
  }
}

async function handleEditAccount(name) {
  const accounts = await sendMessage('account.list', { domain: currentDomain });
  const account = accounts[name];
  if (!account) return;

  const newName = prompt('重命名账号（留空则保持不变）：', name);
  if (newName !== null && newName.trim() && newName.trim() !== name) {
    const renamed = await sendMessage('account.rename', { domain: currentDomain, oldName: name, newName: newName.trim() })
      .catch(() => false);
    if (renamed) {
      await renderAccountList();
    }
  }

  const newGroup = prompt('设置分组（可输入新分组，留空清除）：', account.group || '');
  if (newGroup !== null) {
    await sendMessage('account.updateGroup', { domain: currentDomain, name: newName && newName.trim() && newName.trim() !== name ? newName.trim() : name, group: newGroup.trim() });
    await renderAccountList();
  }
}

async function handleLoginNew() {
  if (!currentDomain) return;

  showStatus(statusBar, '⏳ 正在清除 Cookie...', 'success', 0);

  try {
    const r = await sendMessage('site.clear', { domain: currentDomain, tabId: currentTabId });

    if (r.failedCookies.length > 0) {
      const failedNames = r.failedCookies.map((f) => f.name).join(', ');
      showStatus(statusBar,
        `⚠️ 成功移除 ${r.removed}/${r.total} 个 Cookie，${r.failedCookies.length} 个移除失败：${failedNames}`,
        'error');
    } else if (r.removed > 0) {
      showStatus(statusBar, `✓ 已清除 ${r.removed} 个 Cookie，页面正在刷新`);
    } else {
      showStatus(statusBar, '⚠️ 没有 Cookie 被清除，可能缺少权限', 'error');
    }
    await chrome.tabs.reload(currentTabId);
  } catch (e) {
    showStatus(statusBar, `清除失败：${e.message}`, 'error');
  }
}

// ============================================================
//  Helpers
// ============================================================

function showStatus(element, message, type = 'success', duration = 0) {
  element.textContent = message;
  element.className = `status-bar show ${type}`;
  if (duration > 0) {
    setTimeout(() => {
      element.className = 'status-bar';
    }, duration);
  }
}
