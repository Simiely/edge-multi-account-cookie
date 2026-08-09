# 重构方案 · Edge Multi-Account Cookie Switcher

> 版本：v2.2.0 → 目标 v2.5.0 | 类型：安全加固 + 模块化重构 + 功能增强 + WebDAV 远程备份
> 日期：2026-08-04 | 状态：✅ **已实施完成（历史文档，勿据此操作）**——方案对应 v2.5.0 重构，现版本 v2.11.2 已大幅演进（含 v2.6.0 明文存储、v2.10.x 移除会话探测、v2.11.1 切换 popup 直调、v2.11.2 清空墓碑化）；当前权威文档为 `AGENTS.md`（含稳定性红线）与 `DEVELOPMENT.md`（§1-§38）。
>
> **配套文档**：主线/支线逻辑逐链路详细设计见 [REFACTOR_DESIGN.md](./REFACTOR_DESIGN.md)（含消息层契约、主密钥方案、数据模型 v3、迁移管线；该文档同样标注了与当前实现的偏差）。本文为总体路线。

---

## 一、项目现状理解

### 1.1 项目组成

| 区域 | 文件 | 职责 |
|------|------|------|
| 扩展本体 | `manifest.json` | MV3 配置（含 `key` 固定扩展 ID） |
| | `background.js` | Service Worker：右键菜单、快捷键 |
| | `popup.html/js` | 弹窗 UI：保存/切换/删除账号、登录新账号 |
| | `options.html/js` | 设置页：密码锁、域名白名单、导出/导入 |
| | `utils.js` | **核心大杂烩**：加密、存储、Cookie、密码锁、白名单、备份（537 行） |
| | `_locales/` | zh_CN + en 多语言 |
| | `assets/` | 图标 |
| 落地页 | `index.html` | GitHub Pages 产品落地页（43KB 全站） |
| | `onepage/index.html` | **与 index.html 内容完全相同（冗余副本）** |
| 文档 | `README.md` / `DEVELOPMENT.md` / `AGENTS.md` / `CHANGELOG.md` | 用户文档 + 开发文档 + AI 规则 |
| 垃圾 | `20260704Final` | **2 字节空文件（误创建，应删除）** |

### 1.2 数据模型（storage.local）

```
cookie_switcher_data = {
  version: 2,
  accounts: {
    "example.com": {
      "工作号": {
        cookies: [{ name, value, domain, path, secure, httpOnly, sameSite, expirationDate }],
        localStorage: { key: value },
        group: "",            // 可选分组
        createdAt, updatedAt
      }
    }
  }
}
```

其他键：`cookie_switcher_pin`（SHA-256 hex）、`cookie_switcher_pin_raw`（**明文密码，安全隐患**）、`cookie_switcher_whitelist`（数组）。

### 1.3 主线逻辑（3 条核心业务链路）

**链路 A · 保存账号**
```
打开弹窗 → 取当前 Tab → 提取域名 → 白名单检查 → 权限检测(permissions.contains)
  → 未授权则引导授权(permissions.request)
→ 输入账号名 → getCookies(domain) + getTabLocalStorage(tabId)
→ saveAccount() 写 storage.local → 渲染列表
```

**链路 B · 切换账号**
```
点击账号卡片 → 读账号数据 → applyCookies(先清后写) → setTabLocalStorage → tabs.reload
```

**链路 C · 登录新账号（清场）**
```
点击按钮 → clearDomainCookies + clearTabLocalStorage → tabs.reload
```

三条链路共享两个关键依赖：**权限校验**（第一道闸门）与 **utils.js 工具层**（所有操作）。

### 1.4 支线逻辑

| 支线 | 实现位置 | 说明 |
|------|----------|------|
| 权限三层防线 | popup.js + manifest | activeTab + optional_host_permissions + 主动 contains 检测 |
| 域名白名单 | utils.js + options.js | 空 = 放行全部；支持子域匹配 |
| 密码锁 | utils.js + options.js | SHA-256 哈希验证 + **明文副本（供导出）** |
| 加密备份 | utils.js + options.js | AES-GCM 整库导出/导入 |
| 右键菜单 | background.js | 清除站点 Cookie 并刷新 |
| 快捷键 | manifest + background.js | Alt+Shift+S 开弹窗 |
| 分组展示 | popup.js | 按 group 排序渲染分组头 |
| 扩展 ID 固定 | manifest `key` | 重装数据保留 |
| 落地页 | index.html | GitHub Pages |
| **WebDAV 备份（新增）** | lib/webdav.js + background.js + options.js | 远程加密备份上传 / 下载恢复 / 定时自动备份 |

