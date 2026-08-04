/**
 * lib/backup.js - 备份层（本地导出/导入）
 *
 * 职责：
 *  - 本地导出（口令加密，AES-GCM）
 *  - 本地导入（merge 合并 / replace 覆盖 双模式）
 *
 * 依赖：lib/crypto.js + lib/storage.js
 */

/**
 * 导出全部数据（口令加密）。返回 { version, data }。
 * @param {string} pin - 用户输入的加密口令
 */
async function exportData(pin) {
  const data = await loadRawData();
  const json = JSON.stringify(data);
  const encrypted = await encrypt(json, pin);
  return { version: 3, data: encrypted };
}

/**
 * 导入数据。
 * @param {string} encryptedBlob - 加密内容
 * @param {string} pin - 解密口令
 * @param {string} mode - 'replace'（覆盖）| 'merge'（合并，同名账号跳过）
 * @returns {Promise<{imported:number, skipped:number}>}
 */
async function importData(encryptedBlob, pin, mode = 'merge') {
  const json = await decrypt(encryptedBlob, pin);
  const incoming = JSON.parse(json);
  const accountsIn = (incoming && incoming.accounts) || {};

  const countIncoming = () => {
    let n = 0;
    for (const d of Object.keys(accountsIn)) n += Object.keys(accountsIn[d]).length;
    return n;
  };

  if (mode === 'replace') {
    await saveRawData({ version: DATA_VERSION, accounts: accountsIn });
    return { imported: countIncoming(), skipped: 0 };
  }

  // merge：按域名合并，同名账号跳过保留现有
  const data = await loadRawData();
  let imported = 0;
  let skipped = 0;
  for (const domain of Object.keys(accountsIn)) {
    if (!data.accounts[domain]) data.accounts[domain] = {};
    for (const name of Object.keys(accountsIn[domain])) {
      if (data.accounts[domain][name]) { skipped++; continue; }
      data.accounts[domain][name] = accountsIn[domain][name];
      imported++;
    }
  }
  await saveRawData(data);
  return { imported, skipped };
}
