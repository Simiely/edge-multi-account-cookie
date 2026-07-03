/**
 * Cookie Switcher - Popup Script
 * Main interaction logic for the extension popup.
 */

// ============================================================
//  State
// ============================================================

let currentDomain = '';
let currentTabId = -1;

// DOM refs
const $ = (id) => document.getElementById(id);
const domainText = $('domainText');
const inputName = $('inputName');
const btnSave = $('btnSave');
const btnRefresh = $('btnRefresh');
const btnOptions = $('btnOptions');
const btnLoginNew = $('btnLoginNew');
const statusBar = $('statusBar');
const accountList = $('accountList');
const emptyState = $('emptyState');
const sectionTitle = $('sectionTitle');

// ============================================================
//  Initialization
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  await initCurrentTab();
  await renderAccountList();
  bindEvents();
});

async function initCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
    domainText.textContent = '不支持该页面';
    btnSave.disabled = true;
    btnLoginNew.disabled = true;
    return;
  }
  currentDomain = extractDomain(tab.url);
  currentTabId = tab.id;
  domainText.textContent = currentDomain;

  if (!currentDomain) return;

  // Check whitelist
  const allowed = await isDomainAllowed(currentDomain);
  if (!allowed) {
    showStatus(statusBar, `域名 ${currentDomain} 不在白名单中`, 'error', 0);
    btnSave.disabled = true;
    btnLoginNew.disabled = true;
    return;
  }

  // Check if cookies API is accessible (activeTab may not cover all cases)
  await verifyCookieAccess();
}

/**
 * Test if cookies API works on the current domain.
 * activeTab grants temporary host permissions, but some browsers
 * may require explicit host_permissions for cookies API.
 */
async function verifyCookieAccess() {
  try {
    const test = await getCookies(currentDomain);
    // API returned - it works
  } catch (e) {
    const msg = (e.message || '').toLowerCase();
    if (msg.includes('permiss') || msg.includes('denied') || msg.includes('access')) {
      statusBar.innerHTML =
        `<div class="status-bar show error" style="display:block;">
          ⚠️ 需要授权才能操作 ${currentDomain} 的 Cookie<br>
          <button id="btnGrantPerm" style="margin-top:6px;padding:5px 12px;border:none;border-radius:4px;background:#4f8cff;color:#fff;cursor:pointer;font-size:12px;">
            ✅ 授权访问此网站
          </button>
        </div>`;
      // Bind grant button after DOM update
      setTimeout(() => {
        const grantBtn = document.getElementById('btnGrantPerm');
        if (grantBtn) {
          grantBtn.addEventListener('click', requestHostPermission);
        }
      }, 50);
      btnSave.disabled = true;
      btnLoginNew.disabled = true;
      return;
    }
    // Silently continue - empty cookies array is still usable (for sites with no cookies yet)
  }
}

/**
 * Request host permission for the current domain via optional permissions API.
 */
async function requestHostPermission() {
  try {
    const url = `*://${currentDomain}/*`;
    const granted = await chrome.permissions.request({
      origins: [url]
    });
    if (granted) {
      showStatus(statusBar, `✓ 已获得 ${currentDomain} 的访问权限`, 'success');
      btnSave.disabled = false;
      btnLoginNew.disabled = false;
    } else {
      showStatus(statusBar, '用户拒绝了权限请求', 'error');
    }
  } catch (e) {
    showStatus(statusBar, `权限请求失败：${e.message}`, 'error');
  }
}

// ============================================================
//  Render account list
// ============================================================

