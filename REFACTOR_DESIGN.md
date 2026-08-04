# 主线 / 支线逻辑详细重构设计

> 配套文档：`REFACTOR_PLAN.md`（总体路线）· 本文（逐链路详细设计）
> 调研方式：基于 Chrome/Edge 官方 API 文档 + 同类项目（bilibili-history-wxt、CleanSlateTab、time-tracker）架构 + MV3 最佳实践搜索
> 日期：2026-08-04 | 目标版本：v2.5.0

---

## 〇、调研结论速览（设计依据）

| # | 结论 | 来源 | 对重构的影响 |
|---|------|------|--------------|
| 1 | MV3 SW **无内存状态**，一切跨激活状态必须落 `chrome.storage`；`storage.session` 内存级适合瞬时/敏感数据 | Chrome 官方 + 多篇实践 | 新增 `lib/messaging.js` 消息层；SW 内不依赖全局变量 |
| 2 | `chrome.cookies.getAll` **只返回未过期 cookie**，且按 path 长度排序；`set` 失败会 reject；**`partitionKey`（Chrome 119+，CHIPS）必须显式处理** | Chrome cookies API 文档 | **主逻辑 P0 发现：当前代码完全未处理 partitionKey，切换会丢失 Partitioned Cookie** |
| 3 | `storage.local` 配额 **10MB**（Chrome 113+），可申请 `unlimitedStorage`；IndexedDB 无硬上限（数 GB） | Chrome storage 文档 + 存储调研 | 大 Cookie 数据集远期迁移 IndexedDB；近期加配额监控 |
| 4 | 消息监听异步响应必须 `return true` 保活通道；**onMessage 需校验 sender** 防 XSS/恶意注入 | 多篇 MV3 通信实践 | 消息层统一封装 + sender 校验 |
| 5 | WebDAV 在扩展中必须走 **SW 代理**（host_permissions 绕过 CORS） | bilibili-history-wxt / CleanSlateTab | 已纳入 Phase 3.5（见 REFACTOR_PLAN） |
| 6 | OWASP 2023+ 建议 PBKDF2 **60 万次**；敏感凭据存 `storage.session` 而非明文 | OWASP / Chrome 存储实践 | 已纳入 Phase 1 |
| 7 | `chrome.alarms` 是 MV3 唯一可靠定时机制（SW 休眠后可唤醒）；`setInterval` 在 SW 不可靠 | Chrome alarms 文档 | 定时备份用 alarms（Phase 3.5） |

---

## 一、P0 真相问题：README 声称与实现不符（本次调研最大发现）

| 声称（README） | 实际（代码） | 严重度 |
|----------------|-------------|--------|
| "Cookie value 使用 Web Crypto API **加密存储**" | `saveAccount()` 把 `cookie.value` **明文**写入 storage.local，仅有导出/导入加密 | 🔴 用户以为本地数据加密，实际任何人读到 storage 即得明文登录态 |
| "开启后**打开弹窗需输入密码**" | popup.js 无任何密码验证逻辑，密码锁形同虚设 | 🔴 功能缺失 |
| "重装后数据保留" | 正确（manifest `key` 已加） | ✅ |

**结论**：`REFACTOR_PLAN.md` Phase 1 已覆盖"删除明文密码"，但**还需覆盖 cookie value 明文落库**。设计见第三章。

---

## 二、主线逻辑详细重构

### 2.0 主链路共同前置：`lib/messaging.js` 消息层（新增）

**现状问题**：popup 直接调用 `chrome.*` + utils.js 函数，无统一入口；将来 WebDAV 必须走 SW，popup 无法直连。

**目标设计**：三层消息架构（页面 → SW → chrome API），所有 `chrome.*` 调用统一收口。

```
popup / options
   │  chrome.runtime.sendMessage({type, payload})
   ▼
background.js 消息路由（sender 校验 + 白名单 action 分发表）
   │
   ├─ cookie.*  → lib/cookies.js（权限已在 SW 侧校验）
   ├─ storage.* → lib/storage.js
   ├─ webdav.*  → lib/webdav.js（Phase 3.5）
   └─ backup.*  → lib/backup.js
```

