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
    const { url, user, pass } = payload;
    const finalUrl = normalizeWebdavUrl(url);
    if (!isValidWebdavUrl(finalUrl)) throw new Error('URL 格式不正确（需 http/https）');
    // v2.9.0：保留份数/自动备份已移除，远端固定保留最新 1 份
    await saveWebdavConfig({ url: finalUrl, user, pass });
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
    // v2.11.2 兜底：合并后本地完全为空（无活跃账号也无墓碑）时跳过上传，
    // 防止异常路径（数据被外部物理清空 / 手动删库）把空备份传上去覆盖远端。
    // v2.11.4 语义修正后：正常「清空本地」走 data.clearAll 物理删库路径（本地无墓碑）→
    //   远端有备份时第一步已拉取合并恢复本地（totalEntries>0 正常上传）；
    //   远端无备份时 totalEntries=0 → 触发本兜底跳过上传 → 不会把空传上去。
    const rawData = await loadRawData();
    const totalEntries = Object.keys(rawData.accounts || {}).reduce(
      (n, d) => n + Object.keys(rawData.accounts[d] || {}).length, 0
    );
    if (totalEntries === 0) {
      result.pushed = null; // 本地无任何数据（含墓碑）：不上传，避免清空远端备份
      return result;
    }
    const filename = await webdavPush(cfg, JSON.stringify(data));
    // v2.11.3 修复：墓碑物理清理移到「上传成功之后」。
    // 原实现 purge 在 importData（第一步拉取合并）尾部触发——早于第二步上传，
    // 导致过期墓碑在"写入远端备份"前就被本地删除 → 上传内容不含墓碑 → 远端备份被覆盖丢失删除标记 →
    // 其他设备（本地有旧账号）同步时删除"复活"（mock 回归用例 7 复现）。
    // 现语义：墓碑先随本次上传写入远端备份，确认传播后再清理本地过期墓碑（TTL 30 天），
    // 与 §36「墓碑须存活足够久（传播删除）后被物理移除」一致。
    const rawAfter = await loadRawData();
    const purged = purgeOldTombstones(rawAfter);
    if (purged > 0) await saveRawData(rawAfter);
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
    return { ok: true };
  }
};
