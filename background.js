/**
 * Cookie Switcher - Background Service Worker
 *
 * 职责：
 *  - importScripts 引入 lib/（顺序敏感：crypto → storage → cookies → security → backup → webdav → messaging）
 *  - 消息路由：所有 chrome.* 调用收口（sender 校验 + action 白名单）
 *  - 右键菜单：清除站点 Cookie + 动态二级"切换到此站点账号"
 *  - 快捷键 / 安装生命周期
 *  - chrome.alarms 定时 WebDAV 备份（onInstalled 重建）
 *
 * MV3 约束：监听器必须顶层同步注册；异步响应 return true。
 */

importScripts(
  'lib/crypto.js',
  'lib/storage.js',
  'lib/cookies.js',
  'lib/security.js',
  'lib/backup.js',
  'lib/webdav.js',
  'lib/messaging.js'
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
  ensureBackupAlarm();
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
      await clearDomainCookies(domain);
      await clearTabLocalStorage(tab.id);
      await chrome.tabs.reload(tab.id);
      log('log', `已清除 ${domain} 的 Cookie`);
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
  }
});

// ============================================================
//  消息路由（所有 chrome.* 调用收口于此）
// ============================================================

registerMessageHandler({
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

  // ---- 权限检测（只读）----
  // 注意：permissions.request 必须在用户手势上下文（popup/options 页面）直接调用，
  // 不能经消息路由到 SW（SW 无手势 → "must be called during a user gesture"）。
  'permission.check': async (payload) => {
    const { domain } = payload;
    const url = `*://${domain}/*`;
    const has = await chrome.permissions.contains({ origins: [url] });
    return { granted: has };
  },

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
  },

  // ---- 设置 ----
  'options.get': async () => {
    const [pinSet, webdav, mkWrapped] = await Promise.all([
      isPinSet(),
      getWebdavConfig(),
      isMasterKeyWrapped()
    ]);
    return { pinSet, webdav: webdav ? { ...webdav, passEnc: undefined } : null, mkWrapped };
  },

  // ---- 密码锁 ----
  'pin.verify': async (payload) => {
    return verifyPinWithLock(payload.pin || '');
  },

  'pin.set': async (payload) => {
    const { newPin, currentPin } = payload;
    const hasPin = await isPinSet();
    if (hasPin) {
      const r = await verifyPinWithLock(currentPin || '');
      if (!r.ok) throw new Error(r.locked ? '密码锁已锁定' : '当前密码错误');
    }
    await setPin(newPin || '', currentPin || '');
    return { ok: true };
  },

  'pin.unlock': async (payload) => {
    const r = await verifyPinWithLock(payload.pin || '');
    if (!r.ok) return r;
    // 解锁主密钥会话缓存（后续 cookie 加解密可用）
    await unlockMasterKey(payload.pin);
    return r;
  },

  // ---- 主密钥可用性（WebDAV 前置检测）----
  'masterkey.available': async () => {
    const mk = await getMasterKey();
    return { available: !!mk };
  },

  // ---- 备份 ----
  'backup.export': async (payload) => {
    const { pin } = payload;
    return exportData(pin);
  },

  'backup.import': async (payload) => {
    const { blob, pin, mode } = payload;
    return importData(blob, pin, mode || 'merge');
  },

  // ---- WebDAV ----
  'webdav.test': async (payload) => {
    const { url, user, pass } = payload;
    if (!isValidWebdavUrl(url)) throw new Error('URL 格式不正确（需 http/https）');
    return webdavTest({ url, user, pass });
  },

  'webdav.save': async (payload) => {
    const { url, user, pass, keep, schedule, schedulePeriod } = payload;
    if (!isValidWebdavUrl(url)) throw new Error('URL 格式不正确（需 http/https）');
    await saveWebdavConfig({ url, user, pass, keep, schedule, schedulePeriod });
    await ensureBackupAlarm();
    return { ok: true };
  },

  'webdav.push': async (payload) => {
    const cfg = await getWebdavConfigDecrypted();
    if (!cfg) throw new Error('请先配置 WebDAV');
    const data = await exportData(cfg.pass); // 备份文件口令 = WebDAV 密码
    const filename = await webdavPush(cfg, JSON.stringify(data));
    const stored = await getWebdavConfig();
    if (stored) {
      stored.lastBackupAt = Date.now();
      await setWebdavConfig(stored);
    }
    return { filename };
  },

  'webdav.pull': async (payload) => {
    const { mode } = payload;
    const cfg = await getWebdavConfigDecrypted();
    if (!cfg) throw new Error('请先配置 WebDAV');
    const { filename, content } = await webdavPull(cfg);
    const parsed = JSON.parse(content);
    // 备份文件用 WebDAV 密码加密，直接解密（口令在 SW 内存，不落盘）
    const result = await importData(parsed.data, cfg.pass, mode || 'merge');
    return { filename, ...result };
  },

  'webdav.remove': async () => {
    await clearWebdavConfig();
    await ensureBackupAlarm();
    return { ok: true };
  }
});