**关键实现点**：
- 监听器 `return true` 保活异步通道（当前代码没有——潜在 bug）
- 统一 `sendMessage` Promise 封装 + 超时（popup 关闭场景）
- sender 校验：`sender.id === chrome.runtime.id`，action 白名单，拒绝未知 action
- 消息批处理：低频场景（本扩展）不强制，但同一操作合并为单个 action（如 `switchAccount` 一次性完成 清→写→LS→reload）

### 2.1 链路 A · 保存账号

**现状**：
```
输入账号名 → getCookies + getTabLocalStorage → saveAccount（cookie value 明文落库）
```

**问题**：
1. Cookie value 明文落库（P0）
2. 未保存 `partitionKey` → 后续切换丢失 Partitioned Cookie（P0）
3. 未保存 `storeId`（无痕窗口场景）
4. 保存不校验 Cookie 有效性与过期时间
5. `saveAccount` 死参数 `pin`；无 `group` 输入 UI（只有字段）

**目标设计**：
```
输入账号名（+可选分组） → 抓取（getAll + getTabLocalStorage，记录 storeId/partitionKey）
→ 过滤：丢弃已过期 cookie（getAll 已保证未过期，双保险）
→ 加密：cookie.value 逐条 AES-GCM 加密（主密钥见 3.1）
→ 写入 storage.local（版本 v3 结构）
→ 返回统计 {saved, skipped, encrypted}
```

伪代码：
```js
async function captureAndSave(domain, name, tabId, group) {
  const cookies = await getCookies(domain);          // 已含 partitionKey/storeId 字段
  const lsData = await getTabLocalStorage(tabId);
  const prepared = cookies.map(c => ({
    ...pick(c, ['name','domain','path','secure','httpOnly','sameSite','expirationDate','partitionKey','storeId']),
    value: await encryptValue(c.value)               // P0 修复：value 加密
  }));
  await saveAccount(domain, name, prepared, lsData, group);
  return { saved: prepared.length };
}
```

### 2.2 链路 B · 切换账号

**现状**：
```
点击卡片 → applyCookies（先清后写）→ setTabLocalStorage → reload
```

**问题**：
1. **未处理 partitionKey**：`setCookie` 不传 `partitionKey` → Partitioned Cookie 写入失败或落到非分区 → 登录态不完整（P0）
2. 无回滚：先清后写，中途失败留半状态
3. 不跳过过期 cookie：`set` 带已过期 `expirationDate` 会失败并计入 failed
4. 无条件 reload：即使写失败也刷新
5. 无切换结果反馈（成功/失败明细）

**目标设计**：
```
点击卡片 → 读账号数据 → 解密 value → 过滤过期 cookie
→ 快照当前 cookies（内存）→ 清除 → 写入（带 partitionKey + storeId + 解密值）
→ 写 localStorage → 统计结果
→ 有失败？→ 回滚恢复快照（尽力而为）→ 返回 {switched, skipped, failed, rolledBack}
→ 全部成功才 reload
```

伪代码：
```js
async function applyCookies(domain, cookies, opts = {}) {
  const now = Date.now() / 1000;
  const valid = cookies.filter(c => !c.expirationDate || c.expirationDate > now); // 跳过过期
  const snapshot = await getCookies(domain);            // 回滚用
  const cleared = await clearDomainCookies(domain);
  const failed = [];
  for (const c of valid) {
    try {
      await setCookie({ ...c, value: await decryptValue(c.value), partitionKey: c.partitionKey, storeId: c.storeId });
    } catch (e) { failed.push({ name: c.name, error: e.message }); }
  }
  if (failed.length) await restoreCookies(snapshot);    // 回滚
  return { cleared: cleared.removed, set: valid.length - failed.length, failed, rolledBack: failed.length > 0 };
}
```

### 2.3 链路 C · 登录新账号（清场）

**现状**：`clearDomainCookies + clearTabLocalStorage + reload`（基本正确）

