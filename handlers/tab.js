/**
 * handlers/tab.js - 标签页 / 权限 action
 * 由 background.js 通过 importScripts 加载，导出 TAB_ACTIONS。
 */

const TAB_ACTIONS = {
  // ---- 当前标签页 ----
  'tab.getCurrent': async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !tab.url) return { supported: false, domain: '' };
    const url = tab.url;
    if (url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('about:')) {
      return { supported: false, domain: '' };
    }
    return { supported: true, domain: extractDomain(url), tabId: tab.id };
  },

  // ---- 刷新标签页（popup 收口用）----
  'tab.reload': async (payload) => {
    const { tabId } = payload;
    if (tabId) await chrome.tabs.reload(tabId);
    return { ok: true };
  },

  // ---- 权限检测（只读）----
  // 注意：permissions.request 必须在用户手势上下文（popup/options 页面）直接调用，
  // 不能经消息路由到 SW（SW 无手势 → "must be called during a user gesture"）。
  'permission.check': async (payload) => {
    const { domain } = payload;
    const url = `*://${domain}/*`;
    const has = await chrome.permissions.contains({ origins: [url] });
    return { granted: has };
  }
};
