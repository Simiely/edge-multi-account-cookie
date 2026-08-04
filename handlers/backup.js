/**
 * handlers/backup.js - 本地备份 action
 * 由 background.js 通过 importScripts 加载，导出 BACKUP_ACTIONS。
 */

const BACKUP_ACTIONS = {
  'backup.export': async (payload) => {
    const { pin } = payload;
    return exportData(pin);
  },

  'backup.import': async (payload) => {
    const { blob, pin, mode } = payload;
    return importData(blob, pin, mode || 'merge');
  }
};
