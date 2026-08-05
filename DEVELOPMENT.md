# 开发文档（DEVELOPMENT.md）

> 面向开发者的项目文档：架构说明 + 关键问题与方案（一坑一篇）。
> 每个问题用统一格式：**TL;DR**（一句话结论）→ 问题 / 根因 / 解决 / 预防。

## 项目概览

Edge/Chrome MV3 扩展（v2.6.0），保存和切换多网站账号 Cookie。Cookie value 明文存储（与浏览器自身 Cookies 数据库一致）+ 密码锁（PBKDF2 + 防爆破）+ WebDAV 远程备份（整包加密），纯原生 JS 零依赖。设计原则：权限最小化、popup 直调 cookie 操作、消息层收口（WebDAV 前置）、杜绝供应链风险。

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
│   ├── backup.js        # 本地导出/导入（merge/replace）
│   ├── webdav.js        # WebDAV 协议客户端（SW 内执行，默认 URL + 逐级建目录）
│   └── messaging.js     # 消息层（sendMessage + sender 校验 + action 分发）
├── handlers/            # SW action 处理器（按域拆分，background 只做装配）
│   ├── tab.js           # 标签页 / 权限检测
│   ├── account.js       # 账号 CRUD / 切换 / 清场
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

**TL;DR**：v2 的 `DATA_VERSION=2` 无迁移逻辑。**storage.js 现为 v3**，读取时惰性迁移（明文 value → MK 加密），失败降级返回 + `migrationPending` 标记下次重试，不阻塞使用。

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

## 构建 & 发布

- 打包 ZIP：Python 脚本（排除 .gitignore/CODE_REVIEW.md/key.pem/REFACTOR_*.md，剔除 .git 目录）
- 创建 Release：curl 方式（body 不要有中文）；上传 zip 到 releases assets
- GitHub API 中文数据用 Python `ensure_ascii=False`

## 开发环境

- Edge / Chrome + MV3；无构建工具；验证 = `edge://extensions/` 加载解压扩展
- 冒烟测试：node 22（Web Crypto 原生支持）直接 eval `lib/*.js` + mock `chrome.storage`，可验证加密/迁移/密码锁/防爆破逻辑
