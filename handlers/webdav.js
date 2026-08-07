/**
 * handlers/webdav.js - WebDAV 远程备份 action
 * 由 background.js 通过 importScripts 加载，导出 WEBDAV_ACTIONS。
 */

const WEBDAV_ACTIONS = {
  'webdav.test': async (payload) => {
    // URL 留空 → 默认服务器；无协议 → 自动补 http://
    const url = normalizeWebdavUrl(payload.url);
    let { user, pass } = payload;
    // 用户名/密码留空 → 复用已保存配置（已保存过时，密码框留空即可测试）
    if (!user || !pass) {
      const saved = await getWebdavConfigDecrypted();
      if (saved) {
        user = user || saved.user;
        pass = pass || saved.pass;
      }
    }
    if (!user || !pass) throw new Error('请填写用户名与密码');
    if (!isValidWebdavUrl(url)) throw new Error('URL 格式不正确（需 http/https）');
    return webdavTest({ url, user, pass });
  },

  'webdav.save': async (payload) => {
    const { url, user, pass, keep, schedule, schedulePeriod } = payload;
    const finalUrl = normalizeWebdavUrl(url);
    if (!isValidWebdavUrl(finalUrl)) throw new Error('URL 格式不正确（需 http/https）');
    await saveWebdavConfig({ url: finalUrl, user, pass, keep, schedule, schedulePeriod });
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
    // 返回完整远端路径，便于 UI 确认实际存储位置
    return { filename, path: `${backupDir(cfg)}/${filename}` };
  },

  'webdav.pull': async () => {
    const cfg = await getWebdavConfigDecrypted();
    if (!cfg) throw new Error('请先配置 WebDAV');
    const { filename, content } = await webdavPull(cfg);
    const parsed = JSON.parse(content);
    // 备份文件用 WebDAV 密码加密，直接解密（口令在 SW 内存，不落盘）
    // v2.7.4：智能合并（同名账号取最新），无需选择模式
    const result = await importData(parsed.data, cfg.pass);
    return { filename, ...result };
  },

  // v2.7.3：下载最新备份并做差异核对预览（不导入），供 UI 确认后再 pull
  'webdav.preview': async () => {
    const cfg = await getWebdavConfigDecrypted();
    if (!cfg) throw new Error('请先配置 WebDAV');
    const { filename, content } = await webdavPull(cfg);
    // 备份外层结构 { version, data }；data 为加密串
    const outer = JSON.parse(content);
    const { data, meta } = await parseBackup(outer.data, cfg.pass);
    const diff = await diffBackup(data, meta);
    return { filename, ...diff };
  },

  'webdav.remove': async () => {
    await clearWebdavConfig();
    await ensureBackupAlarm();
    return { ok: true };
  }
};
