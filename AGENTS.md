# AGENTS.md · 项目规则

> 写给 AI / 未来维护者的项目上下文。只记录代码里看不出的信息。

## 技术栈

- **Manifest V3** Edge/Chrome 扩展，纯原生 JS **零第三方依赖**（杜绝供应链风险）
- 加密：Web Crypto API（AES-256-GCM + PBKDF2，迭代 60 万次）；存储：`chrome.storage.local`（数据）+ `chrome.storage.session`（主密钥会话缓存）
- 权限模型：`activeTab` + `optional_host_permissions` + 按需 `chrome.permissions.request()`
- **消息架构**：popup/options 一律经 `lib/messaging.js` 发消息给 background（SW）执行 chrome.* 调用，**禁止 UI 层直调 chrome.cookies/storage 等 API**

## 目录结构（v2.5.0 起）

```
├── manifest.json        # MV3 配置（key 固定 ID；permissions 含 alarms）
├── background.js        # SW 入口：消息路由 + 右键菜单 + alarms 定时备份
├── lib/                 # 核心层（无 DOM 依赖，页面/SW 通用）
│   ├── crypto.js        # AES-GCM + PBKDF2(60w) + 主密钥 + 分块 base64 —— 零 chrome API
│   ├── storage.js       # storage.local CRUD + 账号模型 + 版本迁移 + 主密钥落盘
│   ├── cookies.js       # Cookie/页面数据操作 + applyCookies（partitionKey/回滚）
│   ├── security.js      # 密码锁（PBKDF2 + 防爆破）+ 白名单
│   ├── backup.js        # 本地导出/导入（merge/replace）
│   ├── webdav.js        # WebDAV 协议客户端（SW 内执行）
│   └── messaging.js     # 消息层：sendMessage 封装 + sender 校验 + action 分发
├── popup.html/js        # 弹窗 UI（锁屏遮罩 + 账号列表）
├── options.html/js      # 设置页（密码锁/白名单/备份/WebDAV）
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
7. **importScripts 顺序敏感**：background.js 引入 lib 必须按 crypto → storage → cookies → security → backup → webdav → messaging 顺序
8. **主密钥（Master Key）机制**：cookie value 落库一律 `'enc:' + encryptWithKey(value, MK)`；无锁时 MK 明文落盘，有锁时 MK 被锁派生密钥包裹（wrapped=true）。`getMasterKey()` 优先读 session 缓存——**有锁且本会话未解锁时返回 null**，调用方必须先走 `pin.unlock`
9. **PBKDF2 密码哈希用 deriveBits**：`deriveKey()` 产出的 CryptoKey `extractable=false`，不能 `exportKey` 取哈希——密码验证哈希用 `crypto.subtle.deriveBits(..., 256)` 直接取字节
10. **防暴力破解**：所有密码验证必须走 `verifyPinWithLock()`（含 failCount/lockedUntil 检查），禁止直接调 `verifyPin()`
11. **partitionKey / storeId**：保存 cookie 时**必须**记录 `partitionKey`（Chrome 119+ CHIPS）与 `storeId`，切换/清除时原样透传，否则 Partitioned Cookie 丢失
12. **消息层契约**：新增 action 必须同时在 `background.js` 的 `registerMessageHandler({...})` 注册；监听器异步响应必须 `return true` 保活；页面统一 `sendMessage(action, payload)`（自动超时 60s）
13. **WebDAV 必须在 SW 执行**：页面 fetch WebDAV 会被 CORS 拦截，只有 SW + host_permissions 可绕过；WebDAV 密码用主密钥加密存 `cookie_switcher_webdav.passEnc`，明文口令仅在 SW 内存中出现
14. **数据版本迁移**：`DATA_VERSION=3`（storage.js），读取时惰性迁移，失败标记 `migrationPending` 不阻塞
15. **权限最小化**：不用 `<all_urls>`，按需授权；WebDAV 服务器域名在 options 页 `permissions.request`（必须用户手势上下文）

## 约定

- 密码锁存 PBKDF2(salt+hash)（`{format:'pbkdf2', salt, hash}`），兼容旧 SHA-256 hex 字符串格式（verifyPin 检测到旧格式验证通过后自动迁移）
- 设置页 label 撑宽要排除 toggle（`:not(.toggle)`），否则滑块视觉卡中间
- 版本号：manifest.json 与 CHANGELOG.md 同步；每次发布 bump
- 新增文案必须同步 `_locales/zh_CN` 与 `_locales/en`

## 常用命令

- 无构建；打包 ZIP 用 Python 脚本（排除 .gitignore/CODE_REVIEW.md/key.pem/REFACTOR_*.md）
- 发布：创建 Release（curl body 别带中文）+ 上传 zip；GitHub API 中文用 Python ensure_ascii=False
- 冒烟测试：node 22 可直接 eval lib/*.js（Web Crypto 原生支持），mock chrome.storage 后验证加密/迁移/密码锁逻辑
- 详细开发记录见 DEVELOPMENT.md；版本历史见 CHANGELOG.md；重构方案见 REFACTOR_PLAN.md / REFACTOR_DESIGN.md
