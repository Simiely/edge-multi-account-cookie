/**
 * Cookie Switcher - Background Service Worker
 *
 * 职责：
 *  - importScripts 引入 lib/（顺序敏感：crypto → storage → cookies → security → backup → webdav → messaging）
 *  - importScripts 引入 handlers/（account → settings → backup → webdav），合并注册消息路由
 *  - 右键菜单：清除站点 Cookie + 动态二级"切换到此站点账号"
 *  - 快捷键 / 安装生命周期
 *
 * MV3 约束：监听器必须顶层同步注册；异步响应 return true。
 */

importScripts(
  // lib 核心层
  'lib/crypto.js',
  'lib/storage.js',
  'lib/cookies.js',
  'lib/security.js',
  'lib/backup.js',
  'lib/webdav.js',
  'lib/messaging.js',
  // action 处理器（按域拆分；account 为 v2.9.x 重构重新引入的切换 action）
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
          chrome.contextMenus.create({
            id: MENU_SWITCH_PREFIX + name,
            parentId: MENU_ROOT,
            title: name,
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
      // 共享切换核心（与 popup 经消息层调用的同一实现）：写 cookie + localStorage + reload
      await switchAccount(domain, name, account, { tabId: tab.id, reload: true });
      log('log', `已切换到「${name}」`);
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
//  消息路由（合并各 handlers 的 action 表）
// ============================================================

registerMessageHandler({
  ...ACCOUNT_ACTIONS,
  ...SETTINGS_ACTIONS,
  ...BACKUP_ACTIONS,
  ...WEBDAV_ACTIONS
});
