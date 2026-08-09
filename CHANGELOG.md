# 更新日志（CHANGELOG）

> 版本号与 `manifest.json` 同步，每次发布 bump。详细改动背景见 `DEVELOPMENT.md`「关键问题与方案」与 `AGENTS.md`。

## v2.11.2 (2026-08-09)

### 修复（数据安全 P1：清空数据与墓碑机制的兼容性）

- **「清空本地账号数据」改墓碑化，不再物理删除**：原实现 `chrome.storage.local.remove(STORAGE_KEY)` 直接物理删库，完全绕过墓碑机制，导致两个数据安全问题：
  - ① 远端有备份时：清空后同步会把远端账号全部"复活"回本地（清空被撤销，远端无从得知你清空了）；
  - ② 远端无备份时：同步会把**空数据上传**，远端备份被空覆盖 → 本地已清、远端也空 → **账号数据永久丢失**。
  - 现改为遍历全部账号标记 `deleted:true + deletedAt:now`（保留骨架、清空 cookies，与逐账号删除语义一致）。清空可跨设备传播（同步时墓碑上传，其他设备同样隐藏删除）；本地墓碑 vs 远端旧账号（updatedAt < deletedAt）不会复活；导出/上传的是含墓碑的数据而非空。
- **WebDAV 同步空数据防上传兜底**：`webdav.sync` 上传前检查合并后本地条目（含墓碑）总数，为 0（异常物理空路径）时**跳过上传**，`pushed=null`，防止把空备份传上去覆盖远端。
- **设置页提示文案同步**："已清空本地账号数据（将在下次同步时同步到其他设备；密码锁 / WebDAV 配置保留）"。
- **同步空数据兜底的 UI 提示修复**：`webdav.sync` 返回 `pushed=null`（本地无数据跳过上传）时，popup 与设置页同步提示原先直接访问 `r.pushed.filename` 报 TypeError（同步失败误报）。现两处均处理 `pushed=null`：显示"本地无数据，未上传"，且不再误报"已创建首份"。

### 验证

- mock `chrome.storage` 三场景测试 PASS：墓碑化清空（条目 2/2、无 cookies 残留、非空不会传空）✅；墓碑导出非空 + 导入另一设备传播删除（tombstoned=2）✅；本地物理空 → 跳过上传 ✅。

## v2.11.1 (2026-08-09)

### 修复（P0：切换失效导致账号"很快过期"）

- **切换改回 popup 直调（根因修复）**：v2.9.0 把切换经 `account.switch` 消息层收口到 **SW 执行 cookie 写入**，但 Edge 的 MV3 Service Worker 中 `chrome.cookies.getAll` 读不到浏览器主会话 cookie（DEVELOPMENT.md §25 有 CDP 实测：SW 0 个 vs popup 12 个）→ `applyCookies` 快照为空 → **清除旧 cookie 阶段失效（清除 0 个）→ 新旧会话混存 → 服务端校验失败 → 新录入账号"很快过期/需重新登录"**（v2.2 切换在 popup 页面直调，一直正常）。现 `popup.js handleSwitchAccount` 直接调用共享核心 `switchAccount()`（popup 页面上下文 getAll 可靠），恢复 v2.2 / v2.6.0-2.8.x 的正确架构。
- **`applyCookies` 清除双保险**：清除阶段先按**待写入的已知列表**逐个 `remove`（remove 只需 url+name，不依赖 getAll，SW/popup 双上下文都可靠），再用快照补充移除其他同域 cookie（getAll 可靠时全量清干净）。修复后即使将来误在 SW 上下文执行，也至少能按名清掉目标账号旧 cookie。
- **右键菜单移除"切换到此站点账号"**：contextMenus.onClicked 只能在 SW 响应，SW 上下文 cookie 写入不可靠，为稳定性移除该子菜单（回到 v2.2 只有"清除 Cookie"的行为）。「清除此站点 Cookie」改用双保险：已保存账号的已知 cookie 逐个移除 + 全量清除。
- **移除 `handlers/account.js` 与 `account.switch` action**：SW 消息路由不再承载任何 cookie 写操作（AGENTS.md 坑 25 原则），删除相关代码与 importScripts 注册。

### 验证

- 全部 JS `node --check` 通过；mock `chrome.cookies` 双场景测试：SW 上下文（getAll 空）已知列表清除无新旧混存 ✅、popup 上下文（getAll 正常）全量清除含快照补充 ✅。

## v2.11.0 (2026-08-08)

### 修复
- **WebDAV「同步」按钮文案**：修复弹窗与设置页点击「同步」后文案误变为「一键同步」的问题，现保持「同步」并保留同步动画。
- **密码锁防暴破阈值**：修复 `recordPinFailure` 在**每次失败**后都写入 60s 锁定，导致输错一次即被锁、连正确密码也被挡的 bug。改为仅当连续失败达到阈值（5 次）才锁定，阈值内只累计次数（与文档设计一致）；指数冷却按每满 5 次失败翻倍（60s → 120s → 240s）。

### 重构 / 清理
- **共享切换核心**：新增 `lib/cookies.js: switchAccount(domain, name, account, {tabId, reload})`，封装「清→写→reload」（含主密钥守卫）。popup 经 `account.switch` 消息层、右键菜单直调，两者共用同一核心，消除重复实现（旧 `probeSessionHealthAsync` 与 background 内联探测已删除）。⚠️ **该"经消息层收口到 SW"的设计引入 P0 缺陷（Edge SW 中 cookies.getAll 读不到 cookie → 切换清不掉旧 cookie → 账号"很快过期"），已被 v2.11.1 废除**（切换改回 popup 直调、删除 handlers/account.js，见 DEVELOPMENT §37）。
- **移除会话存活探测（session-health）整套能力**：删除 `lib/health.js`、`updateAccountHealth()`、账号 `health`/`lastVerifiedAt` 字段、右键菜单 ⚠️ 失效标记、后台 `session-health-check` 每日 alarm。切换逻辑简化为「清→写→reload」，不再做存活探测（理由：探测依赖第三方 realm、跨域易误报、维护成本高，对核心「保存/切换」无增益）。
- **清理历史遗留死代码与误导性注释**：修正多处「全部操作经消息层」「探测更新健康标记」等已不成立的注释；UI 文案/布局调整（WebDAV 三按钮同行、清除配置置右；保存面板「①登录新账号 / ②保存新账号」）。

### 文档
- 同步修订 `AGENTS.md` / `DEVELOPMENT.md` / `REFACTOR_DESIGN.md`：删除对已移除会话探测功能的描述，补充实际双轨架构与 PIN 锁行为，标注 `REFACTOR_DESIGN.md` 为已演进的设计提案。

## 历史版本

v2.5.0 – v2.10.0 的逐项改动（明文主密钥、防暴破、Partitioned Cookie 透传、消息层、WebDAV、墓碑软删除等）详见 `DEVELOPMENT.md`「关键问题与方案」§10 – §36。
