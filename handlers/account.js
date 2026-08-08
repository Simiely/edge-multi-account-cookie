/**
 * handlers/account.js - 账号切换 action（v2.9.x 重构）
 * 由 background.js 通过 importScripts 加载，导出 ACCOUNT_ACTIONS。
 * 切换核心复用 lib/cookies.js 的 switchAccount（popup 经消息层与右键菜单共用同一实现）。
 */

const ACCOUNT_ACTIONS = {
  // 主线切换：经消息层收口（与 webdav/backup/settings 一致）。
  // 页面层（popup）调用，SW 内重新读取账号并由 switchAccount 统一处理（含主密钥守卫）。
  'account.switch': async (payload) => {
    const { domain, name, tabId } = payload || {};
    if (!domain || !name) throw new Error('缺少 domain 或 name');
    const accounts = await getDomainAccounts(domain);
    const account = accounts && accounts[name];
    if (!account) throw new Error(`未找到账号「${name}」`);
    return switchAccount(domain, name, account, { tabId: tabId || 0, reload: true });
  }
};
