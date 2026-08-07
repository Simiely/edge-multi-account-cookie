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
 * 导入数据（v2.7.4 智能合并：默认 smart，同名账号取 updatedAt 更新的那份，双向同步）。
 * @param {string} encryptedBlob - 加密内容
 * @param {string} pin - 解密口令
 * @param {string} [mode] - 'smart'（默认，同名取新）| 'replace'（覆盖，兼容旧逻辑）
 * @returns {Promise<{imported:number, updated:number, skipped:number}>}
 */
async function importData(encryptedBlob, pin, mode = 'smart') {
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
    return { imported: countIncoming(), updated: 0, skipped: 0 };
  }

  // smart：按域名合并；同名账号比较 updatedAt，取更新的（双向同步，不覆盖新数据）
  // v2.10.0 墓碑：删除标记（{deleted:true, deletedAt}）随备份传播——
  //   · 远端活跃 vs 本地墓碑：远端 updatedAt > 墓碑时间 → 复活（删除后又保存过新数据）；否则保持墓碑
  //   · 远端墓碑 vs 本地活跃：本地 updatedAt > 墓碑时间 → 保留本地（删除不生效）；否则本地也标墓碑
  //   · 远端墓碑 vs 本地无：导入墓碑（幂等传播删除）
  const data = await loadRawData();
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let resurrected = 0; // 复活（远端新数据覆盖本地墓碑）
  let tombstoned = 0;  // 标记删除（删除传播）
  for (const domain of Object.keys(accountsIn)) {
    if (!data.accounts[domain]) data.accounts[domain] = {};
    for (const name of Object.keys(accountsIn[domain])) {
      const inc = accountsIn[domain][name];
      const existing = data.accounts[domain][name];
      const incDeleted = !!(inc && inc.deleted);
      const exDeleted = !!(existing && existing.deleted);

      if (!existing) {
        // 本地无 → 导入（远端墓碑也导入，幂等传播删除）
        data.accounts[domain][name] = inc;
        if (incDeleted) tombstoned++; else imported++;
        continue;
      }

      if (incDeleted) {
        // 远端是墓碑
        if (exDeleted) { skipped++; continue; } // 双方都墓碑
        const exU = existing.updatedAt || 0;
        if (exU > (inc.deletedAt || 0)) {
          skipped++; // 本地更新了 → 保留本地（删除不生效）
        } else {
          // 本地旧/相同 → 标墓碑（删除传播到本地）
          const now = Date.now();
          data.accounts[domain][name] = {
            name: existing.name || name,
            createdAt: existing.createdAt || now,
            updatedAt: now,
            deleted: true,
            deletedAt: now
          };
          tombstoned++;
        }
        continue;
      }

      if (exDeleted) {
        // 本地墓碑 + 远端活跃
        if ((inc.updatedAt || 0) > (existing.deletedAt || 0)) {
          data.accounts[domain][name] = inc; // 复活：删除后又保存过新数据
          resurrected++;
        } else {
          skipped++; // 保持墓碑
        }
        continue;
      }

      // 双方活跃：取 updatedAt 更新的（远端新 → 覆盖本地；本地新/相同 → 保留本地）
      const inU = (inc && inc.updatedAt) || 0;
      const exU = (existing && existing.updatedAt) || 0;
      if (inU > exU + 1000) {
        data.accounts[domain][name] = inc;
        updated++;
      } else {
        skipped++;
      }
    }
  }
  // v2.10.0：清理过期墓碑（TTL 30 天）
  purgeOldTombstones(data);
  await saveRawData(data);
  return { imported, updated, skipped, resurrected, tombstoned };
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
