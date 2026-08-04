# 开发文档（DEVELOPMENT.md）

> 面向开发者的项目文档：架构说明 + 关键问题与方案（一坑一篇）。
> 每个问题用统一格式：**TL;DR**（一句话结论）→ 问题 / 根因 / 解决 / 预防。

## 项目概览

Edge/Chrome MV3 扩展（v2.5.0），保存和切换多网站账号 Cookie。AES-256-GCM 加密存储（主密钥方案）+ 密码锁（PBKDF2 + 防爆破）+ 域名白名单 + WebDAV 远程备份，纯原生 JS 零依赖。设计原则：权限最小化、数据本地加密、消息层收口、杜绝供应链风险。

## 架构说明

```
edge-multi-account-cookie/
├── manifest.json        # MV3 配置（含 key 固定扩展 ID、alarms 权限）
├── background.js        # Service Worker：消息路由 + 右键菜单 + 定时备份
├── lib/                 # 核心层（无 DOM 依赖）
│   ├── crypto.js        # 加密：AES-GCM + PBKDF2(60w) + 主密钥 + 分块 base64
│   ├── storage.js       # 数据层：账号 CRUD + 版本迁移 + 主密钥落盘
│   ├── cookies.js       # Cookie/页面数据 + applyCookies（partitionKey/回滚）
│   ├── security.js      # 密码锁 + 防暴力破解 + 白名单
│   ├── backup.js        # 本地导出/导入（merge/replace）
│   ├── webdav.js        # WebDAV 协议客户端（SW 内执行）
│   └── messaging.js     # 消息层（sendMessage + sender 校验 + action 分发）
├── popup.html/js        # 弹窗 UI
├── options.html/js      # 设置页
├── _locales/            # zh_CN + en 多语言
├── assets/              # 图标
└── key.pem              # 扩展私钥（固定 ID 用，不提交 Git）
```

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

## 构建 & 发布

- 打包 ZIP：Python 脚本（排除 .gitignore/CODE_REVIEW.md/key.pem/REFACTOR_*.md，剔除 .git 目录）
- 创建 Release：curl 方式（body 不要有中文）；上传 zip 到 releases assets
- GitHub API 中文数据用 Python `ensure_ascii=False`

## 开发环境

- Edge / Chrome + MV3；无构建工具；验证 = `edge://extensions/` 加载解压扩展
- 冒烟测试：node 22（Web Crypto 原生支持）直接 eval `lib/*.js` + mock `chrome.storage`，可验证加密/迁移/密码锁/防爆破逻辑