---

## 二、问题清单（按严重度分级）

### 🔴 P0 · 安全缺陷（必须修）

| # | 问题 | 位置 | 风险 |
|---|------|------|------|
| 1 | **密码明文存储**：`cookie_switcher_pin_raw` 存密码原文，仅供导出免输入 | utils.js L427/L454 | 任何能读到扩展 storage 的途径（恶意扩展、调试工具、备份同步）都能直接拿到密码 → 密码锁形同虚设 |
| 2 | **无防暴力破解**：verifyPin 无失败次数限制/冷却，可无限重试 | utils.js L468 | 密码锁可被穷举 |
| 3 | **PBKDF2 迭代 10 万次**（OWASP 2023 建议 ≥ 60 万） | utils.js L13 | 离线暴力破解成本低 |
| 4 | **Cookie value 明文落库**：README 声称"AES-256-GCM 加密存储"，实际 `saveAccount()` 将 `cookie.value` 明文写入 storage.local（加密仅用于导出/导入） | utils.js L146-156 | 用户误以为本地数据加密，实际任何能读 storage 的途径可得明文登录态 |
| 5 | **未处理 partitionKey（CHIPS）**：chrome.cookies 自 Chrome 119 支持 Partitioned Cookie，set/getAll 需带 partitionKey，当前代码完全忽略 | utils.js setCookie/getCookies | 现代站点（第三方登录、嵌入式会话）的 Partitioned Cookie 保存后切换会丢失/写错，登录态不完整 |

### 🟠 P1 · 架构缺陷（重构核心）

| # | 问题 | 位置 |
|---|------|------|
| 4 | **utils.js 职责混杂**：加密 + 存储 + Cookie 操作 + 密码锁 + 白名单 + 备份 + DOM 辅助 `showStatus` 全部塞在一个文件 | utils.js |
| 5 | **background.js 与 utils.js 重复实现**：cookieUrl/getCookies/setCookie/removeCookie/clearDomainCookies 两处拷贝，改一处漏一处 | background.js |
| 6 | **加载粒度粗**：popup 和 options 都整包加载 utils.js，options 用不到 Cookie 操作、popup 用不到备份 | popup.html / options.html |
| 7 | **纯逻辑与 DOM 耦合**：showStatus 等 UI 函数混在工具层 | utils.js L528 |
| 8 | **无消息层**：popup/options 直接调 chrome.*，无统一入口；异步监听未 `return true` 保活（潜在 bug）；无 sender 校验 | popup.js / background.js | WebDAV 需走 SW 代理，必须先建消息层 |

### 🟡 P2 · 功能与健壮性

| # | 问题 | 位置 | 建议 |
|---|------|------|------|
| 9 | **切换无回滚**：先清 Cookie 再写入，中途失败留下半状态 | utils.js applyCookies | 快照 + 失败回滚 |
| 10 | **导入覆盖式**：无合并选项，误导入丢全部现有数据 | utils.js importData | 合并/覆盖双模式 |
| 11 | **密码锁未接入弹窗**：README 声称"打开弹窗需输入密码"，实际 popup 无验证 | popup.js | 弹窗加锁屏 |
| 12 | **无账号重命名** | popup.js | 卡片加编辑 |
| 13 | **过期 Cookie 无提示**：保存很久的账号切换后可能静默失效 | popup.js | 过期跳过 + 统计提示 |
| 14 | `saveAccount` 死参数 `pin`（从未使用） | utils.js L140 | 删除 |
| 15 | 账号排序不稳定：同组内无次级排序键 | popup.js L119 | updatedAt 降序 |
| 16 | `onepage/index.html` 与 `index.html` 重复；`20260704Final` 空文件 | 根目录 | 删除冗余 |
| 17 | **无远程备份能力**：数据只存本机，重装/换机/磁盘损坏即丢失 | 全项目 | 新增 WebDAV 远程备份（见第四章） |
| 18 | **数据版本无迁移机制**：`DATA_VERSION=2` 但读取不迁移，未来结构演进（v3 加密/partitionKey）会崩 | utils.js loadRawData | migrate() 管线（见 REFACTOR_DESIGN 第四章） |

---

## 三、模块化规划（目标架构）

### 3.1 约束

- **MV3 Service Worker**：不能 ES module import（Edge 无实际 import 时解析失败），用 `importScripts` 或顶层多 script 加载
- **零第三方依赖**（AGENTS.md 硬性约定，杜绝供应链风险）
- 页面（popup/options）用普通 `<script>` 按需引入

