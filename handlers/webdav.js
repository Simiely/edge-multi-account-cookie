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

  // v2.9.0：一键同步 = 先拉后传（双向收敛，smart 合并保证无损）
  //  - 拉：下载远端数据最新备份 → smart 合并进本地（同名账号取 updatedAt 最新，本地独有保留）
  //  - 传：导出合并后的本地全量 → 上传新文件（保留策略自动清理旧文件，数据已含全部最新，不丢）
  //  - 远端无备份（首次同步）→ 跳过拉取直接上传首份
  'webdav.sync': async () => {
    const cfg = await getWebdavConfigDecrypted();
    if (!cfg) throw new Error('请先配置 WebDAV');
    const result = { pulled: null, pushed: null };

    // 第一步：拉取远端最新备份并 smart 合并进本地
    try {
      const { filename, content, exportedAt, totalBackups } = await webdavPull(cfg);
      const outer = JSON.parse(content);
      const pull = await importData(outer.data, cfg.pass); // smart 合并（同名取最新）
      result.pulled = { filename, exportedAt, totalBackups, ...pull };
    } catch (e) {
      if (e && e.message === '远端没有备份文件') {
        result.pulled = null; // 首次同步：远端无备份，仅上传
      } else {
        throw e;
      }
    }

    // 第二步：导出合并后的本地全量并上传（含刚拉取的最新账号）
    const data = await exportData(cfg.pass);
    const filename = await webdavPush(cfg, JSON.stringify(data));
    const stored = await getWebdavConfig();
    if (stored) {
      stored.lastBackupAt = Date.now();
      await setWebdavConfig(stored);
    }
    result.pushed = { filename, path: `${backupDir(cfg)}/${filename}` };
    return result;
  },

  'webdav.remove': async () => {
    await clearWebdavConfig();
    await ensureBackupAlarm();
    return { ok: true };
  }
};
