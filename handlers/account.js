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
    // 明文存储 cookie value（与浏览器自身 Cookies 数据库一致，避免 AES 加密膨胀超 4096 上限导致切换失效）
    // 安全性：备份/导出环节仍整包加密；本方案兼容旧 enc: 数据（applyCookies 解密逻辑保留）
    const cookies = await getCookies(domain);
    // 保存前清洗：同名 cookie 去重，防止多套会话混存（v2.7.0）
    const { deduped } = dedupeCookies(cookies);
    const plain = [];
    for (const c of deduped) {
      plain.push({
        name: c.name,
        value: String(c.value || ''),
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
    await saveAccount(domain, name, plain, lsData, group);
    return { saved: plain.length, lsKeys: Object.keys(lsData).length };
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
    // 切换后探测会话健康（v2.7.0）
    let health = null;
    try {
      const probe = await probeSession(domain, account.cookies || []);
      if (probe && probe.status) {
        await updateAccountHealth(domain, name, probe.status);
        health = probe.status;
      }
    } catch (e) { /* 探测失败不影响切换 */ }
    return { ...result, health };
  },

  'site.clear': async (payload) => {
    const { domain, tabId } = payload;
    const before = await getCookies(domain);
    const result = await clearDomainCookies(domain);
    // 数据一致性保护：cookie 清除存在失败时不刷 localStorage，避免"半退出"状态
    if (result.failedCookies.length === 0) {
      await clearTabLocalStorage(tabId);
    }
    return { before: before.length, ...result };
  }
};
