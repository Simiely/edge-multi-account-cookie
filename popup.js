/**
 * Cookie Switcher - Popup Script
 * 全部操作经 lib/messaging.js 走 Service Worker（权限集中、WebDAV 前置）。
 */

let currentDomain = '';
let currentTabId = -1;
let currentAccountName = null; // 当前使用的已保存账号（v2.8.0，用于身份区显示与卡片高亮）
let unlocked = false;

const $ = (id) => document.getElementById(id);
const inputName = $('inputName');
const btnSaveConfirm = $('btnSaveConfirm');
const btnRefresh = $('btnRefresh');
const btnOptions = $('btnOptions');
const btnLoginNew = $('btnLoginNew');
const statusBar = $('statusBar');
const accountList = $('accountList');
const emptyState = $('emptyState');
const sectionTitle = $('sectionTitle');
const healthLegend = $('healthLegend');
const lockOverlay = $('lockOverlay');
const lockInput = $('lockInput');
const btnUnlock = $('btnUnlock');
const lockMsg = $('lockMsg');

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

/**
 * 匹配当前浏览器 cookie 对应哪个已保存账号（v2.8.0）。
 * 规则：逐个账号比对 name+value 相同的 cookie 数，命中数 >= 该账号保存数的一半才算匹配。
 * @returns {Promise<string|null>} 匹配的账号名；无权限/无账号/无命中返回 null
 */
async function matchCurrentAccount() {
  try {
    const [cookies, accounts] = await Promise.all([getCookies(currentDomain), getDomainAccounts(currentDomain)]);
    if (!cookies || cookies.length === 0) return null;
    const entries = Object.entries(accounts || {});
    if (entries.length === 0) return null;
    let best = null, bestScore = 0;
    for (const [name, account] of entries) {
      const saved = account.cookies || [];
      if (saved.length === 0) continue;
      let score = 0;
      for (const sc of saved) {
        if (!sc.value) continue;
        for (const cc of cookies) {
          if (cc.name === sc.name && cc.value === sc.value) { score++; break; }
        }
      }
      if (score > bestScore) { bestScore = score; best = name; }
    }
    if (!best) return null;
    const threshold = Math.max(1, Math.ceil((accounts[best].cookies || []).length / 2));
    return bestScore >= threshold ? best : null;
  } catch (e) {
    return null;
  }
}

/**
 * 统一刷新身份区：授权后匹配当前账号并渲染（v2.8.0）。
 */
async function refreshIdentity(granted, sub) {
  if (granted && currentDomain) {
    currentAccountName = await matchCurrentAccount();
  } else {
    currentAccountName = null;
  }
  renderIdentity({
    domain: currentDomain,
    sub,
    currentAccount: currentAccountName,
    avatarChar: (currentDomain || '').charAt(0),
    granted
  });
}

async function initCurrentTab() {
  // popup 直调 tab 查询（v2.2 方式；不依赖 SW）
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) {
    currentAccountName = null;
    renderIdentity({ granted: null, sub: '' });
    btnLoginNew.disabled = true;
    return;
  }
  const domain = extractDomain(tab.url);
  currentDomain = domain;
  currentTabId = tab.id;
  renderIdentity({ domain, sub: 'Cookie Switcher', avatarChar: domain.charAt(0) });

  if (!domain) return;

  await verifyCookieAccess();
}

async function verifyCookieAccess() {
  try {
    const url = `*://${currentDomain}/*`;
    const hasPerm = await chrome.permissions.contains({ origins: [url] });
    if (hasPerm) {
      await refreshIdentity(true, 'Cookie Switcher');
    } else {
      currentAccountName = null;
      renderIdentity({ domain: currentDomain, sub: '未授权 · 点击下方授权', avatarChar: currentDomain.charAt(0), granted: false });
      renderGrantBanner(currentDomain, requestHostPermission);
      btnLoginNew.disabled = true;
    }
  } catch (e) {
    // permissions API 不可用，静默继续
    await refreshIdentity(true, 'Cookie Switcher');
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
      hideGrantBanner();
      await refreshIdentity(true, 'Cookie Switcher');
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
// 纯渲染函数（createAccountCard/showStatus）
// 已拆至 ui/popup-render.js —— 本文件只保留依赖共享状态的编排逻辑。

async function renderAccountList() {
  accountList.innerHTML = '';
  if (!currentDomain) {
    emptyState.style.display = 'block';
    sectionTitle.textContent = '已保存的账号';
    healthLegend.style.display = 'none';
    return;
  }

  const accounts = await getDomainAccounts(currentDomain);
  const entries = Object.entries(accounts);

  if (entries.length === 0) {
    emptyState.style.display = 'block';
    sectionTitle.textContent = '已保存的账号';
    healthLegend.style.display = 'none';
    return;
  }

  emptyState.style.display = 'none';
  sectionTitle.textContent = `已保存的账号（${entries.length}）`;
  healthLegend.style.display = 'flex';

  // 稳定排序：updatedAt 降序（最近保存/更新的排前面）
  entries.sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0));

  for (const [name, account] of entries) {
    // 行为回调注入（v2.8.0）：popup-render.js 为纯视图，操作函数由本文件传入
    const card = createAccountCard(name, account, {
      onEdit: handleEditAccount,
      onSwitch: handleSwitchAccount,
      onDelete: handleDeleteAccount
    });
    // 当前正在使用的账号高亮（v2.8.0）
    if (name === currentAccountName) card.classList.add('active');
    accountList.appendChild(card);
  }
}

