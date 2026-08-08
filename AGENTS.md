# AGENTS.md · 项目规则

> 写给 AI / 未来维护者的项目上下文。只记录代码里看不出的信息。

## 技术栈

- **Manifest V3** Edge/Chrome 扩展，纯原生 JS **零第三方依赖**（杜绝供应链风险）
- 加密：Web Crypto API（AES-256-GCM + PBKDF2，迭代 60 万次）；存储：`chrome.storage.local`（数据）+ `chrome.storage.session`（主密钥会话缓存）
- 权限模型：`activeTab` + `optional_host_permissions` + 按需 `chrome.permissions.request()`
- **消息架构（双轨，刻意设计）**：cookie 操作在 **popup 直调 lib**（`getCookies`/`applyCookies` 等，v2.6.0 起——Edge SW 上下文 `cookies.getAll` 读不到 cookie，见坑 25）；SW 侧保留 action 消息层（settings/backup/webdav 等无 cookie 依赖的操作走 `sendMessage`）。**不要**把 cookie 操作改回 SW 消息路由（MV3 SW fetch 不带 SameSite cookie、可休眠，社区验证 popup/页面上下文直调是 cookie 类扩展的正确方向）

## 目录结构（v2.5.0 起）

```
├── manifest.json        # MV3 配置（key 固定 ID；permissions 含 alarms）
├── background.js        # SW 入口：importScripts 装配 + 右键菜单 + alarms 定时备份
├── lib/                 # 核心层（无 DOM 依赖，页面/SW 通用）
│   ├── crypto.js        # AES-GCM + PBKDF2(60w) + 主密钥 + 分块 base64 —— 零 chrome API
│   ├── storage.js       # storage.local CRUD + 账号模型 + 版本迁移 + 主密钥落盘
│   ├── cookies.js       # Cookie/页面数据操作 + applyCookies（partitionKey/回滚）+ 共享 switchAccount 核心
│   ├── security.js      # 密码锁（PBKDF2 + 防爆破）
│   ├── backup.js        # 本地导出/导入（smart 智能合并 v2.7.4）+ 元数据标记 + diffBackup 核对
│   ├── webdav.js        # WebDAV 协议客户端（SW 内执行）+ 内容感知选最新备份（v2.7.5）
│   └── messaging.js     # 消息层：sendMessage 封装 + sender 校验 + action 分发
├── handlers/            # SW 消息路由 action（按域拆分，background importScripts 加载）
│   ├── account.js       # account.switch（v2.9.x 重构：共享切换核心，popup 与右键菜单共用）
│   ├── settings.js      # options.get / pin.* / masterkey.available / data.*
│   ├── backup.js        # backup.export / backup.import
│   └── webdav.js        # webdav.*（test/save/sync/remove；push/pull/preview 已随 v2.9.0 同步按钮合并移除）
├── ui/                  # UI 侧按功能拆分的脚本（参数驱动纯视图，无共享状态）
│   ├── popup-render.js  # 弹窗纯渲染：createAccountCard（行为回调注入）/ showStatus
│   ├── popup-ui.js      # 弹窗身份区/授权横幅/保存面板 视图
│   ├── webdav-options.js# 设置页 WebDAV 区块逻辑（fillWebdavSettings/bindWebdavEvents）
│   └── ui-helpers.js    # 跨页面共享 UI 工具（showMsg）——单一来源，勿在页面文件重复定义
├── popup.html/js        # 弹窗 UI（锁屏遮罩 + 账号列表）
├── options.html/js      # 设置页（密码锁/备份/WebDAV）
├── _locales/            # zh_CN + en
└── assets/              # 图标
```

## 关键坑（改代码前必读）