### 3.2 目标目录结构

```
edge-multi-account-cookie/
├── manifest.json              # + alarms 权限（WebDAV 定时备份）
├── background.js              # SW 入口：右键菜单 + 快捷键 + WebDAV 代理（importScripts 引 lib）
├── lib/                       # 可复用核心层（无 DOM 依赖，页面/SW 通用）
│   ├── crypto.js              # 加密：AES-GCM + PBKDF2 + 主密钥 + 分块 base64（纯函数）
│   ├── storage.js             # 数据层：storage.local CRUD + 账号模型 + 版本迁移
│   ├── cookies.js             # Cookie/localStorage 操作 + applyCookies（partitionKey/回滚）
│   ├── security.js            # 密码锁（PBKDF2 验证 + 防暴力破解）+ 白名单
│   ├── backup.js              # 导出/导入（合并/覆盖模式）
│   ├── messaging.js           # 消息层：sendMessage 封装 + sender 校验 + action 分发（新增）
│   └── webdav.js              # WebDAV 协议客户端：PROPFIND/GET/PUT/DELETE/MKCOL（纯 fetch + Basic Auth）
├── popup/
│   ├── popup.html
│   └── popup.js               # 弹窗 UI 逻辑（引入 lib/crypto,storage,cookies,security）
├── options/
│   ├── options.html
│   └── options.js             # 设置页 UI（引入 lib/crypto,storage,security,backup + WebDAV 区块）
├── _locales/
├── assets/
├── index.html                 # 落地页（保留；删除 onepage/ 副本）
└── README.md / DEVELOPMENT.md / AGENTS.md / CHANGELOG.md
```

### 3.3 依赖方向（严格单向）

```
crypto.js  ←  storage.js  ←  cookies.js / security.js  ←  backup.js
     ↑              ↑
     └──────────────┴── 无 chrome.* 依赖，可被任何上下文加载

webdav.js  ← 仅依赖 fetch，不依赖 lib 其他模块；由 background.js 加载执行
UI 层（popup.js / options.js / background.js）只依赖 lib/*，禁止反向
```

- `crypto.js`：**零 chrome API**，纯 Web Crypto —— Service Worker 与页面都能用，单测友好
- `storage.js`：只依赖 `chrome.storage` + crypto（数据加密字段）
- `cookies.js`：只依赖 `chrome.cookies/scripting/tabs` + crypto
- `security.js`：密码锁（改 PBKDF2 盐值哈希 + 失败锁定）、白名单
- `backup.js`：组装 storage + crypto，提供 merge/replace 导入
- `webdav.js`：**纯协议客户端**（fetch + Basic Auth），零 chrome API、零依赖，**必须在 Service Worker 中执行**（见 3.6）

### 3.4 加载策略

| 上下文 | 加载方式 | 内容 |
|--------|----------|------|
| background | `importScripts('lib/crypto.js','lib/storage.js','lib/cookies.js','lib/webdav.js')` | 右键菜单 + WebDAV 代理 + 定时备份 |
| popup | `<script>` 依次引入 crypto→storage→cookies→security | 保存/切换/登录新账号 |
| options | `<script>` 依次引入 crypto→storage→security→backup | 密码锁/白名单/备份/WebDAV 配置 |

> 注意：`importScripts` 与 `<script>` 顺序敏感，依赖在前。

### 3.5 关键设计决策

1. **密码存储重构**：删除 `pin_raw` 明文。验证改用 `PBKDF2(salt, pin, 600000)` 派生密钥比对（盐值随机 16B，与数据加密盐独立）；**兼容迁移**：检测到旧 SHA-256 hex 格式 → 验证通过后自动重写为新格式。
2. **导出改交互**：导出/导入时由用户**输入密码**（不再读取明文），与 README 描述一致且消除明文。
3. **防暴力破解**：storage 记录 `{ failCount, lockedUntil }`；连续失败 5 次锁 60s，之后失败次数每 +5 翻倍锁定时间；验证前先查锁。
4. **切换回滚**：applyCookies 先快照当前 Cookie → 清除 → 写入；若写入失败数 > 0，回滚恢复快照并返回失败明细。
5. **导入合并**：`importData(blob, pin, mode)`，mode=`merge`（按域名合并，同名账号跳过保留现有）/`replace`（覆盖）；options 提供单选。
6. **过期 Cookie**：切换时跳过 `expirationDate < now` 的 Cookie 并统计，提示"N 个 Cookie 已过期未写入"。
7. **排序稳定**：group 升序 + updatedAt 降序双键。
8. **DOM 辅助独立**：showStatus 等迁入各 UI 文件（popup/options 各一份小函数），lib 层保持纯逻辑。
9. **Cookie value 加密落库（P0 修复）**：设备主密钥（Master Key）方案——首次使用生成随机 256bit MK；有密码锁时 MK 用锁派生密钥包裹后落盘（"开锁 = 全量加密"），无锁时 MK 明文落盘（防磁盘级裸读）。详见 REFACTOR_DESIGN 3.1。
10. **partitionKey / storeId 全链路透传（P0 修复）**：保存时记录 `partitionKey`（Chrome 119+ CHIPS）与 `storeId`，切换/清除时原样回写。详见 REFACTOR_DESIGN 2.1/2.2。
11. **数据版本迁移管线**：`migrate()` 读取时惰性迁移 v2→v3（加密既有 value、补 partitionKey 字段），失败降级 + `migrationPending` 重试。

