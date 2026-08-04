/**
 * handlers/webdav.js - WebDAV 远程备份 action
 * 由 background.js 通过 importScripts 加载，导出 WEBDAV_ACTIONS。
 */

const WEBDAV_ACTIONS = {
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
};
