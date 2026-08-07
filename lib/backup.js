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
 * 数据内附加元数据标记（v2.7.3）：exportedAt 导出时间、accountMeta 账号清单指纹，
 * 供下载恢复前核对新旧（避免旧备份覆盖新数据）。
 * @param {string} pin - 用户输入的加密口令
 */
async function exportData(pin) {
  const data = await loadRawData();
  // 元数据标记：只读附加，不改动账号数据本身
  const meta = {
    exportedAt: Date.now(),
    accountMeta: buildAccountMeta(data.accounts)
  };
  const json = JSON.stringify({ ...data, __meta: meta });
  const encrypted = await encrypt(json, pin);
  return { version: 3, data: encrypted };
}

/**
 * 生成账号清单指纹：{ domain: { name: { updatedAt, cookieCount } } }。
 * 用于下载恢复前与本地对比，判断远端是更新还是更旧。
 */
function buildAccountMeta(accounts) {
  const meta = {};
  for (const domain of Object.keys(accounts || {})) {
    meta[domain] = {};
    for (const name of Object.keys(accounts[domain])) {
      const e = accounts[domain][name];
      meta[domain][name] = {
        updatedAt: (e && e.updatedAt) || 0,
        cookieCount: (e && e.cookies && e.cookies.length) || 0
      };
    }
  }
  return meta;
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

/**
 * 解密备份内容并解析为数据结构（供预览核对）。
 * @param {string} encryptedBlob
 * @param {string} pin
 * @returns {Promise<{data:Object, meta:Object|null}>} data=账号数据结构, meta=导出元数据
 */
async function parseBackup(encryptedBlob, pin) {
  const json = await decrypt(encryptedBlob, pin);
  const parsed = JSON.parse(json);
  const { __meta, ...data } = parsed;
  return { data, meta: __meta || null };
}

/**
 * 对比远端备份与本地数据，生成差异清单（下载恢复前核对用）。
 * @param {Object} remoteData - 远端备份解析出的数据结构
 * @param {Object} remoteMeta - 远端备份的元数据（可能为 null，旧备份无标记）
 * @returns {Promise<{
 *   remoteExportedAt:number, remoteAccountCount:number,
 *   localAccountCount:number, localLatestUpdatedAt:number,
 *   remoteNewer:boolean,        // 远端整体比本地新？
 *   toAdd:Array<string>,        // 远端有、本地无（merge/replace 都会新增）
 *   toOverwrite:Array<string>,  // 两端都有、远端更新（replace 会覆盖本地；merge 会跳过）
 *   toSkip:Array<string>,       // 两端都有、本地与远端同或本地更新（merge 跳过保留本地）
 *   localOnly:Array<string>     // 本地有、远端无（replace 会丢失！merge 保留）
 * }>}
 */
async function diffBackup(remoteData, remoteMeta) {
  const localData = await loadRawData();
  const localAccounts = (localData && localData.accounts) || {};
  const remoteAccounts = (remoteData && remoteData.accounts) || {};

  const toAdd = [];
  const toOverwrite = [];
  const toSkip = [];
  const localOnly = [];
  let localAccountCount = 0;
  let localLatestUpdatedAt = 0;

  // 本地账号总览
  for (const domain of Object.keys(localAccounts)) {
    for (const name of Object.keys(localAccounts[domain])) {
      localAccountCount++;
      const u = (localAccounts[domain][name] && localAccounts[domain][name].updatedAt) || 0;
      if (u > localLatestUpdatedAt) localLatestUpdatedAt = u;
      if (!remoteAccounts[domain] || !remoteAccounts[domain][name]) {
        localOnly.push(`${domain}/${name}`);
      }
    }
  }

  // 远端账号对比
  for (const domain of Object.keys(remoteAccounts)) {
    for (const name of Object.keys(remoteAccounts[domain])) {
      const key = `${domain}/${name}`;
      const localEntry = localAccounts[domain] && localAccounts[domain][name];
      if (!localEntry) {
        toAdd.push(key);
        continue;
      }
      const remoteU = (remoteAccounts[domain][name] && remoteAccounts[domain][name].updatedAt) || 0;
      const localU = localEntry.updatedAt || 0;
      if (remoteU > localU + 1000) toOverwrite.push(key); // 远端更新 → replace 会覆盖
      else toSkip.push(key);                              // 本地更新/相同 → merge 保留本地
    }
  }

  const remoteAccountCount = Object.values(remoteAccounts).reduce((s, d) => s + Object.keys(d).length, 0);
  const remoteExportedAt = (remoteMeta && remoteMeta.exportedAt) || 0;

  return {
    remoteExportedAt,
    remoteAccountCount,
    localAccountCount,
    localLatestUpdatedAt,
    // 远端整体"更新"判定：远端导出时间 > 本地任何账号最近更新时间（粗略，用于危险提示）
    remoteNewer: remoteExportedAt > localLatestUpdatedAt,
    toAdd, toOverwrite, toSkip, localOnly
  };
}
