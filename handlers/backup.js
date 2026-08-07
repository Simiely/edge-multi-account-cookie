/**
 * handlers/backup.js - 本地备份 action
 * 由 background.js 通过 importScripts 加载，导出 BACKUP_ACTIONS。
 *
 * 口令策略：
 *  - 设置了密码锁 → 用密码锁密码自动加密/解密（PIN 从会话缓存获取，未解锁则提示先解锁）
 *  - 未设置密码锁 → 由 UI 弹窗让用户输入口令（pin 由页面传入）
 */

const BACKUP_ACTIONS = {
  /**
   * 导出。优先自动用密码锁密码；无锁或无缓存时需 pin（UI 弹窗提供）。
   */
  'backup.export': async (payload) => {
    let pin = payload.pin;
    if (!pin) {
      const hasPin = await isPinSet();
      if (hasPin) {
        // 有锁：用会话缓存的 PIN（未解锁时 getCachedPin 为 null → 报错引导解锁）
        pin = await getCachedPin();
        if (!pin) throw new Error('请先在设置页输入密码锁密码解锁，再导出');
      } else {
        throw new Error('NEED_PIN'); // 无锁：UI 弹窗输入口令
      }
    }
    return exportData(pin);
  },

  /**
   * 导入。有锁时先自动尝试密码锁密码；失败则回退让用户输入（兼容历史备份）。
   * v2.7.4：默认智能合并（同名账号取最新），无需选择模式。
   */
  'backup.import': async (payload) => {
    const { blob, pin } = payload;
    // 有锁且未显式提供 pin → 尝试自动用密码锁密码
    if (!pin) {
      const hasPin = await isPinSet();
      if (hasPin) {
        const cached = await getCachedPin();
        if (cached) {
          try {
            return await importData(blob, cached);
          } catch (e) {
            // 密码锁密码解不开（可能是 WebDAV 密码或历史备份口令）→ 回退手动输入
            throw new Error('NEED_PIN');
          }
        }
        throw new Error('NEED_PIN');
      }
      throw new Error('NEED_PIN');
    }
    return importData(blob, pin);
  }
};
