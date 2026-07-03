/**
 * Cookie Switcher - Background Service Worker
 * Handles context menus, keyboard commands, and lifecycle events.
 * Self-contained (no imports) for MV3 Service Worker compatibility.
 */

// ============================================================
//  Helpers (self-contained)
// ============================================================

function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function getCookieUrl(cookie) {
  return `${cookie.secure ? 'https' : 'http'}://${cookie.domain}${cookie.path || '/'}`;
}

function getCookies(domain) {
  return new Promise((resolve) => {
    chrome.cookies.getAll({ domain }, (cookies) => {
      resolve(cookies || []);
    });
  });
}

function setCookie(cookie) {
  return new Promise((resolve) => {
    chrome.cookies.set({
      url: getCookieUrl(cookie),
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      secure: !!cookie.secure,
      httpOnly: !!cookie.httpOnly,
      sameSite: cookie.sameSite || 'unspecified',
      expirationDate: cookie.expirationDate
    }, resolve);
  });
}

function removeCookie(cookie) {
  return new Promise((resolve) => {
    chrome.cookies.remove({ url: getCookieUrl(cookie), name: cookie.name }, resolve);
  });
}

async function clearDomainCookies(domain) {
  const cookies = await getCookies(domain);
  for (const c of cookies) {
    try { await removeCookie(c); } catch (e) { /* skip */ }
  }
}

// ============================================================
//  Installation
// ============================================================

chrome.runtime.onInstalled.addListener((details) => {
  // Create context menus (API may not be available in all browsers)
  try {
    chrome.contextMenus.create({
      id: 'switch-clear-cookies',
      title: '清除此站点 Cookie 并重新登录',
      contexts: ['page']
    });
  } catch (e) {
    console.log('contextMenus API not available:', e.message);
  }

  if (details.reason === 'install') {
    console.log('Cookie Switcher 已安装。按 Alt+Shift+S 快速打开。');
  }
});

// ============================================================
//  Context Menu
// ============================================================

if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab || !tab.url) return;

    const domain = extractDomain(tab.url);
    if (!domain) return;

    if (info.menuItemId === 'switch-clear-cookies') {
      await clearDomainCookies(domain);
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => localStorage.clear()
        });
      } catch (e) { /* non-critical */ }
      await chrome.tabs.reload(tab.id);
    }
  });
}

// ============================================================
//  Keyboard Commands
// ============================================================

chrome.commands.onCommand.addListener((command) => {
  // _execute_action is handled by browser natively (opens popup)
  console.log('Cookie Switcher: command triggered:', command);
});
