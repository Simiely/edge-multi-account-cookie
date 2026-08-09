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

  // ---- 清空本地账号数据（仅本机，不传播；保留密码锁 / WebDAV 配置）----
  'data.clearAll': async () => {
    // v2.11.4 语义修正：「清空本地」= 仅本机重置，不产生墓碑、不传播删除。
    //   与「逐账号删除」（墓碑传播到所有设备）严格区隔：
    //   - 清空本地：用户意图是丢弃本机副本、之后从网络端同步恢复 → 物理清空，同步时拉取远端备份恢复；
    //   - 删除账号：用户意图是该账号在所有设备都删除 → 走墓碑机制（deleteAccount）跨设备传播。
    // v2.11.2 曾把清空也墓碑化，导致"清空→同步→远端备份也被墓碑覆盖、其他设备全部清空"（用户实测反馈）。
    // 安全兜底：webdav.sync 上传前检查合并后条目（含墓碑）为 0 时跳过上传（pushed=null），
    //   防止「本地清空 + 远端无备份」时把空数据上传覆盖远端备份（§38 ② 的教训保留，兜底不变）。
    await chrome.storage.local.remove(STORAGE_KEY);
    try {
      await chrome.storage.session.remove(MK_SESSION_KEY);
    } catch (e) { /* ignore */ }
    return { ok: true, cleared: true };
  }
};