async function renderAccountList() {
  accountList.innerHTML = '';
  if (!currentDomain) {
    emptyState.style.display = 'block';
    sectionTitle.textContent = '已保存的账号';
    return;
  }

  const accounts = await getDomainAccounts(currentDomain);
  const entries = Object.entries(accounts);

  if (entries.length === 0) {
    emptyState.style.display = 'block';
    sectionTitle.textContent = '已保存的账号';
    return;
  }

  emptyState.style.display = 'none';
  sectionTitle.textContent = `已保存的账号（${entries.length}）`;

  // Sort by group, then by name
  entries.sort(([, a], [, b]) => {
    if (a.group !== b.group) return (a.group || '').localeCompare(b.group || '');
    return 0;
  });

  let currentGroup = '';
  for (const [name, account] of entries) {
    // Group header
    if (account.group && account.group !== currentGroup) {
      currentGroup = account.group;
      const groupHeader = document.createElement('div');
      groupHeader.style.cssText = 'font-size:11px;color:var(--text-secondary);padding:6px 4px 2px;';
      groupHeader.textContent = account.group;
      accountList.appendChild(groupHeader);
    }

    const card = document.createElement('div');
    card.className = 'account-card';

    // Avatar
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = name.charAt(0).toUpperCase();
    card.appendChild(avatar);

    // Info
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
    if (account.group) {
      meta.textContent += ` · ${account.group}`;
    }
    info.appendChild(meta);
    card.appendChild(info);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'actions';

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

    // Click card to switch
    card.addEventListener('click', () => {
      handleSwitchAccount(name, account);
    });

    accountList.appendChild(card);
  }
}

// ============================================================
//  Event Handlers
// ============================================================

function bindEvents() {
  // Save
  btnSave.addEventListener('click', handleSaveAccount);

  // Enter key to save
  inputName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSaveAccount();
  });

  // Refresh
  btnRefresh.addEventListener('click', async () => {
    await initCurrentTab();
    await renderAccountList();
  });

  // Options
  btnOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Login new (clear cookies)
  btnLoginNew.addEventListener('click', handleLoginNew);
}

// ============================================================
//  Save Account
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
    // Get cookies
    const cookies = await getCookies(currentDomain);

    // Get localStorage
    const lsData = await getTabLocalStorage(currentTabId);

    // Save
    await saveAccount(currentDomain, name, cookies, lsData, '');

    showStatus(statusBar, `✓ 已保存「${name}」(${cookies.length} 个 Cookie)`);
    inputName.value = '';
    await renderAccountList();
  } catch (e) {
    showStatus(statusBar, `保存失败：${e.message}`, 'error');
  } finally {
    btnSave.disabled = false;
    btnSave.textContent = '💾 保存当前账号';
  }
}

// ============================================================
//  Switch Account
// ============================================================

async function handleSwitchAccount(name, account) {
  const cookies = account.cookies || [];
  const lsData = account.localStorage || {};

  showStatus(statusBar, `⏳ 正在切换到「${name}」...`, 'success', 0);

  try {
    // Apply cookies
    await applyCookies(currentDomain, cookies);

    // Apply localStorage
    if (Object.keys(lsData).length > 0) {
      await setTabLocalStorage(currentTabId, lsData);
    }

    // Refresh page
    await chrome.tabs.reload(currentTabId);

    showStatus(statusBar, `✓ 已切换到「${name}」`);
  } catch (e) {
    showStatus(statusBar, `切换失败：${e.message}`, 'error');
  }
}

// ============================================================
//  Delete Account
// ============================================================

async function handleDeleteAccount(name) {
  if (!confirm(`确定要删除「${name}」的账号数据吗？`)) return;

  try {
    await deleteAccount(currentDomain, name);
    showStatus(statusBar, `✓ 已删除「${name}」`);
    await renderAccountList();
  } catch (e) {
    showStatus(statusBar, `删除失败：${e.message}`, 'error');
  }
}

// ============================================================
//  Login New (Clear cookies for fresh login)
// ============================================================

async function handleLoginNew() {
  if (!currentDomain) return;

  showStatus(statusBar, '⏳ 正在清除 Cookie...', 'success', 0);

  try {
    await clearDomainCookies(currentDomain);
    await clearTabLocalStorage(currentTabId);
    await chrome.tabs.reload(currentTabId);
    showStatus(statusBar, '✓ Cookie 已清除，请在新页面登录');
  } catch (e) {
    showStatus(statusBar, `清除失败：${e.message}`, 'error');
  }
}