// ============================================================
//  事件绑定
// ============================================================

function bindEvents() {
  // 保存：顶部常驻面板（v2.8.0）——输入框回车 / 保存按钮均可触发
  inputName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSaveAccount();
  });
  btnSaveConfirm.addEventListener('click', handleSaveAccount);
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
  document.getElementById('btnWebdavSync').addEventListener('click', handleWebdavSync);
}

// ============================================================
//  WebDAV 快捷同步（弹窗一键同步，复用设置页 action）
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

/**
 * v2.9.0：一键同步 = 先拉远端最新合并进本地 → 再上传合并后的全量（双向收敛，无损）。
 */
async function handleWebdavSync() {
  const btn = document.getElementById('btnWebdavSync');
  try {
    if (!(await ensureWebdavConfigured())) return;
    const mk = await sendMessage('masterkey.available');
    if (!mk.available) {
      showStatus(statusBar, '主密钥不可用：请先在设置页解锁密码锁', 'error');
      return;
    }
    btn.disabled = true;
    btn.textContent = '⏳ 同步中...';
    const r = await sendMessage('webdav.sync');
    const parts = [];
    if (r.pulled) {
      const p = r.pulled;
      const acts = [];
      if (p.imported) acts.push(`新增 ${p.imported}`);
      if (p.updated) acts.push(`更新 ${p.updated}`);
      if (p.skipped) acts.push(`保留 ${p.skipped} 个本地更新`);
      parts.push(`拉取 ${acts.length ? acts.join('、') : '无变化'}`);
    } else {
      parts.push('远端无备份，已创建首份');
    }
    parts.push(`上传 ${r.pushed.filename}`);
    showStatus(statusBar, `✅ 同步完成：${parts.join('；')}`, 'success', 6000);
  } catch (e) {
    showStatus(statusBar, `同步失败：${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 一键同步';
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

  // 保存忙碌态（图标 div 置灰）
  setSaveBusy(true);

  try {
    // popup 直调（修复：SW 上下文 cookies.getAll 读不到 cookie）：
    // 在 popup 上下文读 cookie（activeTab + 持久授权均可用）+ 抓 localStorage + 落库
    // v2.7.2 修复：恢复原样保存——getCookies 已按 name|domain|path 去重；
    // 勿按 name 再删（域 cookie 与 host-only cookie 需并存，删除会导致登录失败）
    const cookies = await getCookies(currentDomain);

    let lsData = {};
    if (currentTabId > 0) {
      try { lsData = await getTabLocalStorage(currentTabId); } catch (e) { /* ignore */ }
    }
    await saveAccount(currentDomain, name, cookies, lsData, '');

    if (cookies.length === 0) {
      showStatus(statusBar, `⚠️ 已保存「${name}」但没有读取到任何 Cookie。可能缺少主机权限，请点击「授权访问此网站」`, 'error');
    } else {
      showStatus(statusBar, `✓ 已保存「${name}」(${cookies.length} 个 Cookie${Object.keys(lsData).length ? ` + ${Object.keys(lsData).length} 项页面数据` : ''})`);
    }
    inputName.value = '';
    // v2.8.0：保存的面板常驻顶部（无需收起）；刚保存的账号即当前使用
    currentAccountName = name;
    await refreshIdentity(true, 'Cookie Switcher');
    await renderAccountList();
  } catch (e) {
    showStatus(statusBar, `保存失败：${e.message}`, 'error');
  } finally {
    setSaveBusy(false);
  }
}

async function handleSwitchAccount(name, account) {
  showStatus(statusBar, `⏳ 正在切换到「${name}」...`, 'success', 0);

  try {
    // popup 直调（修复 SW 读不到 cookie）：清旧 + 写新 + localStorage，都在 popup 上下文
    const r = await applyCookies(currentDomain, account.cookies || []);
    if (Object.keys(account.localStorage || {}).length > 0 && currentTabId > 0) {
      await setTabLocalStorage(currentTabId, account.localStorage);
    }

    // 简化提示：成功/失败两态，不展示过期/回滚等细节（用户要求）
    if (r.failed.length > 0 || r.snapshotFailed) {
      showStatus(statusBar, `「${name}」使用失败`, 'error');
      return;
    }

    showStatus(statusBar, `✓ 已切换到「${name}」`, 'success');
    // v2.7.3 修复：先 reload 让登录立即生效（与 v2.6.0 行为一致），探测放后台异步执行，绝不阻塞刷新
    if (currentTabId > 0) await chrome.tabs.reload(currentTabId);
    // v2.8.0：切换成功的账号即当前使用（reload 后 cookie 已生效）
    currentAccountName = name;
    await refreshIdentity(true, 'Cookie Switcher');
    await renderAccountList(); // 刷新健康徽标 + 当前账号高亮

    // 后台异步探测（fire-and-forget，不 await、不阻塞切换与刷新）
    probeSessionHealthAsync(currentDomain, name, account.cookies || []);
  } catch (e) {
    showStatus(statusBar, `「${name}」使用失败`, 'error');
  }
}

/**
 * 后台异步会话健康探测（v2.7.3）：切换/刷新完成后再探测，绝不阻塞登录。
 * 探测内部自带超时，失败静默降级。
 */
function probeSessionHealthAsync(domain, name, cookies) {
  try {
    Promise.resolve(probeSession(domain, cookies)).then((probe) => {
      if (!probe || !probe.status) return;
      if (probe.status === 'ok') {
        return updateAccountHealth(domain, name, 'ok');
      }
      // expired/unknown：切换成功说明 cookie 被接受，重置 unknown 清除旧红点
      return updateAccountHealth(domain, name, 'unknown');
    }).catch(() => { /* 探测失败不影响切换 */ });
  } catch (e) { /* ignore */ }
}

async function handleDeleteAccount(name) {
  if (!confirm(`确定要删除「${name}」的账号数据吗？`)) return;
  try {
    await deleteAccount(currentDomain, name);
    showStatus(statusBar, `✓ 已删除「${name}」`);
    // v2.8.0：删除的是当前账号 → 重置身份区显示
    if (currentAccountName === name) {
      currentAccountName = null;
      await refreshIdentity(true, 'Cookie Switcher');
    }
    await renderAccountList();
  } catch (e) {
    showStatus(statusBar, `删除失败：${e.message}`, 'error');
  }
}

async function handleEditAccount(name) {
  const accounts = await getDomainAccounts(currentDomain);
  const account = accounts[name];
  if (!account) return;

  const newName = prompt('重命名账号（留空则保持不变）：', name);
  if (newName !== null && newName.trim() && newName.trim() !== name) {
    const renamed = await renameAccount(currentDomain, name, newName.trim()).catch(() => false);
    if (renamed) {
      // v2.8.0：重命名的是当前账号 → 同步身份区显示
      if (currentAccountName === name) {
        currentAccountName = newName.trim();
        await refreshIdentity(true, 'Cookie Switcher');
      }
      await renderAccountList();
    }
  }
}

async function handleLoginNew() {
  if (!currentDomain) return;

  showStatus(statusBar, '⏳ 正在清除 Cookie...', 'success', 0);

  try {
    // popup 直调（修复 SW 读不到 cookie）：清 cookie + localStorage 都在 popup 上下文
    const r = await clearDomainCookies(currentDomain);
    if (r.failedCookies.length === 0 && currentTabId > 0) {
      await clearTabLocalStorage(currentTabId);
    }

    if (r.failedCookies.length > 0) {
      const failedNames = r.failedCookies.map((f) => f.name).join(', ');
      showStatus(statusBar,
        `⚠️ 成功移除 ${r.removed}/${r.total} 个 Cookie，${r.failedCookies.length} 个移除失败：${failedNames}（页面数据未清除）`,
        'error');
    } else if (r.removed > 0) {
      showStatus(statusBar, `✓ 已清除 ${r.removed} 个 Cookie，页面正在刷新`);
    } else {
      showStatus(statusBar, '⚠️ 没有 Cookie 被清除，可能缺少权限', 'error');
    }
    if (currentTabId > 0) await chrome.tabs.reload(currentTabId);
    // v2.8.0：清 cookie 后不再匹配任何已保存账号
    currentAccountName = null;
    await refreshIdentity(true, 'Cookie Switcher');
    await renderAccountList();
  } catch (e) {
    showStatus(statusBar, `清除失败：${e.message}`, 'error');
  }
}

// ============================================================
//  Helpers（showStatus 已拆至 ui/popup-render.js）
// ============================================================
