/**
 * handlers/account.js - 账号 CRUD / 切换 / 清场 action
 * 由 background.js 通过 importScripts 加载，导出 ACCOUNT_ACTIONS。
 */

const ACCOUNT_ACTIONS = {
  // ---- 账号 CRUD ----
  'account.list': async (payload) => {
    const { domain } = payload;
    return getDomainAccounts(domain);
  },

  'account.save': async (payload) => {
    const { domain, name, group, tabId } = payload;
    const mk = await getMasterKey();
    if (!mk) throw new Error('主密钥不可用，请先解锁密码锁');
    const cookies = await getCookies(domain);
    const encrypted = [];
    for (const c of cookies) {
      const encValue = await encryptWithKey(String(c.value || ''), mk);
      encrypted.push({
        name: c.name,
        value: 'enc:' + encValue,
        domain: c.domain,
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        sameSite: c.sameSite || 'unspecified',
        expirationDate: c.expirationDate || undefined,
        partitionKey: c.partitionKey || undefined,
        storeId: c.storeId || undefined
      });
    }
    // 抓取当前标签页 localStorage（scripting 在 SW 侧执行）
    let lsData = {};
    if (tabId) {
      try { lsData = await getTabLocalStorage(tabId); } catch (e) { /* ignore */ }
    }
    await saveAccount(domain, name, encrypted, lsData, group);
    return { saved: encrypted.length, lsKeys: Object.keys(lsData).length };
  },

  'account.delete': async (payload) => {
    const { domain, name } = payload;
    await deleteAccount(domain, name);
    return { ok: true };
  },

  'account.rename': async (payload) => {
    const { domain, oldName, newName } = payload;
    const ok = await renameAccount(domain, oldName, newName);
    if (!ok) throw new Error('重命名失败：账号不存在或新名称已存在');
    return { ok: true };
  },

  'account.updateGroup': async (payload) => {
    const { domain, name, group } = payload;
    const data = await loadRawData();
    if (!data.accounts[domain] || !data.accounts[domain][name]) throw new Error('账号不存在');
    data.accounts[domain][name].group = group || '';
    data.accounts[domain][name].updatedAt = Date.now();
    await saveRawData(data);
    return { ok: true };
  },

  'account.updateLocalStorage': async (payload) => {
    const { domain, name, tabId } = payload;
    const ls = await getTabLocalStorage(tabId);
    const data = await loadRawData();
    if (!data.accounts[domain] || !data.accounts[domain][name]) throw new Error('账号不存在');
    data.accounts[domain][name].localStorage = ls;
    data.accounts[domain][name].updatedAt = Date.now();
    await saveRawData(data);
    return { ok: true, keys: Object.keys(ls).length };
  },

  // ---- 切换 / 清场 ----
  'account.switch': async (payload) => {
    const { domain, name, tabId } = payload;
    const accounts = await getDomainAccounts(domain);
    const account = accounts[name];
    if (!account) throw new Error('账号不存在');
    const mk = await getMasterKey();
    if (!mk) throw new Error('主密钥不可用：请先在弹窗中解锁密码锁');
    const result = await applyCookies(domain, account.cookies || []);
    if (Object.keys(account.localStorage || {}).length > 0) {
      await setTabLocalStorage(tabId, account.localStorage);
    }
    return result;
  },

  'site.clear': async (payload) => {
    const { domain, tabId } = payload;
    const before = await getCookies(domain);
    const result = await clearDomainCookies(domain);
    await clearTabLocalStorage(tabId);
    return { before: before.length, ...result };
  }
};
