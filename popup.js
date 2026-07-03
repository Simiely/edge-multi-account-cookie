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
const debugLog = $('debugLog');
const debugContent = $('debugContent');
const grantBanner = $('grantBanner');

// ============================================================
//  Debug logging
// ============================================================

let _debugLines = [];

function debug(...args) {
  const msg = args.join(' ');
  _debugLines.push(msg);
  console.log('[CookieSwitcher]', msg);
  if (debugContent) {
    debugContent.textContent = _debugLines.join('\n');
    debugContent.scrollTop = debugContent.scrollHeight;
  }
}

function showDebug() {
  if (debugLog) debugLog.style.display = 'block';
}

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

  debug('初始化完成，域名:', currentDomain);
  showDebug();
}

/**
 * Proactively check if we have host permission for cookie access.
 * Uses chrome.permissions.contains() rather than waiting for API errors.
 */
async function verifyCookieAccess() {
  const url = `*://${currentDomain}/*`;

  try {
    const hasPerm = await chrome.permissions.contains({ origins: [url] });
    debug('权限检查:', currentDomain, hasPerm ? '✅ 已授权' : '❌ 需要授权');

    if (!hasPerm) {
      grantBanner.style.display = 'block';
      grantBanner.innerHTML = `
        <div style="padding:10px;background:rgba(79,140,255,0.12);border:1px solid rgba(79,140,255,0.3);border-radius:8px;margin-bottom:10px;">
          <div style="font-size:13px;margin-bottom:6px;">
            ⚠️ 需要授权才能操作 <strong>${currentDomain}</strong> 的 Cookie
          </div>
          <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;">
            Cookie API 需要主机权限才能读取和写入网站 Cookie。
          </div>
          <button id="btnGrantPerm" style="padding:6px 16px;border:none;border-radius:6px;background:#ff9292;color:#fff;cursor:pointer;font-size:13px;font-weight:500;">
            ✅ 授权访问此网站
          </button>
          <button id="btnDebugGrant" style="margin-left:6px;padding:6px 12px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:12px;">
            尝试直接读取 Cookie（调试）
          </button>
        </div>
      `;
      document.getElementById('btnGrantPerm').addEventListener('click', requestHostPermission);
      const debugBtn = document.getElementById('btnDebugGrant');
      if (debugBtn) {
        debugBtn.addEventListener('click', async () => {
          try {
            const cookies = await getCookies(currentDomain);
            debug('调试读取结果:', cookies.length, '个 Cookie');
            if (cookies.length > 0) {
              debug('Cookie 列表:', cookies.map(c => c.name).join(', '));
              grantBanner.style.display = 'none';
              btnSave.disabled = false;
              btnLoginNew.disabled = false;
            } else {
              debug('⚠️ 返回空数组，确实没有权限');
            }
          } catch (e) {
            debug('调试读取错误:', e.message);
          }
        });
      }
      btnSave.disabled = true;
      btnLoginNew.disabled = true;
    }
  } catch (e) {
    debug('权限 API 出错:', e.message);
    // Fallback: try direct cookie read
    try {
      const test = await getCookies(currentDomain);
      debug('备用检测: Cookie API 返回', test.length, '条');
    } catch (e2) {
      debug('备用检测失败:', e2.message);
    }
  }
}

/**
 * Request host permission for the current domain via optional permissions API.
 */
