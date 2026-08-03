# 开发文档（DEVELOPMENT.md）

> 面向开发者的项目文档：架构说明 + 关键问题与方案（一坑一篇）。
> 每个问题用统一格式：**TL;DR**（一句话结论）→ 问题 / 根因 / 解决 / 预防。

## 项目概览

Edge/Chrome MV3 扩展（v2.2.0），保存和切换多网站账号 Cookie。AES-256-GCM 加密存储 + 密码锁 + 域名白名单，纯原生 JS 零依赖。设计原则：权限最小化、数据本地加密、杜绝供应链风险。

## 架构说明

```
cookie-switcher/
├── manifest.json        # MV3 配置（含 key 固定扩展 ID）
├── background.js        # Service Worker（右键菜单、快捷键，监听器顶层注册）
├── popup.html/js        # 弹窗 UI + 交互
├── utils.js             # 核心：加密（AES-GCM）、Cookie 操作、密码锁、白名单
├── options.html/js      # 设置页（密码锁、白名单、导出导入）
├── _locales/            # zh_CN + en 多语言
├── assets/              # 图标
└── key.pem              # 扩展私钥（固定 ID 用，不提交 Git）
```

## 关键问题与方案

### 1. scripting 权限缺失

**TL;DR**：MV3 中 `scripting` 是独立 permission，必须显式声明，否则 `executeScript()` 静默失败。

### 2. Cookie API 需要 host_permissions（三层防线）

**TL;DR**：**`cookies` 权限不包含主机权限**——`getAll` 返回空数组**不报错**，永远检测不到。三层防线：`activeTab`（点击临时权限）+ `optional_host_permissions`（按需申请）+ **`chrome.permissions.contains()` 主动检测**（不等 API 报错）。

```js
// ✅ 主动检测
const hasPerm = await chrome.permissions.contains({ origins: [`*://${domain}/*`] });
// ❌ 等 API 报错（空数组不报错，检测不到）
const cookies = await getCookies(domain); // → []
```

- **预防**：涉及 cookies/host 权限的功能一律先 contains 检测，再决定是否引导授权

### 3. Cookie URL 前导点号导致 remove 失败

**TL;DR**：Cookie `domain` 以 `.` 开头，拼接 URL 成 `http://.example.com/` **非法 URL**，remove 静默失败。set/remove 前必须 `slice(1)` 去点号。

```js
function cookieUrl(cookie) {
  const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
  return `${cookie.secure ? 'https' : 'http'}://${domain}${cookie.path || '/'}`;
}
```

### 4. contextMenus 崩溃 + Service Worker 注册失败

**TL;DR**：① Edge 需要显式声明 `contextMenus` 权限（Chrome 文档说不需要，**Edge 需要**）；② `type: "module"` 无实际 import/export 时 Edge 解析失败——不加。

### 5. Edge 解压缩扩展的加载路径

**TL;DR**：Edge 将扩展复制到 `User Data\Profile X\UnpackedExtensions\`，**修改原始目录不影响副本**。改源码前先确认 `edge://extensions/` 卡片上的实际加载位置。

### 6. JSON 中文乱码（GitHub API）

**TL;DR**：Git Bash curl 传含中文 JSON 时编码被破坏。用 Python `urllib.request` + `ensure_ascii=False` 编码 UTF-8。

### 7. Windows SSL/TLS 握手失败

**TL;DR**：`schannel: failed to receive handshake`。临时方案 `GIT_SSL_NO_VERIFY=1 git push` / `curl -sk`（仅限可信环境）。

### 8. Maximum call stack size exceeded（栈溢出）

**TL;DR**：`btoa(String.fromCharCode(...packed))` 展开运算符把整个 Uint8Array 拆成参数，大数据量超 JS 参数限制。**按 8KB 分块**；解密侧 `atob().split('').map()` 也改 for 循环。

```js
let binary = '';
for (let i = 0; i < packed.length; i += 8192) {
  binary += String.fromCharCode(...packed.subarray(i, i + 8192));
}
return btoa(binary);
```

### 9. Toggle 开关卡在半中间

**TL;DR**：`.form-row label { min-width: 70px }` 没排除 toggle 容器，滑块 18px/70px ≈ 25% 视觉卡中间。**`:not(.toggle)` 排除**。

### 10. 导出密码与密码锁密码同步

**TL;DR**：导出方案演进 v1.0 独立密钥 → v1.7 单独密码 → v2.1 复用锁密码（验证）→ v2.2 自动用锁密码（无需输入）。**存两份：SHA-256 哈希（验证）+ 原文（导出加密，存 storage.local 沙箱）**。

### 11. 重装扩展后密码丢失

**TL;DR**：`chrome.storage.local` **按扩展 ID 隔离**；无 `key` 的扩展每次加载生成随机 ID → 旧数据被隔离。**manifest 加 `key`（RSA 公钥 SPKI Base64）固定扩展 ID**。

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt > key.pem
openssl rsa -pubout -outform DER -in key.pem -out pubkey.der
# pubkey.der base64 后放入 manifest "key" 字段；key.pem 不提交 Git
```

### 12. MV3 Service Worker 注册规范

**TL;DR**：`background.service_worker` 必须是**字符串**；不能有 `background.persistent`；**监听器必须在顶层同步注册**（放 promise/回调内可能丢失）。

### 13. 权限最小化原则

**TL;DR**：`<all_urls>` 安装即授权所有网站（低安全）；`activeTab` + 按需授权（高安全，多一次点击）。本项目用 activeTab + optional_host_permissions + permissions.request 三层机制。

## 构建 & 发布

- 打包 ZIP：Python 脚本（排除 .gitignore/CODE_REVIEW.md/key.pem，剔除 .git 目录）
- 创建 Release：curl 方式（body 不要有中文）；上传 zip 到 releases assets
- GitHub API 中文数据用 Python `ensure_ascii=False`

## 开发环境

- Edge / Chrome + MV3；无构建工具；验证 = `edge://extensions/` 加载解压扩展
