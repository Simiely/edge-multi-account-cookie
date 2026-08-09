/**
 * handlers/settings.js - 设置 / 密码锁 / 主密钥 action
 * 由 background.js 通过 importScripts 加载，导出 SETTINGS_ACTIONS。
 */

const SETTINGS_ACTIONS = {
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
    // 同步会话 PIN 缓存：设置/更换→缓存新 PIN；关闭→清除
    if (newPin) await cachePinInSession(newPin);
    else await clearPinSessionCache();
    return { ok: true };
  },

  'pin.unlock': async (payload) => {
    const r = await verifyPinWithLock(payload.pin || '');
    if (!r.ok) return r;
    // 解锁主密钥会话缓存（后续 cookie 加解密可用）
    await unlockMasterKey(payload.pin);
    // 缓存明文 PIN（备份导出/导入自动加解密用）
    await cachePinInSession(payload.pin);
    return r;
  },

  // ---- 主密钥可用性（WebDAV 前置检测）----
  'masterkey.available': async () => {
    const mk = await getMasterKey();
    return { available: !!mk };
  },

  // ---- 数据迁移（旧 enc: 加密 → 明文，幂等）----
  'data.migratePlain': async () => {
    return migratePlainValues();
  },

  // ---- 清空本地账号数据（保留密码锁 / WebDAV 配置）----
  'data.clearAll': async () => {
    // v2.11.2 修复：清空改为「墓碑化全部账号」，而非物理删除整个数据对象。
    // 原实现 chrome.storage.local.remove(STORAGE_KEY) 完全绕过墓碑机制，导致：
    //   ① 远端有备份时，同步拉取会把账号全部"复活"回本地（清空被撤销，远端无从得知你清空了）；
    //   ② 远端无备份时，同步会把空数据上传，远端备份被空覆盖 → 本地已清、远端也空 → 数据永久丢失。
    // 墓碑化后：清空可跨设备传播（同步时墓碑上传，其他设备同样隐藏删除）；
    // 本地墓碑 vs 远端旧账号（updatedAt < deletedAt）不会复活；导出/上传的是含墓碑的数据而非空。
    const data = await loadRawData();
    const now = Date.now();
    const accounts = data.accounts || {};
    let tombstoned = 0;
    for (const domain of Object.keys(accounts)) {
      for (const name of Object.keys(accounts[domain])) {
        const entry = accounts[domain][name];
        if (!entry) continue;
        accounts[domain][name] = {
          name: entry.name || name,
          createdAt: entry.createdAt || now,
          updatedAt: now,
          deleted: true,
          deletedAt: now
        };
        tombstoned++;
      }
    }
    data.accounts = accounts;
    await saveRawData(data);
    try {
      await chrome.storage.session.remove(MK_SESSION_KEY);
    } catch (e) { /* ignore */ }
    return { ok: true, tombstoned };
  }
};