**问题**：
1. 未传 `storeId`（getCookies 带 storeId，但 remove 用了 storeId？——`removeCookie` 有传，但 `getCookies(domain)` 未按 store 区分）
2. 清场后无条件 reload，无失败统计提示细节（已有部分）

**目标设计**：改为走消息层统一 `clearSite(domain, tabId)` action，返回统计；失败时展示失败 Cookie 明细而非仅计数。

---

## 三、支线逻辑详细重构

### 3.1 加密体系（支线 · 安全核心）—— 本次重构的地基

**现状**：`encrypt/decrypt(pin)` 仅用于导出/导入；本地落库**不加密**；密码原文存 `pin_raw`。

**目标设计 —— 设备主密钥（Master Key）方案**：

```
主密钥 MK = WebCrypto 随机 256bit（首次使用生成）
   ├─ 有密码锁：MK 用 deriveKey(锁密码) 包裹后落盘   → 本地数据真正加密
   └─ 无密码锁：MK 明文落盘（storage.local 沙箱）    → 至少防"磁盘级"裸读，但防不了同权进程
```

- cookie value 用 MK 加密（AES-GCM，随机 IV，盐/IV 随密文存）
- 密码锁开启时，MK 进一步被锁派生密钥保护 → "开启密码锁 = 全量数据加密"成为真实语义
- **删除 `pin_raw`**（Phase 1 已定）
- 导出/导入仍用锁派生密钥（用户输入密码），与 MK 解耦

### 3.2 密码锁（支线）

| 项 | 现状 | 目标 |
|----|------|------|
| 验证 | SHA-256 快哈希 | PBKDF2(salt, 600k) 慢哈希 + 旧格式兼容迁移 |
| 防爆破 | 无 | failCount ≥5 锁 60s，指数递增（5→60s，10→600s，15→3600s） |
| 弹窗 | 无验证 | popup 锁屏遮罩（Phase 1） |
| 凭据 | `pin_raw` 明文 | 删除；导出改输入密码 |

### 3.3 域名白名单（支线）

**现状问题**：`getBaseDomain` 硬编码少量二级后缀（com.cn/co.jp…），`isDomainAllowed` 子域匹配简单 `endsWith`（`a.evil-example.com` 会被 `example.com` 误匹配？—— `domain.endsWith('.example.com')` 正确，但 `evil-example.com` 不匹配，OK；主要问题是 TLD 表不全）。

**目标**：
- 白名单匹配规则升级：规范化（去协议/端口/`www.`）+ 精确域或子域匹配 + 通配符 `*.example.com` 支持
- `getBaseDomain` 改用公共后缀表子集（内嵌常量表扩展至 30+ 常见后缀），或用 `registrable domain` 简化逻辑（保存用完整 hostname，比较用 base domain 双轨）

### 3.4 备份（支线）

| 项 | 现状 | 目标 |
|----|------|------|
| 本地导出 | 加密整库 | 保留 + 输入密码（不再读明文） |
| 本地导入 | 覆盖式 | merge（按域名合并，同名账号跳过）/replace 双模式 |
| WebDAV | 无 | Phase 3.5 全套（配置/连接测试/上传/下载/定时/保留策略） |

### 3.5 右键菜单（支线）

**现状**：单一"清除此站点 Cookie 并重新登录"。

**目标**：保留 + 增加二级菜单"切换到此站点账号 →"（动态列出该域名已保存账号，点击即切换）。需要 `contextMenus.onClicked` 处理子菜单 id，复用链路 B 逻辑（经消息层）。注意：**动态菜单在 SW 中需在每次点击前重建**（contextMenus.removeAll + 重建），且 `contextMenus` API 在 Edge 需显式权限（已有）。

### 3.6 快捷键 / 分组 / 权限（支线）

- **快捷键**：现状正确，保留
- **分组**：增加分组管理（重命名/删除分组、未分组收纳），popup 分组头加折叠；排序改 group + updatedAt 双键
- **权限**：三层防线保留；新增 WebDAV 服务器域名按需授权（复用 `permissions.request`）；消息层内做权限前置校验（无权限直接返回明确错误，而非空数组误导）

---

## 四、数据模型演进（v2 → v3）

