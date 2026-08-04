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
// 纯渲染函数（isAccountExpired/createGroupHeader/createAccountCard/showStatus）
// 已拆至 ui/popup-render.js —— 本文件只保留依赖共享状态的编排逻辑。

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
      accountList.appendChild(createGroupHeader(group, collapsedGroups));
      if (collapsedGroups.has(group)) continue;
    }

    accountList.appendChild(createAccountCard(name, account, group));
  }
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
  document.getElementById('btnWebdavPush').addEventListener('click', handleWebdavPush);
  document.getElementById('btnWebdavPull').addEventListener('click', handleWebdavPull);
}

// ============================================================
//  WebDAV 快捷备份（弹窗直传/下载，复用设置页 action）
// ============================================================

/**
 * 检查 WebDAV 是否已配置，未配置则引导去设置页。
 * @returns {Promise<boolean>} 已配置返回 true
 */
async function ensureWebdavConfigured() {
  const opts = await sendMessage('options.get');
  if (!opts.webdav) {
    showStatus(statusBar, '请先在设置页配置 WebDAV', 'error');
    setTimeout(() => chrome.runtime.openOptionsPage(), 1200);
    return false;
  }
  return true;
}

async function handleWebdavPush() {
  const btn = document.getElementById('btnWebdavPush');
  try {
    if (!(await ensureWebdavConfigured())) return;
    const mk = await sendMessage('masterkey.available');
    if (!mk.available) {
      showStatus(statusBar, '主密钥不可用：请先在设置页解锁密码锁', 'error');
      return;
    }
    btn.disabled = true;
    btn.textContent = '⏳ 上传中...';
    const r = await sendMessage('webdav.push');
    showStatus(statusBar, `✅ 已上传：${r.filename}`, 'success', 5000);
  } catch (e) {
    showStatus(statusBar, `上传失败：${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '📤 上传备份';
  }
}

async function handleWebdavPull() {
  const btn = document.getElementById('btnWebdavPull');
  try {
    if (!(await ensureWebdavConfigured())) return;
    const mk = await sendMessage('masterkey.available');
    if (!mk.available) {
      showStatus(statusBar, '主密钥不可用：请先在设置页解锁密码锁', 'error');
      return;
    }
    btn.disabled = true;
    btn.textContent = '⏳ 下载中...';
    const r = await sendMessage('webdav.pull', { mode: 'merge' });
    showStatus(statusBar, `✅ 已恢复：新增 ${r.imported} 个账号${r.skipped ? `，跳过 ${r.skipped}` : ''}`, 'success', 5000);
  } catch (e) {
    showStatus(statusBar, `下载失败：${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '📥 下载恢复';
  }
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
      await sendMessage('tab.reload', { tabId: currentTabId });
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
    await sendMessage('tab.reload', { tabId: currentTabId });
  } catch (e) {
    showStatus(statusBar, `清除失败：${e.message}`, 'error');
  }
}

// ============================================================
//  Helpers（showStatus 已拆至 ui/popup-render.js）
// ============================================================
