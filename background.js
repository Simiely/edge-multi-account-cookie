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
  // action 处理器（按域拆分；v2.11.1 起移除 account.js——
  // cookie 切换改回 popup 直调，不再走 SW 消息路由，见 DEVELOPMENT.md §25）
  'handlers/settings.js',
  'handlers/backup.js',
  'handlers/webdav.js'
);

// ============================================================
//  Helpers（自包含）
// ============================================================

const MENU_ROOT = 'switch-root';
const MENU_CLEAR = 'switch-clear-cookies';

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
      // v2.11.1：移除"切换到此站点账号"子菜单——contextMenus.onClicked 只能在 SW 响应，
      // 而 SW 上下文 cookies API 不可靠（getAll 读不到 cookie），切换会清不掉旧 cookie
      // 导致新旧会话混存、登录态失效。切换统一走 popup 直调（DEVELOPMENT.md §25 原则）。
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
      // v2.11.1：清除双保险——已保存账号的已知 cookie 逐个移除（remove 只需 url+name，
      // 不依赖 getAll，SW 上下文可靠）+ 全量清除（getAll 尽力而为，能清多少清多少）
      const accounts = await getDomainAccounts(domain);
      const seen = new Set();
      for (const name of Object.keys(accounts)) {
        const entry = accounts[name];
        if (!entry || !Array.isArray(entry.cookies)) continue;
        for (const c of entry.cookies) {
          const k = `${c.name}|${c.domain}|${c.path}`;
          if (seen.has(k)) continue;
          seen.add(k);
          try { await removeCookie(c); } catch (e) { /* ignore */ }
        }
      }
      const result = await clearDomainCookies(domain);
      // 数据一致性保护：cookie 清除存在失败时不刷 localStorage（防半退出）
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
  ...SETTINGS_ACTIONS,
  ...BACKUP_ACTIONS,
  ...WEBDAV_ACTIONS
});