```jsonc
// v3 结构（storage.local: cookie_switcher_data）
{
  "version": 3,
  "accounts": {
    "example.com": {
      "工作号": {
        "cookies": [{
          "name": "session",
          "value": "<AES-GCM 密文 base64>",      // ← P0 修复：加密
          "domain": ".example.com",
          "path": "/",
          "secure": true,
          "httpOnly": true,
          "sameSite": "lax",
          "expirationDate": 1893456000,
          "partitionKey": { "topLevelSite": "https://example.com" },  // ← 新增
          "storeId": "0"                          // ← 新增
        }],
        "localStorage": { "k": "<值加密 or 明文? 默认明文，敏感项可选>" },
        "group": "",
        "createdAt": 0, "updatedAt": 0
      }
    }
  }
}
// 新增顶层键：
// cookie_switcher_mk        → 主密钥（有锁时 = 锁密钥包裹的密文；无锁 = 明文，标注 usePinLock:false）
// cookie_switcher_pin       → {salt, hash, format:"pbkdf2"}（v3 新格式，兼容旧 hex）
// cookie_switcher_lock      → {failCount, lockedUntil}（防爆破状态）
// cookie_switcher_webdav    → {url, user, pass:<加密>, keep:10, schedule:"daily"}（Phase 3.5）
```

**版本迁移策略**（`lib/storage.js` 内 `migrate()`）：
- 读取时检测 `version`；v2 → v3：为既有 cookie value 逐条加密（用当前 MK）→ 写回 → 标 version 3
- 迁移失败不阻塞读取（降级：返回原数据 + 标记 `migrationPending`，下次重试）
- 密码锁格式迁移：verifyPin 成功 → 异步升级为 pbkdf2 格式

---

## 五、其他横切设计

### 5.1 存储配额
- 保留 `storage.local`；`getBytesInUse` 监控，接近 80% 时弹窗提示
- 远期：数据量 > 8MB 或账号 > 50 时评估 IndexedDB（Phase 远期，不进 v2.5）

### 5.2 错误处理与日志
- 所有 chrome API Promise 化，`lastError` 显式捕获（当前部分遗漏）
- SW 内 console 不可靠 → 环形日志（storage 内 50 条，alarm 调试/WebDAV 失败排查用）

### 5.3 消息契约（新增 lib/messaging.js 的 action 清单）

| action | 方向 | 说明 |
|--------|------|------|
| `tab.getCurrent` | popup→SW | 取当前 tab 域名（统一处理 edge:// 等） |
| `permission.ensure` | popup→SW | 权限检测 + 按需授权 |
| `account.save` | popup→SW | 链路 A |
| `account.switch` | popup→SW | 链路 B（含回滚） |
| `account.delete` / `account.rename` | popup→SW | |
| `site.clear` | popup→SW | 链路 C |
| `options.load` / `options.save` | options→SW | 白名单/密码锁/WebDAV 配置 |
| `backup.export` / `backup.import` | options→SW | merge/replace |
| `webdav.test` / `webdav.push` / `webdav.pull` / `webdav.schedule` | options→SW | Phase 3.5 |
| `alarm.onBackup` | 内部 | SW 定时备份入口 |

---

## 六、与 REFACTOR_PLAN.md 的对应

| 本文设计 | 对应 Phase |
|----------|-----------|
| 2.0 消息层、3.1 主密钥、3.2 密码锁、cookie value 加密 | **Phase 1**（安全加固，新增消息层前置） |
| 2.1/2.2/2.3 三链路重构、3.3/3.4/3.5 支线、四、数据模型 v3 | **Phase 2**（模块化）+ **Phase 3**（功能增强） |
| 3.4 WebDAV、5.2 WebDAV 日志 | **Phase 3.5** |
| 5.1 配额监控、远期 IndexedDB | **Phase 远期** |

> 变更说明：由于发现"cookie 明文落库 + partitionKey 缺失"两个 P0，**Phase 1 范围扩大**：新增 `lib/messaging.js` 与主密钥机制作为前置，三条主链路在 Phase 2 直接以 v3 数据模型实现。