1. **权限三层防线**：`cookies` 权限**不包含主机权限**（官方：cookies permission does not imply host permissions）——`getAll` 返回空数组不报错，永远检测不到。用 `chrome.permissions.contains({origins})` **主动检测**，配合 activeTab + optional_host_permissions
2. **MV3 Service Worker 规范**：`service_worker` 必须是**字符串**；不能有 `background.persistent`；**监听器必须在顶层同步注册**（不能放 promise/回调里，可能丢失）
3. **Cookie URL 前导点号**：Cookie `domain` 以 `.` 开头（`.example.com`），拼 URL 得 `http://.example.com/` 非法——`set/remove` 前必须 `slice(1)` 去点号（`lib/cookies.js` cookieUrl 已处理）
4. **重装丢数据**：`chrome.storage.local` 按扩展 ID 隔离，manifest `key`（RSA 公钥 SPKI Base64）固定扩展 ID（key.pem 私钥不提交 Git）
5. **栈溢出**：`btoa(String.fromCharCode(...packed))` 展开运算符拆大数组超参数限制 → **按 8KB 分块**；解密侧 `atob().split('').map()` 也改 for 循环（`lib/crypto.js` 已处理）
6. **Edge 特有**：`contextMenus` 权限 Edge 必须显式声明；`type: "module"` 无实际 import/export 时 Edge 解析失败（不加）；加载扩展时 Edge 复制到 UnpackedExtensions，改源码要确认实际加载路径
7. **importScripts 顺序敏感**：background.js 先引入 lib/（crypto → storage → cookies → security → backup → webdav → messaging）再引入 handlers/（account → settings → backup → webdav）——webdav.js 依赖 backup.js 的 parseBackup，顺序不可乱
8. **主密钥（Master Key）机制**：cookie value 落库一律 `'enc:' + encryptWithKey(value, MK)`；无锁时 MK 明文落盘，有锁时 MK 被锁派生密钥包裹（wrapped=true）。`getMasterKey()` 优先读 session 缓存——**有锁且本会话未解锁时返回 null**，调用方必须先走 `pin.unlock`
9. **PBKDF2 密码哈希用 deriveBits**：`deriveKey()` 产出的 CryptoKey `extractable=false`，不能 `exportKey` 取哈希——密码验证哈希用 `crypto.subtle.deriveBits(..., 256)` 直接取字节
10. **防暴力破解**：所有密码验证必须走 `verifyPinWithLock()`（含 failCount/lockedUntil 检查），禁止直接调 `verifyPin()`
11. **partitionKey / storeId**：保存 cookie 时**必须**记录 `partitionKey`（Chrome 119+ CHIPS）与 `storeId`，切换/清除时原样透传，否则 Partitioned Cookie 丢失
12. **消息层契约**：新增 action 必须写入对应 `handlers/*.js` 的 action 表（settings/backup/webdav），background.js 用 `{...SETTINGS_ACTIONS, ...BACKUP_ACTIONS, ...WEBDAV_ACTIONS}` 合并注册；监听器异步响应必须 `return true` 保活；页面统一 `sendMessage(action, payload)`（自动超时 60s）。**cookie 类操作（读/写/切换）不要新增 SW action**——popup 直调 lib（见双轨说明）
13. **WebDAV 必须在 SW 执行**：页面 fetch WebDAV 会被 CORS 拦截，只有 SW + host_permissions 可绕过；WebDAV 密码用主密钥加密存 `cookie_switcher_webdav.passEnc`，明文口令仅在 SW 内存中出现
14. **数据版本迁移**：`DATA_VERSION=3`（storage.js），读取时惰性迁移，失败标记 `migrationPending` 不阻塞
15. **权限最小化**：不用 `<all_urls>`，按需授权；WebDAV 服务器域名在 options 页 `permissions.request`（必须用户手势上下文）
16. **permissions.request 禁止走 SW 消息路由**：`chrome.permissions.request()` 必须在 popup/options 页面（用户手势上下文）**直接调用**——经 sendMessage 到 SW 会报 `This function must be called during a user gesture`。SW 里只能做只读检测 `permissions.contains`（background 中仅提供 `permission.check`，无 `permission.ensure`）
17. **禁止按 name 去重 cookie（v2.7.2 P0 教训）**：`getCookies` 已按 `name|domain|path` 去重（正确粒度）。**不要**再按 name 额外去重——域 cookie（`.a.com`）与 host-only cookie（`a.com`）同名并存是浏览器合法状态（Keycloak 常同时设置两套，登录都需要）。v2.7.0 曾按 name 去重误删 host-only cookie 导致切换登录失败（用户实测 v2.6.0 正常，对比定位）。保存逻辑改动前以 v2.6.0 行为为回归基准
18. **会话存活探测（v2.7.0 引入，v2.10.x 已移除）**：旧版曾用 `lib/health.js` 的 `probeSession()` 请求 Keycloak userinfo 探测服务端会话是否过期，并维护账号 `health` 字段（ok/unknown/expired）+ 每日体检 alarm。该能力已在 **v2.10.x 整体移除**（理由：探测依赖第三方 realm、跨域易误报、维护成本高，对核心「保存/切换」无增益）。移除项：`lib/health.js`、`updateAccountHealth()`、账号 `health`/`lastVerifiedAt` 字段、右键菜单 ⚠️ 失效标记、后台 `session-health-check` 每日 alarm。切换逻辑现只做「清→写→reload」，不再做存活探测。详见 DEVELOPMENT.md §29 / §30。
19. **账号健康字段（v2.10.x 已移除）**：旧版 `saveAccount` 默认 `health:'unknown', lastVerifiedAt:0`，并提供 `updateAccountHealth()` 维护绿点/红点。该字段与探测能力一并移除（v2.10.x）——账号数据不再含 `health` 字段，UI 卡片不再显示健康绿点/红点，无每日体检。**切换成功即视为成功**，不做额外存活探测。**新增/迁移字段仍须保证旧数据兼容**（缺失字段按安全默认处理，不破坏既有账号）。

## 约定

- 密码锁存 PBKDF2(salt+hash)（`{format:'pbkdf2', salt, hash}`），兼容旧 SHA-256 hex 字符串格式（verifyPin 检测到旧格式验证通过后自动迁移）
- 设置页 label 撑宽要排除 toggle（`:not(.toggle)`），否则滑块视觉卡中间
- **UI 分层约定（v2.8.0）**：popup.js / options.js 是**页面级总指挥**（启动、事件绑定、协调 lib、持有共享状态）；`ui/*` 是**参数驱动的纯视图**（不引用页面全局变量、不调用页面全局函数——行为用回调注入，共享工具放 ui/ui-helpers.js）。新增 UI 功能时：渲染逻辑进 ui/*、编排逻辑留在页面文件
- 版本号：manifest.json 与 CHANGELOG.md 同步；每次发布 bump
- 新增文案必须同步 `_locales/zh_CN` 与 `_locales/en`

## 常用命令

- 无构建；打包 ZIP 用 Python 脚本（排除 sim_test.cjs、lib/health.js、临时脚本 pack_zip.py 与 .git 目录；key.pem 由 .gitignore 忽略）
- 发布：创建 Release（curl body 别带中文）+ 上传 zip；GitHub API 中文用 Python ensure_ascii=False
- 冒烟测试：node 22 可直接 eval lib/*.js（Web Crypto 原生支持），mock chrome.storage 后验证加密/迁移/密码锁逻辑（仓库内含 `sim_test.cjs` 端到端模拟测试，14/14 通过）
- 详细开发记录见 DEVELOPMENT.md；版本历史见 CHANGELOG.md；重构设计提案见 REFACTOR_DESIGN.md（部分设计已随实现演进，以本文与 DEVELOPMENT.md 为准）
