/**
 * Cookie Switcher - Background Service Worker
 *
 * 职责：
 *  - importScripts 引入 lib/（顺序敏感：crypto → storage → cookies → security → backup → webdav → messaging）
 *  - importScripts 引入 handlers/（tab → account → settings → backup → webdav），合并注册消息路由
 *  - 右键菜单：清除站点 Cookie + 动态二级"切换到此站点账号"
 *  - 快捷键 / 安装生命周期
 *  - chrome.alarms 定时 WebDAV 备份（onInstalled 重建）
 *
 * MV3 约束：监听器必须顶层同步注册；异步响应 return true。
 */

importScripts(
  // lib 核心层
  'lib/crypto.js',
  'lib/storage.js',
  'lib/cookies.js',
  'lib/health.js',
  'lib/security.js',
  'lib/backup.js',
  'lib/webdav.js',
  'lib/messaging.js',
  // action 处理器（按域拆分）
  'handlers/tab.js',
  'handlers/account.js',
  'handlers/settings.js',
  'handlers/backup.js',
  'handlers/webdav.js'
);

// ============================================================
//  Helpers（自包含）
// ============================================================

const MENU_ROOT = 'switch-root';
const MENU_CLEAR = 'switch-clear-cookies';
const MENU_SWITCH_PREFIX = 'switch-account-';

function log(level, msg) {
  console[level](`[CookieSwitcher] ${msg}`);
}

// ============================================================
//  WebDAV 定时备份
// ============================================================

async function ensureBackupAlarm() {
  try {
    const cfg = await getWebdavConfig();
    if (!cfg || !cfg.schedule || cfg.schedule === 'manual' || !cfg.schedulePeriod) {
      chrome.alarms.clear('webdav-backup');
      return;
    }
    const period = Math.max(60, Number(cfg.schedulePeriod) || 1440); // 分钟，最小 60
    chrome.alarms.create('webdav-backup', { delayInMinutes: period, periodInMinutes: period });
  } catch (e) { /* ignore */ }
}

/**
 * 每日会话体检（v2.7.0）：遍历所有账号，探测 Keycloak 类会话存活状态并更新 health。
 * 注意：SW 上下文 fetch 跨域需 host_permissions；未授权域名探测失败返回 unknown，
 *       不误报为失效（与 popup 直调探测共用 lib/health.js 逻辑）。
 */
async function runSessionHealthCheck() {
  try {
    const data = await loadRawData();
    const accounts = data.accounts || {};
    let checked = 0, ok = 0, expired = 0, unknown = 0;
    for (const domain of Object.keys(accounts)) {
      for (const name of Object.keys(accounts[domain])) {
        const entry = accounts[domain][name];
        if (!entry || !Array.isArray(entry.cookies) || entry.cookies.length === 0) continue;
        const probe = await probeSession(domain, entry.cookies);
        if (probe && probe.status) {
          await updateAccountHealth(domain, name, probe.status);
          checked++;
          if (probe.status === 'ok') ok++;
          else if (probe.status === 'expired') expired++;
          else unknown++;
        }
      }
    }
    log('log', `会话体检完成：检查 ${checked}（有效 ${ok} / 失效 ${expired} / 未知 ${unknown}）`);
  } catch (e) {
    log('warn', `会话体检失败：${e.message}`);
  }
}

async function runWebdavBackup() {
  try {
    const cfg = await getWebdavConfigDecrypted();
    if (!cfg) { log('warn', 'WebDAV 备份跳过：无配置或主密钥不可用'); return; }
    const data = await exportData(cfg.pass); // 用 WebDAV 密码加密导出
    const filename = await webdavPush(cfg, JSON.stringify(data));
    // 仅更新 lastBackupAt，避免覆盖 passEnc 等字段
    const stored = await getWebdavConfig();
    if (stored) {
      stored.lastBackupAt = Date.now();
      await setWebdavConfig(stored);
    }
    log('log', `WebDAV 备份完成：${filename}`);
  } catch (e) {
    log('error', `WebDAV 自动备份失败：${e.message}`);
  }
}

// ============================================================
//  右键菜单
// ============================================================

