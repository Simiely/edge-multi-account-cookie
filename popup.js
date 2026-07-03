/**
 * Cookie Switcher - Popup Script
 * Main interaction logic for the extension popup.
 */

let currentDomain = '';
let currentTabId = -1;

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
const grantBanner = $('grantBanner');

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

  const allowed = await isDomainAllowed(currentDomain);
  if (!allowed) {
    showStatus(statusBar, `域名 ${currentDomain} 不在白名单中`, 'error', 0);
    btnSave.disabled = true;
    btnLoginNew.disabled = true;
    return;
  }

  await verifyCookieAccess();
}

async function verifyCookieAccess() {
  const url = `*://${currentDomain}/*`;

  try {
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
    // permissions API unavailable, continue silently
  }
}

async function requestHostPermission() {
  try {
    const url = `*://${currentDomain}/*`;
    const granted = await chrome.permissions.request({
      origins: [url]
    });
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

  entries.sort(([, a], [, b]) => {
    if (a.group !== b.group) return (a.group || '').localeCompare(b.group || '');
    return 0;
  });

  let currentGroup = '';
  for (const [name, account] of entries) {
    if (account.group && account.group !== currentGroup) {
      currentGroup = account.group;
      const groupHeader = document.createElement('div');
      groupHeader.style.cssText = 'font-size:11px;color:var(--text-secondary);padding:6px 4px 2px;';
      groupHeader.textContent = account.group;
      accountList.appendChild(groupHeader);
    }

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
    if (account.group) {
      meta.textContent += ` · ${account.group}`;
    }
    info.appendChild(meta);
    card.appendChild(info);

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

    card.addEventListener('click', () => {
      handleSwitchAccount(name, account);
    });

    accountList.appendChild(card);
  }
}

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
}

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
    const cookies = await getCookies(currentDomain);
    const lsData = await getTabLocalStorage(currentTabId);
    await saveAccount(currentDomain, name, cookies, lsData, '');

    if (cookies.length === 0) {
      showStatus(statusBar, `⚠️ 已保存「${name}」但没有读取到任何 Cookie。` +
        `可能缺少主机权限，请点击上方的「授权访问此网站」按钮`, 'error');
    } else {
      const lsKeys = Object.keys(lsData);
      showStatus(statusBar, `✓ 已保存「${name}」(${cookies.length} 个 Cookie)`);
    }
    inputName.value = '';
    await renderAccountList();
  } catch (e) {
    showStatus(statusBar, `保存失败：${e.message}`, 'error');
  } finally {
    btnSave.disabled = false;
    btnSave.textContent = '💾 保存当前账号';
  }
}

async function handleSwitchAccount(name, account) {
  const cookies = account.cookies || [];
  const lsData = account.localStorage || {};

  showStatus(statusBar, `⏳ 正在切换到「${name}」...`, 'success', 0);

  try {
    if (cookies.length > 0) {
      await applyCookies(currentDomain, cookies);
    }

    if (Object.keys(lsData).length > 0) {
      await setTabLocalStorage(currentTabId, lsData);
    }

    await chrome.tabs.reload(currentTabId);
    showStatus(statusBar, `✓ 已切换到「${name}」，页面正在刷新`);
  } catch (e) {
    showStatus(statusBar, `切换失败：${e.message}`, 'error');
  }
}

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

async function handleLoginNew() {
  if (!currentDomain) return;

  showStatus(statusBar, '⏳ 正在清除 Cookie...', 'success', 0);

  try {
    const beforeCookies = await getCookies(currentDomain);
    const result = await clearDomainCookies(currentDomain);
    await clearTabLocalStorage(currentTabId);
    await chrome.tabs.reload(currentTabId);

    if (result.failedCookies.length > 0) {
      const failedNames = result.failedCookies.map(f => f.name).join(', ');
      showStatus(statusBar,
        `⚠️ 成功移除 ${result.removed}/${result.total} 个 Cookie，` +
        `${result.failedCookies.length} 个移除失败：${failedNames}`,
        'error');
    } else if (result.removed > 0) {
      showStatus(statusBar, `✓ 已清除 ${result.removed} 个 Cookie，页面正在刷新`);
    } else {
      showStatus(statusBar, '⚠️ 没有 Cookie 被清除，可能缺少权限', 'error');
    }
  } catch (e) {
    showStatus(statusBar, `清除失败：${e.message}`, 'error');
  }
}
