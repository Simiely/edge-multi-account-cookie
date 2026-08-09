# 开发文档（DEVELOPMENT.md）

> 面向开发者的项目文档：架构说明 + 关键问题与方案（一坑一篇）。
> 每个问题用统一格式：**TL;DR**（一句话结论）→ 问题 / 根因 / 解决 / 预防。

## 项目概览

Edge/Chrome MV3 扩展（v2.11.2），保存和切换多网站账号 Cookie。Cookie value 明文存储（与浏览器自身 Cookies 数据库一致）+ 密码锁（PBKDF2 + 防爆破）+ WebDAV 远程备份（整包加密），纯原生 JS 零依赖。设计原则：权限最小化、popup 直调 cookie 操作（**切换/清除严禁进 SW**，见 §37）、消息层收口（WebDAV 前置）、杜绝供应链风险。

## 架构说明

```
edge-multi-account-cookie/
├── manifest.json        # MV3 配置（含 key 固定扩展 ID、alarms 权限）
├── background.js        # Service Worker：importScripts 装配 + 消息路由 + 右键菜单 + 定时备份
├── lib/                 # 核心层（无 DOM 依赖，纯逻辑）
│   ├── crypto.js        # 加密：AES-GCM + PBKDF2(60w) + 主密钥 + 分块 base64
│   ├── storage.js       # 数据层：账号 CRUD + 版本迁移 + 主密钥落盘
│   ├── cookies.js       # Cookie/页面数据 + applyCookies（partitionKey/回滚）
│   ├── security.js      # 密码锁 + 防暴力破解 + PIN 会话缓存
│   ├── backup.js        # 本地导出/导入（smart 智能合并 v2.7.4）+ 元数据标记 + webdav.sync 复用
│   ├── webdav.js        # WebDAV 协议客户端（SW 内执行，默认 URL + 逐级建目录）
│   └── messaging.js     # 消息层（sendMessage + sender 校验 + action 分发）
├── handlers/            # SW action 处理器（按域拆分，background 只做装配）
│   ├── account.js       # 账号切换 account.switch（v2.9.x 重构：核心抽至 lib/cookies.switchAccount，popup 与右键菜单共用）
│   ├── settings.js      # 设置 / 密码锁 / 主密钥
│   ├── backup.js        # 本地备份（口令策略：有锁自动 / 无锁 NEED_PIN）
│   └── webdav.js        # WebDAV 备份（URL 留空默认 + base64 认证）
├── popup.html/js        # 弹窗 UI（珊瑚粉 B v2：身份锚点 + 账号卡片 + 图标栏）
├── options.html/js      # 设置页（珊瑚粉 S2：状态栏 + 分区卡片）
├── ui/                  # 页面视图层（参数驱动纯函数，无共享状态）
│   ├── popup-render.js  # 弹窗渲染：账号卡片/分组/状态栏（含 GROUP_COLORS 分组色）
│   ├── popup-ui.js      # 弹窗视图：身份区/授权横幅/保存面板
│   └── webdav-options.js# 设置页 WebDAV 区块（测试/保存/推送/拉取）
├── _locales/            # zh_CN + en 多语言
├── assets/              # 图标
└── key.pem              # 扩展私钥（固定 ID 用，不提交 Git）
```

