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
  }
};