### 3.6 WebDAV 远程备份（新增功能 · 专项设计）

**为什么走 Service Worker 代理（关键决策）**：WebDAV 服务器（坚果云/Nextcloud 等）通常不开放 CORS 头，扩展页面直接 `fetch` 会被浏览器拦截。MV3 中 **Service Worker 配合 `host_permissions` 可绕过 CORS**（同类项目 bilibili-history-wxt / CleanSlateTab 均采用此模式）。本项目已有 `optional_host_permissions: ["<all_urls>"]`，复用"按需授权"三层防线即可。

```
用户配置 WebDAV（options）
  → chrome.permissions.request({origins:[webdav 服务器]})    // 按需授权，复用现有模式
  → options 通过 chrome.runtime.sendMessage 发请求给 SW
  → background.js 消息代理 → lib/webdav.js 执行 PROPFIND/GET/PUT
  → 结果回传 options 展示
```

**lib/webdav.js 协议客户端**（约 120 行，零依赖）：
- `list(remoteDir)` → PROPFIND Depth:1，解析 207 Multi-Status 返回文件名列表
- `get(remotePath)` → GET，返回文本/二进制
- `put(remotePath, content)` → PUT，上传
- `delete(remotePath)` → DELETE
- `mkcol(remoteDir)` → MKCOL 建目录（409 已存在则忽略）
- 认证：Basic Auth，`Authorization: Basic base64(user:pass)`，每请求携带

**备份文件格式**：与现有导出一致 `{ version: 2, data: <AES-GCM 密文> }`，加密密钥 = 密码锁派生密钥（若未设密码锁则要求先设置——**WebDAV 备份与密码锁强绑定**，保证远端数据不可读）。文件名：`cookie-switcher-backup-YYYYMMDD-HHmm.json`，保留最近 N 份（默认 10，可配置），旧文件自动 DELETE。

**功能清单**：
| 功能 | 说明 |
|------|------|
| 连接测试 | PROPFIND 服务器根路径，验证凭据/路径/CORS 权限 |
| 立即备份（上传） | 加密导出 → PUT 到远端（可手动触发，不依赖密码锁会话） |
| 下载恢复 | GET 远端最新备份 → 解密 → 导入（复用 backup.js merge/replace） |
| 定时自动备份 | `chrome.alarms`（新增 `alarms` 权限），周期可配（每日/每周），onInstalled 重建 alarm |
| 保留策略 | 远端仅保留最近 N 份，超出自动清理 |

**凭据安全**（延续 Phase 1 原则，杜绝明文）：
- WebDAV 服务器 URL/用户名/密码存 `storage.local` 新键 `cookie_switcher_webdav`
- 密码字段**加密存储**：密钥 = 密码锁派生密钥（与备份加密同源）→ 无密码锁无法保存 WebDAV 配置（options 引导先设锁）
- Basic Auth 头仅存在于 SW 执行期间内存中，不落盘

**与主线的关系**：WebDAV 是支线能力，不进入 popup 主流程（popup 不加载 webdav.js），只在 options 页配置 + background 静默执行，对三条主链路零侵入。

---

## 四、分阶段重构路线

### Phase 1 · 安全加固（不动接口，风险最低，先行）

- [x] 现状盘点（本文档）
- [ ] utils.js 内：删除 pin_raw；verifyPin 改 PBKDF2 + 旧格式兼容迁移；迭代 60 万
- [ ] 防暴力破解：failCount + lockedUntil + 指数冷却
- [ ] 导出/导入改为输入密码交互
- [ ] 密码锁接入 popup（锁屏遮罩层）
- [ ] **P0 修复：cookie value 加密落库（主密钥方案）+ partitionKey/storeId 透传 + 消息层（lib/messaging.js）前置**
- **产出**：v2.3.0，可独立发布