function rebuildContextMenus() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: MENU_ROOT,
        title: 'Cookie Switcher',
        contexts: ['page']
      });
      chrome.contextMenus.create({
        id: MENU_CLEAR,
        parentId: MENU_ROOT,
        title: '清除此站点 Cookie 并重新登录',
        contexts: ['page']
      });
      // 动态子菜单：当前站点已保存账号
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tab = tabs[0];
        if (!tab || !tab.url) return;
        const domain = extractDomain(tab.url);
        if (!domain) return;
        const accounts = await getDomainAccounts(domain);
        const names = Object.keys(accounts);
        if (names.length === 0) return;
        chrome.contextMenus.create({
          id: MENU_SWITCH_PREFIX + 'header',
          parentId: MENU_ROOT,
          title: '切换到此站点账号',
          enabled: false,
          contexts: ['page']
        });
        for (const name of names.slice(0, 8)) { // 最多 8 个，避免菜单过长
          // 健康标记（v2.7.0）：失效账号标题加 ⚠
          const acc = accounts[name] || {};
          const title = acc.health === 'expired' ? `⚠️ ${name}（会话失效）` : name;
          chrome.contextMenus.create({
            id: MENU_SWITCH_PREFIX + name,
            parentId: MENU_ROOT,
            title,
            contexts: ['page']
          });
        }
      });
    });
  } catch (e) {
    log('warn', 'contextMenus API 不可用：' + e.message);
  }
}

// ============================================================
//  安装 / 更新
// ============================================================

chrome.runtime.onInstalled.addListener((details) => {
  rebuildContextMenus();
  ensureBackupAlarm();
  // 每日会话体检（v2.7.0）：24h 后首检，之后每 24h 一次
  chrome.alarms.create('session-health-check', { delayInMinutes: 24 * 60, periodInMinutes: 24 * 60 });
  // 清理已被移除功能的遗留数据（白名单）
  chrome.storage.local.remove('cookie_switcher_whitelist').catch(() => {});
  if (details.reason === 'install') {
    log('log', 'Cookie Switcher 已安装。按 Alt+Shift+S 快速打开。');
  }
});

// ============================================================
//  右键菜单点击
// ============================================================

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.url) return;
  const domain = extractDomain(tab.url);
  if (!domain) return;

  if (info.menuItemId === MENU_CLEAR) {
    try {
      const result = await clearDomainCookies(domain);
      // 数据一致性保护：cookie 清除存在失败时不刷 localStorage
      if (result.failedCookies.length === 0) {
        await clearTabLocalStorage(tab.id);
      }
      await chrome.tabs.reload(tab.id);
      log('log', `已清除 ${domain} 的 Cookie${result.failedCookies.length ? `（${result.failedCookies.length} 个失败）` : ''}`);
    } catch (e) {
      log('error', `清除失败：${e.message}`);
    }
    return;
  }

  if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith(MENU_SWITCH_PREFIX)) {
    const name = info.menuItemId.slice(MENU_SWITCH_PREFIX.length);
    if (name === 'header') return;
    try {
      const accounts = await getDomainAccounts(domain);
      const account = accounts[name];
      if (!account) return;
      const mk = await getMasterKey();
      if (!mk) { log('warn', '切换失败：主密钥不可用，请先在弹窗解锁'); return; }
      const result = await applyCookies(domain, account.cookies || []);
      if (Object.keys(account.localStorage || {}).length > 0) {
        await setTabLocalStorage(tab.id, account.localStorage);
      }
      await chrome.tabs.reload(tab.id);
      log('log', `已切换到「${name}」：${JSON.stringify(result)}`);
    } catch (e) {
      log('error', `切换失败：${e.message}`);
    }
  }
});

// ============================================================
//  快捷键
// ============================================================

chrome.commands.onCommand.addListener((command) => {
  log('log', 'command triggered: ' + command);
});

// ============================================================
//  定时备份
// ============================================================

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'webdav-backup') {
    runWebdavBackup();
  } else if (alarm.name === 'session-health-check') {
    runSessionHealthCheck();
  }
});

// ============================================================
//  消息路由（合并各 handlers 的 action 表）
// ============================================================

registerMessageHandler({
  ...TAB_ACTIONS,
  ...ACCOUNT_ACTIONS,
  ...SETTINGS_ACTIONS,
  ...BACKUP_ACTIONS,
  ...WEBDAV_ACTIONS
});