**分层原则**：UI（popup/options + ui/* 视图层）→ `sendMessage(action)` → background 消息路由 → handlers/*（按域）→ lib/* → chrome API → 结果回传。**页面层零 chrome.* 直调**（仅 permissions 手势必需）；视图层纯函数参数驱动，可脱离浏览器单测。

**数据流**：UI 层（popup/options）→ `sendMessage(action)` → background 消息路由 → lib/* → chrome API → 结果回传。

## 关键问题与方案

### 1. scripting 权限缺失

**TL;DR**：MV3 中 `scripting` 是独立 permission，必须显式声明，否则 `executeScript()` 静默失败。

### 2. Cookie API 需要 host_permissions（三层防线）

**TL;DR**：**`cookies` 权限不包含主机权限**——`getAll` 返回空数组**不报错**，永远检测不到。三层防线：`activeTab`（点击临时权限）+ `optional_host_permissions`（按需申请）+ **`chrome.permissions.contains()` 主动检测**（不等 API 报错）。

### 3. Cookie URL 前导点号导致 remove 失败

**TL;DR**：Cookie `domain` 以 `.` 开头，拼接 URL 成 `http://.example.com/` **非法 URL**，remove 静默失败。set/remove 前必须 `slice(1)` 去点号（lib/cookies.js cookieUrl 已处理）。

### 4. contextMenus 崩溃 + Service Worker 注册失败

**TL;DR**：① Edge 需要显式声明 `contextMenus` 权限（Chrome 文档说不需要，**Edge 需要**）；② `type: "module"` 无实际 import/export 时 Edge 解析失败——不加。

### 5. Edge 解压缩扩展的加载路径

**TL;DR**：Edge 将扩展复制到 `User Data\Profile X\UnpackedExtensions\`，**修改原始目录不影响副本**。改源码前先确认 `edge://extensions/` 卡片上的实际加载位置。

### 6. JSON 中文乱码（GitHub API）

**TL;DR**：Git Bash curl 传含中文 JSON 时编码被破坏。用 Python `urllib.request` + `ensure_ascii=False` 编码 UTF-8。

### 7. Windows SSL/TLS 握手失败

**TL;DR**：`schannel: failed to receive handshake`。临时方案 `GIT_SSL_NO_VERIFY=1 git push` / `curl -sk`（仅限可信环境）。

### 8. Maximum call stack size exceeded（栈溢出）

**TL;DR**：`btoa(String.fromCharCode(...packed))` 展开运算符把整个 Uint8Array 拆成参数，大数据量超 JS 参数限制。**按 8KB 分块**；解密侧 `atob().split('').map()` 也改 for 循环（lib/crypto.js 已处理）。

### 9. Toggle 开关卡在半中间

**TL;DR**：`.form-row label { min-width: 70px }` 没排除 toggle 容器，滑块视觉卡中间。**`:not(.toggle)` 排除**。

### 10. 密码明文存储（v2.5.0 修复）

**TL;DR**：v2.2 曾把密码原文存 `cookie_switcher_pin_raw` 供导出免输入——任何能读 storage 的途径都能拿到密码。**已删除**，导出改为用户输入密码。密码锁验证改 PBKDF2(salt, 60 万次) 盐值哈希，兼容旧 SHA-256 格式自动迁移。

### 11. 重装扩展后密码丢失

**TL;DR**：`chrome.storage.local` **按扩展 ID 隔离**；无 `key` 的扩展每次加载生成随机 ID → 旧数据被隔离。**manifest 加 `key`（RSA 公钥 SPKI Base64）固定扩展 ID**。

### 12. MV3 Service Worker 注册规范

**TL;DR**：`background.service_worker` 必须是**字符串**；不能有 `background.persistent`；**监听器必须在顶层同步注册**（放 promise/回调内可能丢失）；importScripts 顺序敏感（crypto → storage → cookies → security → backup → webdav → messaging）。

### 13. 权限最小化原则

**TL;DR**：`<all_urls>` 安装即授权所有网站（低安全）；`activeTab` + 按需授权（高安全，多一次点击）。本项目用 activeTab + optional_host_permissions + permissions.request 三层机制。

### 14. Cookie value 明文落库（v2.5.0 P0 修复）

**TL;DR**：README 曾声称"AES 加密存储"，实际 v2.2 的 cookie value 明文存 storage.local。**引入设备主密钥（Master Key）**：随机 256bit MK 加密每个 value；有锁时 MK 被锁派生密钥包裹（wrapped），会话内明文缓存在 `chrome.storage.session`（重启失效）。`getMasterKey()` 有锁未解锁时返回 null，调用方须先 `pin.unlock`。

### 15. PBKDF2 密码哈希不能用 exportKey

**TL;DR**：`deriveKey()` 产出的 CryptoKey `extractable=false`，`exportKey('raw')` 抛 "key is not extractable"。**密码哈希用 `crypto.subtle.deriveBits(..., 256)`** 直接取字节转 hex（lib/security.js setPin/verifyPin）。

### 16. 防暴力破解

**TL;DR**：v2.2 的 verifyPin 无失败限制。**新增 `verifyPinWithLock()`**：连续失败 5 次锁 60s，失败每 +5 锁定翻倍；所有密码验证必须走它，禁止直调 verifyPin。

### 17. Partitioned Cookie（CHIPS）丢失（v2.5.0 P0 修复）

**TL;DR**：Chrome 119+ 的 Partitioned Cookie 有 `partitionKey`，v2.2 完全忽略 → 保存后切换丢登录态。**全链路透传 `partitionKey` + `storeId`**（lib/cookies.js setCookie/removeCookie/getAll）。

### 18. 消息层（MV3 通信最佳实践）

**TL;DR**：MV3 下 popup/options/SW 独立上下文，直接调 chrome.* 难以测试、WebDAV 又必须走 SW。**新增 lib/messaging.js**：页面 `sendMessage(action, payload)` Promise 封装（60s 超时）；SW `registerMessageHandler(handlers)` 校验 sender.id + action 白名单 + **`return true` 保活异步通道**。新增 action 必须两侧同步注册。

### 19. WebDAV 的 CORS 与凭据安全

**TL;DR**：WebDAV 服务器普遍无 CORS 头，页面 fetch 被拦截。**必须由 SW 执行**（host_permissions 绕过）；域名在 options 页（用户手势）`permissions.request` 按需授权。凭据：密码用主密钥加密存 `passEnc`，明文仅在 SW 内存。备份文件用 WebDAV 密码做 AES-GCM 口令加密——服务器管理员不可读。

### 20. 数据版本迁移

**TL;DR**：v2 的 `DATA_VERSION=2` 无迁移逻辑。**storage.js 现为 v3**，读取时惰性迁移，失败降级返回 + `migrationPending` 标记下次重试，不阻塞使用。⚠️ **迁移方向已变更（本条描述 v2.5.0 的"明文 → MK 加密"，已被 v2.6.0 明文存储决策取代，正确做法见 §26）**：实际 v3 迁移为补全 `partitionKey/storeId` 字段 + 兼容旧 `enc:` 数据（`migratePlainValues` 自动解为明文），**cookie value 最终为明文存储**（§26，4KB 上限所限），不再是 MK 加密。

### 21. 备份口令策略（v2.5.0）

**TL;DR**：备份口令与密码锁统一——**有锁自动用锁密码**（`cachePinInSession` 在 `pin.unlock`/`pin.set` 成功后把明文 PIN 缓存到 `storage.session`，仅会话有效）；无锁抛 `NEED_PIN` 让 UI 弹窗。导入先自动试锁密码、失败回退 `NEED_PIN`（兼容 WebDAV 密码/历史口令）。**坑**：明文 PIN 只在 session 缓存、不落盘；关闭密码锁必须 `clearPinSessionCache()`。

### 22. WebDAV 默认 URL 与固定备份目录（v2.5.0）

**TL;DR**：用户要求"URL 留空用默认地址、界面不提示"。`normalizeWebdavUrl` 仅去空白+留空兜底默认（**不自动补协议**——填裸 IP 报格式错误是刻意行为）；备份固定存 `workbuddy/网页账号管理/`（URL 编码常量 `BACKUP_DIR`），`ensureBackupDir` **逐级 MKCOL**（MKCOL 一次只能建一层，父目录缺失会 409）。Basic Auth 用 `btoa(unescape(encodeURIComponent(user:pass)))` 支持中文。

### 23. UI 视图层拆分原则（v2.5.0 重构）

**TL;DR**：popup.js 曾 418 行。按"**参数驱动纯视图拆出、状态编排留主文件**"原则：`ui/popup-ui.js`（身份区/横幅/面板）+ `ui/popup-render.js`（卡片/分组/状态栏）。视图函数零共享状态（`renderIdentity({domain,granted})` 等），18 项冒烟测试因纯函数化全部可独立验证。**坑**：`script` 顺序敏感（popup-render → popup-ui → popup），视图函数必须先行注册。

### 24. 数据一致性保护（P1 硬伤修复）

**TL;DR**：① `applyCookies` 快照失败时静默丢失回滚能力 → 新增 `snapshotFailed` 上报；② `site.clear` cookie 清除有失败仍清 localStorage → **失败时不刷 localStorage**（防半退出），popup/右键菜单同步提示。

### 25. Edge SW 上下文 cookies API 读取失效（v2.6.0 P0 修复，花瓣登录根因）

**TL;DR**：**Edge 的 Service Worker 中 `chrome.cookies.getAll` 读不到 cookie**（CDP 实测：同一 host 授权下 SW 返回 0 个、popup 页面返回 12 个）。v2.5 把保存/切换/清除迁到 SW（为 WebDAV CORS），导致保存读到 0 个 cookie → 切换无效。**修复：cookie 操作全部改回 popup 直调**（activeTab + 持久授权均可用，同 v2.2）；SW 只保留 WebDAV/定时/右键。**教训：cookie 相关 API 不要放 SW，页面上下文才可靠。**

### 26. Cookie 明文存储决策（v2.6.0）

**TL;DR**：AES-GCM 加密使 cookie value 膨胀 1.35 倍，原始值 >3072B 加密后超浏览器 4096 上限 → `chrome.cookies.set` 失败 → 切换丢失登录态。**改为明文存储**（与浏览器自身 Cookies 数据库明文一致，安全级别相当）；备份/导出仍整包加密。旧 enc: 数据兼容（applyCookies 保留解密）+ `data.migratePlain` 自动迁移为明文（幂等）。**教训：cookie value 有 4KB 硬上限，任何膨胀型处理（加密/编码）都会踩雷。**

### 27. getCookies 父域链查询（v2.6.0）

**TL;DR**：`chrome.cookies.getAll({domain})` 只精确匹配该域，**不返回子域 cookie**（如 ums.huaban.com 的 locale）。`getCookies` 同时查 domain / .domain / 父域链合并去重，覆盖子域，修复"清除不干净"（清除后花瓣 JS 会自动补种游客统计 cookie，属正常现象，登录核心是 auth_key 不重种）。

### 28. 多套会话混存（v2.7.0 P0 修复，登录失效根因）

**TL;DR**：`getCookies` 合并主域/父域/带点/不带点查询后，同名 cookie 可能多条（如 `.www.codebuddy.cn` 与 `www.codebuddy.cn` 各一套 KEYCLOAK_SESSION/AUTH_SESSION_ID/KEYCLOAK_IDENTITY，值不同）。保存时全量入库 → 切换时两套会话交叉写入 → Keycloak 校验失败 → "登录不了"（且无任何预警）。**修复：保存前 `dedupeCookies()` 按同名去重，保留 domain 带前导点的域 cookie；值不同则提示"疑似多套会话混存"。** 教训：cookie 快照类扩展必须做"保存时去重 + 切换前自检"，坏数据不能等到用户切换才暴露。

### 29. 会话存活探测（v2.7.0，该功能已在 v2.10.x 移除）

**TL;DR**：cookie 快照的 token 未过期但服务端会话可能已被清理（如 Keycloak SSO 会话过期/账号登出），切换后无感知。**修复：新增 `lib/health.js` `probeSession()`——请求 `https://{domain}/auth/realms/{realm}/protocol/openid-connect/userinfo`（realm 从 cookie path `/auth/realms/{realm}/` 提取），200=ok / 401=expired / 其他=unknown**。注意四点：① 探测须在 popup 直调（同 §25，SW 读不到 cookie）；② 无 host_permissions 时 fetch 会被 CORS 拦，**必须降级为 unknown 而非 expired**（否则误报失效）；③ 非 Keycloak 站点 realm 提取失败直接 unknown 跳过；④ **认证必须用 `Authorization: Bearer <KEYCLOAK_IDENTITY>`（OIDC 标准）而非 cookie**——cookie 方式在很多 realm 配置下恒定 401，会导致"能切换却提示失效"的误报（用户实测反馈）；无 KEYCLOAK_IDENTITY 时才退回 cookie 方式。

### 33. 切换结果以用户可见为准（v2.7.0 实测修正，v2.10.x 简化）

**TL;DR**：旧版曾因切换后探测 expired 仍把账号标红，导致"能真实切换却显示失效"。**教训：交互场景（用户正在切换）以切换操作结果为准，不要再用独立探测结论覆盖用户可见状态。** v2.10.x 移除会话探测后，切换逻辑简化为「清→写→reload」，切换成功即视为成功，UI 不再依赖 health 绿点/红点。

### 34. 保存去重误删 host-only cookie（v2.7.2 P0 修复，登录失效根因）

**TL;DR**：v2.7.0 为"防多套会话混存"加了保存前按 `name` 去重（`dedupeCookies`），**按 name 分组会误删不带前导点的 host-only cookie**（如 `KEYCLOAK_SESSION@www.codebuddy.cn`）。但**域 cookie（`.www.codebuddy.cn`）与 host-only cookie（`www.codebuddy.cn`）是浏览器中并存的两套合法 cookie**，Keycloak 登录需要同时存在——删掉后切换缺 cookie → 登录失败（v2.6.0 无此逻辑，实测正常登录）。**修复：彻底移除按 name 去重，恢复原样保存**（`getCookies` 已按 `name|domain|path` 去重，粒度正确）；`dedupeCookies` 重写为只读诊断 `detectDuplicateNames`（仅提示不修改）。**教训：cookie 去重必须按 name+domain+path 粒度；"同名"≠"重复"，域 cookie 与 host-only cookie 同名并存是正常态。改动保存逻辑前先用 v2.6.0 行为做回归基准。**

### 36. 删除同步墓碑机制（v2.10.0）

**TL;DR**：快照式同步中"删除"无法传播——本地删除账号后，远端旧备份还有该账号，下次同步又被 smart 合并拉回来（"远端有本地无"无法区分"你删了"与"从未存在/别人新增"）。**修复（业界标准 tombstone，参考 Storyie 本地优先同步 / DataStax grace period / Figma TTL）**：① `deleteAccount` 改为**软删除**——保留骨架 `{deleted:true, deletedAt}` 清空 cookies/localStorage，删除成为可观察可同步的变化；② `importData` smart 合并加墓碑分支：远端活跃 vs 本地墓碑 → `inc.updatedAt > existing.deletedAt` 才**复活**否则保持；远端墓碑 vs 本地活跃 → 本地 `updatedAt > 墓碑时间` 保留否则**删除传播**；远端墓碑 vs 本地无 → 幂等导入；③ `purgeOldTombstones` TTL 30 天（保存/同步后清理，防无限累积）；④ **所有读取点过滤**：`getDomainAccounts` 统一过滤墓碑（账号列表/统计/菜单/体检自动受益），`loadRawDataStat` 单独过滤，体检靠"墓碑无 cookies 自动跳过"。**坑**：墓碑三配套缺一不可（合并规则 + TTL + 全读取点过滤）；`saveAccount` 整体替换墓碑=复活（无残留）；`renameAccount` 保留 deleted 状态；墓碑 `deletedAt=0`（异常）按保守复活处理；墓碑极小时备份不膨胀；UI 删除提示"将在下次同步时同步到其他设备"。

### 37. 切换必须 popup 直调（v2.11.1 P0 修复，切换失效根因）

**TL;DR**：**Edge/Chrome 的 MV3 Service Worker 中 `chrome.cookies.getAll` 读不到浏览器主会话的 cookie**（CDP 实测：同一 host 授权下 SW 返回 0 个、popup 页面返回 12 个；Chromium 官方将 SW 的 cookie 访问标记为 *intentionally restricted*）。v2.9.0"共享切换核心"重构把切换经 `account.switch` 消息层收口到 **SW 执行 `applyCookies`**，导致：快照 `getCookies` 返回空 → **清除旧 cookie 阶段失效（清除 0 个）→ 新旧会话混存 → 服务端（如 Keycloak/SSO）校验失败 → 用户实测"新录入账号很快过期/需重新登录"**（v2.2 切换在 popup 页面直调，一直正常）。**修复**：① `popup.js handleSwitchAccount` 直接调共享核心 `switchAccount()`（popup 上下文 getAll 可靠），不再走消息层；② `applyCookies` 清除**双保险**——先按待写入已知列表逐个 `remove`（remove 只需 url+name，不依赖 getAll，SW/popup 双上下文都可靠）+ 快照补充移除（getAll 可靠时全量清干净）；③ 删除 `handlers/account.js` 与 `account.switch` action，SW 消息路由不再承载任何 cookie 写操作；④ 右键菜单移除"切换到此站点账号"（contextMenus.onClicked 只能在 SW 响应，SW cookie 写入不可靠），仅保留"清除 Cookie"（已知列表 + 全量双保险）。**教训**：cookie 类扩展的 cookie 操作**唯一归属 popup/页面上下文**，SW 只做 storage/WebDAV/事件监听；违反该原则的"重构"（为代码复用收口消息层）会引入难以察觉的 P0 回归——**改 cookie 链路前先 grep 确认没有 SW 执行路径**。

### 38. 清空数据必须墓碑化（v2.11.2 P1 修复，防清空传空）

**TL;DR**：设置页「清空本地账号数据」原实现 `chrome.storage.local.remove(STORAGE_KEY)` **物理删库、零墓碑**，完全绕过墓碑机制（§36）→ ①远端有备份时：同步拉取把账号全部"复活"回本地（清空被撤销，远端无从得知你清空了）；②远端无备份时：同步把**空数据上传**，远端备份被空覆盖 → 本地已清 + 远端也空 → **账号数据永久丢失**。**修复**：① `data.clearAll` 改为**墓碑化全部账号**（`deleted:true + deletedAt:now`，清空 cookies、保留骨架，与逐账号删除语义一致）→ 清空可跨设备传播（同步时墓碑上传）、远端旧账号（updatedAt < deletedAt）不复活、导出/上传的是含墓碑的数据而非空；② `webdav.sync` 上传前兜底：合并后本地条目（含墓碑）为 0 时**跳过上传**（`pushed=null`），杜绝"把空传上去"；③ popup/设置页同步提示处理 `pushed=null`（显示"本地无数据，未上传"，不再 TypeError 崩溃）。**坑**：墓碑化后本地非空（有墓碑）→ 不触发兜底 → 正常上传传播；只有"物理空"（异常/外部删库）才触发跳过；墓碑 TTL 30 天后 purge 变物理空 → 此时同步同样被兜底拦截，安全。

### 35. WebDAV 选"最新备份"不能按文件名（v2.7.5）

**TL;DR**：旧 `webdavPull` 按文件名排序取最后一份（文件名 = push 时刻）。但**文件名可被拷贝/手动上传/同步客户端改名**——目录里可能混入"文件名新、数据旧"的备份（如手动传的 7/4 旧文件叫今天的名字），按文件名会选错。**修复：逐个下载所有备份，优先按文件内 `__meta.exportedAt`（v2.7.3 起的导出时间标记，明文在加密内容内，需 `parseBackup` 解密读取）判定新旧；旧格式无 meta 或解密失败回退 `parseBackupStamp`（文件名 UTC 时间戳，`Date.UTC` 解析与 `Date.now()` 同基准可比）；损坏文件跳过、认证失败（401/403）整体终止**。**坑**：① meta 在加密内容内，选文件就必须解密——把"选文件"逻辑放 `webdavPull(config)`（config 含 pass 仅内存），`parseBackup` 依赖 backup.js 需在其后加载（importScripts 顺序已满足）；② 文件名时间戳用 `toISOString()`（UTC），`__meta.exportedAt` 用 `Date.now()`（UTC 毫秒），两者同基准可直接比较，勿混入本地时区。

### 30. 每日体检 alarm（v2.7.0，v2.10.x 已移除）

**TL;DR**：旧版 `chrome.alarms.create('session-health-check', {delayInMinutes: 24*60, periodInMinutes: 24*60})` 后台每日遍历账号 `probeSession` 更新 health。**该 alarm 与整套会话探测能力已在 v2.10.x 一并移除**（详见 §29）——当前版本无后台定时体检，也不维护 health 字段。保留此条仅为历史追溯。

### 31. 移除分组功能（v2.7.0）

**TL;DR**：分组（group）功能移除——用户不需要。删除面广：popup.html（inputGroup 元素 + .group-header/.group-tag CSS）、popup.js（inputGroup 引用、collapsedGroups、renderAccountList 分组排序/折叠、handleSaveAccount 传 group、handleEditAccount 分组 prompt）、ui/popup-render.js（GROUP_COLORS/avatarColors(group)/createGroupHeader/createAccountCard group 参数）、handlers/account.js（account.updateGroup action）、_locales（accountGroup/labelGroup 文案）。**保留**：lib/storage.js saveAccount 的 group 参数（调用方传 ''，旧数据兼容不破坏）。头像颜色改为按账号名哈希取色（AVATAR_PALETTE）。教训：删功能要从 UI → handlers → i18n 全链路 grep，storage 字段保守保留避免迁移风险。

### 32. WebDAV 测试连接复用已保存凭据（v2.7.0）

**TL;DR**：设置页保存 WebDAV 配置后密码框留空（placeholder"已保存"），再点「测试保存」前端校验 `if (!cfg.pass)` 直接报"请填写用户名与密码"——无法测试。**修复**：① SW 端 `webdav.test` 用户名/密码任一为空时自动 `getWebdavConfigDecrypted()` 复用已存凭据；② 前端 `handleWebdavTest` 检测到已保存配置且凭据留空时先 `ensureMasterKeyUnlocked()`（解密已存密码需要 MK）再调 SW。**坑**：复用已存密码必须走 SW 解密（getWebdavConfigDecrypted），前端拿不到明文；有密码锁时需先解锁 MK。v2.9.0 起该按钮为「测试保存」——测试连通后自动 `webdav.save`（密码留空保留已存），测试失败不保存。

## 主线逻辑关键点依据（GitHub / 官方求证，2026-08-08）

> 主线 = 保存账号 → 切换账号。每个关键决策都有官方文档或社区一手实证，改动前先读这里。

| # | 关键点 | 依据 |
|---|---|---|
| ① | 权限三层防线（cookies + host_permissions + contains 检测） | Chrome 官方 repo issue #455（`getAll` 返回空数组 = 缺 host_permissions，"No host permissions for cookies"）+ SO 50771902（cookies 与 host_permissions 缺一不可） |
| ② | Cookie 4KB 上限 → 明文存储决策 | Chrome 95 起强制 name+value ≤ 4096 字节、超限拒绝写入（Chrome Platform Status feature 4946713618939904，追踪 bug crbug.com/1225342，引 RFC 6265bis）——AES 加密膨胀 1.35 倍会超限，故 v2.6.0 改明文存储 |
| ③ | 域 cookie 与 host-only cookie 并存 | `domain=.a.com` 与 `domain=a.com` 是两个独立 cookie 条目（RFC 6265 host-only vs domain cookie；Chrome cookies API 文档）——v2.7.2 移除按 name 去重即因此 |
| ④ | cookie 操作 popup 直调（双轨） | MV3 cookie 扩展主流做法就是 popup/页面上下文直调（CookieJar，dev.to 作者亲述）；**MV3 SW 的 fetch 默认不带 SameSite cookie**，`credentials:'include'` 也无效、恒定 401，移到页面/content script 上下文立刻正常（AI Karma Tracker，dev.to 踩坑实证）；tabwipe 纯 SW 架构可做 cookie 但事件驱动、无 popup 交互，场景不同 |
| ⑤ | 切换"先清后写 + 快照回滚" | CookieJar 的 applyCookies 同模式（清空 → 写入 → 失败回滚） |
| ⑥ | 探测用 Keycloak userinfo Bearer 认证（历史参考） | Keycloak 官方文档：userinfo endpoint "is protected by a bearer token"（keycloak.org/securing-apps/oidc-layers）；社区实现全部 `Authorization: Bearer <access_token>`（Gamify-IT、skycloak 等）——v2.7.0 曾用 cookie 方式探测恒定 401 误报失效，改 Bearer 后正确。**注：会话探测能力已在 v2.10.x 整体移除，此条仅作历史溯源，当前版本不做存活探测。** |

**教训**：本插件"数据混乱 / 登录失效"的两大真实根因（v2.7.0 按 name 去重误删 host-only cookie；cookie 方式探测恒定 401 误报）都能在官方/社区资料中找到依据——改动前先求证，别凭直觉"修复"。

## 构建 & 发布

- 打包 ZIP：Python 脚本（排除临时脚本 pack_zip.py 与 .git 目录；key.pem 由 .gitignore 忽略）⚠️ 旧说明"排除 sim_test.cjs、lib/health.js"已过时（v2.10.x 已删除 health.js）
- 创建 Release：curl 方式（body 不要有中文）；上传 zip 到 releases assets
- GitHub API 中文数据用 Python `ensure_ascii=False`

## 开发环境

- Edge / Chrome + MV3；无构建工具；验证 = `edge://extensions/` 加载解压扩展
- 冒烟测试：node 22（Web Crypto 原生支持）直接 eval `lib/*.js` + mock `chrome.storage`，可验证加密/迁移/密码锁/防爆破逻辑