### Phase 2 · 模块化重构（行为不变，纯搬移）

- [ ] 拆 utils.js → lib/{crypto,storage,cookies,security,backup}.js
- [ ] background.js 改 importScripts 引入 lib，删除重复函数
- [ ] popup.html / options.html 改按需引入
- [ ] showStatus 等 DOM 函数迁入 UI 层
- **验证**：全功能回归（保存/切换/登录新账号/密码锁/白名单/导出导入/右键菜单）

### Phase 3 · 功能增强（叠加新能力）

- [ ] applyCookies 快照回滚
- [ ] 导入 merge/replace 模式
- [ ] 账号重命名（卡片编辑按钮）
- [ ] 过期 Cookie 跳过 + 提示
- [ ] 排序稳定化；删除 saveAccount 死参数
- **产出**：v2.4.0，可独立发布

### Phase 3.5 · WebDAV 远程备份（新增功能）

- [ ] `lib/webdav.js` 协议客户端（PROPFIND/GET/PUT/DELETE/MKCOL + Basic Auth）
- [ ] manifest 增加 `alarms` 权限；background 消息代理 + alarm 定时任务
- [ ] options 新增"WebDAV 备份"区块：配置（凭据加密存储）、连接测试、立即备份、下载恢复、保留策略
- [ ] 与密码锁强绑定（无锁不能配置 WebDAV）；远端文件复用 AES-GCM 加密格式
- [ ] 多语言补充（zh_CN + en）
- **产出**：v2.5.0

### Phase 4 · 清理与发布

- [ ] 删除 `onepage/index.html`、`20260704Final`
- [ ] 更新 README / DEVELOPMENT / AGENTS / CHANGELOG
- [ ] 打包 zip → Release（.pyp + icon 附件，按用户惯例）

---

## 五、风险与回退

| 风险 | 缓解 |
|------|------|
| 密码格式迁移失败 → 老用户锁死 | verifyPin 双格式兼容；迁移在验证成功后异步执行，失败不影响验证结果 |
| importScripts 顺序错误 → SW 全挂 | Phase 2 后立即在 `edge://extensions/` 加载解压扩展回归；关键路径加 try/catch 日志 |
| 回滚逻辑误删数据 | 快照仅保存在内存（不落盘），回滚失败时保留失败明细供用户手动处理 |
| 改动面大、一次合入风险高 | 严格按 Phase 1→4 推进，每阶段独立可发布 |
| storage.local 配额（10MB） | 远期可评估分域名存储或 IndexedDB（不在本次范围） |
| **WebDAV 服务器不支持 CORS** | 走 SW 代理 + host_permissions 绕过（3.6 已述）；连接测试按钮先行验证 |
| **WebDAV 凭据泄漏** | 密码加密存储（锁派生密钥）+ Basic Auth 仅在 SW 内存；远端文件本身已 AES-GCM 加密，服务器管理员也读不到明文 |
| **alarm 定时备份在 SW 休眠时丢失** | chrome.alarms 由浏览器唤醒 SW（MV3 标准机制），onInstalled 重建 alarm；失败记录写入 storage 供下次重试 |

---

## 六、验收标准

1. 安装 v2.5.0 后，v2.2.0 已有账号数据**无感迁移**（含密码锁用户首次验证通过后自动升级存储格式、cookie value 自动加密）
2. 密码锁开启时，打开弹窗必须输入密码，连续错 5 次进入锁定
3. 导出文件在无密码时无法解密（不再依赖明文副本）
4. 全功能回归通过：三条主链路 + 六条支线
5. 仓库无 `pin_raw` 明文、无重复函数、无冗余文件
6. **WebDAV**：连接测试 → 立即备份 → 远端可见加密文件 → 下载恢复成功；定时 alarm 触发备份（SW 休眠后仍执行）
7. **WebDAV 凭据**：storage.local 中无明文密码；未设密码锁时无法保存 WebDAV 配置
8. 远端文件不含任何明文数据（`{ version, data }` 中 data 为 AES-GCM 密文）
9. **P0 修复验证**：storage.local 抓取不到任何明文 cookie value；含 Partitioned Cookie 的站点（如第三方登录页）保存/切换后登录态完整；`chrome.storage.local.getBytesInUse` 监控生效