async function requestHostPermission() {
  try {
    const url = `*://${currentDomain}/*`;
    debug('请求权限:', url);
    const granted = await chrome.permissions.request({
      origins: [url]
    });
    if (granted) {
      debug('权限已授予');
      showStatus(statusBar, `✓ 已获得 ${currentDomain} 的访问权限`, 'success');
      grantBanner.style.display = 'none';
      btnSave.disabled = false;
      btnLoginNew.disabled = false;
    } else {
      debug('用户拒绝了权限请求');
      showStatus(statusBar, '你拒绝了权限请求，部分功能不可用', 'error');
    }
  } catch (e) {
    debug('权限请求出错:', e.message);
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
  debug('保存账号:', name, '域名:', currentDomain);

  try {
    // Get cookies
    debug('正在读取 Cookie...');
    const cookies = await getCookies(currentDomain);
    debug('读取到', cookies.length, '个 Cookie');
    if (cookies.length > 0) {
      debug('Cookie 名称:', cookies.map(c => c.name).join(', '));
    }

    // Get localStorage
    debug('正在读取 localStorage...');
    const lsData = await getTabLocalStorage(currentTabId);
    const lsKeys = Object.keys(lsData);
    debug('读取到', lsKeys.length, '条 localStorage');
    if (lsKeys.length > 0) {
      debug('localStorage 键:', lsKeys.join(', '));
    }

    // Save
    await saveAccount(currentDomain, name, cookies, lsData, '');
    debug('保存成功');

    if (cookies.length === 0) {
      showStatus(statusBar, `⚠️ 已保存「${name}」但没有读取到任何 Cookie。` +
        `可能缺少主机权限，请点击上方的「授权访问此网站」按钮`, 'error');
    } else {
      showStatus(statusBar, `✓ 已保存「${name}」(${cookies.length} 个 Cookie, ${lsKeys.length} 条 localStorage)`);
    }
    inputName.value = '';
    await renderAccountList();
  } catch (e) {
    debug('保存失败:', e.message);
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

  debug('切换账号:', name, cookies.length, '个 Cookie');
  showStatus(statusBar, `⏳ 正在切换到「${name}」...`, 'success', 0);

  try {
    if (cookies.length === 0) {
      debug('⚠️ 该账号没有任何 Cookie 数据');
    } else {
      // Apply cookies
      debug('开始写入 Cookie...');
      await applyCookies(currentDomain, cookies);
      debug('Cookie 写入完成');
    }

    // Apply localStorage
    if (Object.keys(lsData).length > 0) {
      debug('写入 localStorage...');
      await setTabLocalStorage(currentTabId, lsData);
      debug('localStorage 写入完成');
    }

    // Refresh page
    debug('刷新页面...');
    await chrome.tabs.reload(currentTabId);

    showStatus(statusBar, `✓ 已切换到「${name}」，页面正在刷新`);
  } catch (e) {
    debug('切换失败:', e.message);
    showStatus(statusBar, `切换失败：${e.message}`, 'error');
  }
}

// ============================================================
//  Delete Account
// ============================================================

async function handleDeleteAccount(name) {
  if (!confirm(`确定要删除「${name}」的账号数据吗？`)) {
    debug('取消删除:', name);
    return;
  }

  try {
    debug('删除账号:', name);
    await deleteAccount(currentDomain, name);
    debug('删除成功');
    showStatus(statusBar, `✓ 已删除「${name}」`);
    await renderAccountList();
  } catch (e) {
    debug('删除失败:', e.message);
    showStatus(statusBar, `删除失败：${e.message}`, 'error');
  }
}

// ============================================================
//  Login New (Clear cookies for fresh login)
// ============================================================

async function handleLoginNew() {
  if (!currentDomain) return;

  debug('清除 Cookie - 域名:', currentDomain);
  showStatus(statusBar, '⏳ 正在清除 Cookie...', 'success', 0);

  try {
    // Step 1: Read current cookies first
    const beforeCookies = await getCookies(currentDomain);
    debug('清除前有', beforeCookies.length, '个 Cookie');

    if (beforeCookies.length === 0) {
      debug('⚠️ 没有读到任何 Cookie，可能缺少主机权限');
    }

    // Step 2: Clear cookies
    await clearDomainCookies(currentDomain);
    debug('Cookie 清除完成');

    // Step 3: Clear localStorage
    await clearTabLocalStorage(currentTabId);
    debug('localStorage 清除完成');

    // Step 4: Verify
    const afterCookies = await getCookies(currentDomain);
    debug('清除后剩余', afterCookies.length, '个 Cookie');

    // Step 5: Reload
    await chrome.tabs.reload(currentTabId);
    debug('页面已刷新');

    if (beforeCookies.length > 0 && afterCookies.length === beforeCookies.length) {
      showStatus(statusBar, '⚠️ Cookie 未能成功清除，可能缺少主机权限。请点击上方的「授权访问此网站」', 'error');
    } else {
      showStatus(statusBar, `✓ Cookie 已清除（移除了 ${beforeCookies.length} 个），页面正在刷新`);
    }
  } catch (e) {
    debug('清除失败:', e.message);
    showStatus(statusBar, `清除失败：${e.message}`, 'error');
  }
}
