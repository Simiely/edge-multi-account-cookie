# DEVELOPMENT.md

> 开发记录 & 关键问题备忘。记录开发过程中遇到的坑和解决方案，方便以后参考。

---

## 项目架构

```
cookie-switcher/
├── manifest.json        # MV3 配置
├── background.js        # Service Worker（右键菜单、快捷键）
├── popup.html           # 弹窗 UI
├── popup.js             # 弹窗交互逻辑
├── utils.js             # 核心工具库（加密、Cookie 操作、密码锁、白名单）
├── options.html         # 设置页面
├── options.js           # 设置逻辑
├── _locales/
│   ├── zh_CN/messages.json
│   └── en/messages.json
├── assets/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
├── key.pem              # 扩展私钥（用于稳定扩展 ID，不提交到 Git）
├── README.md
└── DEVELOPMENT.md
```

**设计原则**：
- 全部使用原生 JS，零第三方依赖（杜绝供应链风险）
- 数据加密使用 Web Crypto API（无外部加密库）
- 权限最小化：不使用 `<all_urls>`，使用 `activeTab` + 按需授权

---

## 关键问题 & 解决方案

### 1. `scripting` 权限缺失

**现象**：`chrome.scripting.executeScript()` 调用时静默失败，localStorage 读写无效。

**原因**：Manifest V3 中 `scripting` 是一个独立的 permission，必须在 manifest.json 的 `permissions` 中声明。

**修复**：
```json
"permissions": ["scripting"]
```

---

### 2. Cookie API 需要 host_permissions

**现象**：`chrome.cookies.getAll({domain})` 返回空数组 `[]`，不报错。只有 0 个 Cookie。

**原因**：`cookies` 权限**不包含主机权限**。官方原文：*"The cookies permission does not imply any host permissions."*

**修复（三层防线）**：
1. `activeTab` — 点击弹窗时获得临时权限
2. `optional_host_permissions: ["<all_urls>"]` — 允许按需申请
3. `chrome.permissions.contains()` — **主动检测**，不等 API 报错

```js
// ✅ 正确：主动检测
const hasPerm = await chrome.permissions.contains({ origins: [`*://${domain}/*`] });

// ❌ 错误：等 API 报错（空数组不报错，永远检测不到）
const cookies = await getCookies(domain); // → [] 无错误
```

---

### 3. Cookie URL 前导点号导致 remove 失败

**现象**：清除 Cookie 后仍有 15/17 个残留，用户仍处于登录状态。

**原因**：Cookie 的 `domain` 字段以 `.` 开头（如 `.example.com`），拼接 URL 后得到 `http://.example.com/`，**非法 URL**，remove 静默失败。

**修复**：
```js
function cookieUrl(cookie) {
  const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
  return `${cookie.secure ? 'https' : 'http'}://${domain}${cookie.path || '/'}`;
}
```

**教训**：所有 `cookies.set()` 和 `cookies.remove()` 的 URL 构造都要处理前导点号。

---

### 4. contextMenus 崩溃 + Service Worker 注册失败

**现象**：`Cannot read properties of undefined (reading 'onClicked')` + `Service worker registration failed. Status code: 15`。

**原因**：
1. Edge 需要显式声明 `"contextMenus"` 权限（Chrome 文档说不需要但 Edge 需要）
2. `"type": "module"` 但没有实际 import/export，Edge 解析失败

**修复**：
```json
"permissions": ["contextMenus"]
```
```json
// 没有 import/export 时不加 type: module
"background": {
  "service_worker": "background.js"
}
```

---

### 5. Edge 解压缩扩展的加载路径

**现象**：修改工作目录的源码后，Edge 刷新没变化。

**原因**：Edge 将扩展复制到 `User Data\Profile X\UnpackedExtensions\`，修改原始目录不影响副本。

**解决方案**：`edge://extensions/` 卡片上查看实际加载位置，直接加载源码目录而不是 ZIP。

**教训**：永远先确认 Edge 实际读的是哪个路径。

---

### 6. JSON 中文乱码（GitHub API）

**现象**：curl 发送含中文的 JSON 到 GitHub API 时 Release 描述乱码。

**原因**：Git Bash 下 `--data-raw` 传递含 `\n` 转义的中文 JSON 时编码被破坏。

**修复**：用 Python `urllib.request` + `ensure_ascii=False` 编码 UTF-8。

```python
json.dumps(data, ensure_ascii=False).encode('utf-8')
```

---

### 7. Windows SSL/TLS 握手失败

**现象**：`schannel: failed to receive handshake, SSL/TLS connection failed`。

**修复**：
```bash
GIT_SSL_NO_VERIFY=1 git push
curl -sk ...
```

---

### 8. Maximum call stack size exceeded（导出时栈溢出）

**现象**：点击导出按钮时报 `Maximum call stack size exceeded`。

**原因**：`btoa(String.fromCharCode(...packed))` 用展开运算符 `...` 把整个 Uint8Array 拆成参数传入，数据量大时超过 JS 引擎参数数量限制。

**修复**：按 8KB 分块处理：
```js
let binary = '';
for (let i = 0; i < packed.length; i += 8192) {
  const chunk = packed.subarray(i, i + 8192);
  binary += String.fromCharCode(...chunk); // 每块 8192 个参数，安全范围内
}
return btoa(binary);
```

同样修复了解密侧的 `atob().split('').map()` → 改用 for 循环：
```js
const binary = atob(encoded);
const packed = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) {
  packed[i] = binary.charCodeAt(i);
}
```

---

### 9. Toggle 开关卡在半中间

**现象**：设置页面的密码锁开关滑到一半，看起来卡住了。

**原因**：`.form-row label` 设置了 `min-width: 70px`，但没有排除 toggle 容器，导致 toggle 被撑大到 70px。滑块实际只移动 18px，18/70 ≈ 25%，看起来像卡中间。

**修复**：
```css
/* 错误：所有 label 都被撑到 70px */
.form-row label { min-width: 70px; }

/* 正确：排除 toggle */
.form-row label:not(.toggle) { min-width: 70px; }
```

---

### 10. 导出密码与密码锁密码同步

**问题演变**：
1. v1.0: 导出使用单独的加密密钥（不需要密码）
2. v1.7: 改为导出时单独设置密码（输入一次密码）
3. v2.1: 导出复用密码锁密码（导出时仍需输入验证）
4. v2.2: 导出自动使用密码锁密码（存储原文密码，导出无需输入）

**最终方案**：设置密码锁时，同时存储：
- SHA-256 哈希（用于验证密码）
- 原文密码（用于导出加密，存储在 `chrome.storage.local` 中，沙箱隔离）

```js
async function setPin(pin) {
  // 存储哈希用于验证
  const hashHex = sha256Hex(pin);
  await chrome.storage.local.set({ 'cookie_switcher_pin': hashHex });
  // 存储原文用于导出
  await chrome.storage.local.set({ 'cookie_switcher_pin_raw': pin });
}
```

---

### 11. 重装扩展后密码丢失

**现象**：删除扩展重新加载后，账号数据还在但密码丢失。

**原因**：`chrome.storage.local` 按扩展 ID 隔离。每次加载解压缩扩展时如果没指定 `key`，Edge 生成随机 ID，旧数据就被隔离了。

**修复**：在 manifest.json 中添加 `"key"` 字段（RSA 公钥 SPKI Base64），固定扩展 ID。

```json
"key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA..."
```

**生成方式**：
```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt > key.pem
openssl rsa -pubout -outform DER -in key.pem -out pubkey.der
# 将 pubkey.der base64 编码后放入 manifest.json 的 "key" 字段
```

---

### 12. MV3 Service Worker 注册规范

**关键要求**：
- `background.service_worker` 必须是字符串（不是数组）
- 不能有 `background.persistent` 字段
- 监听器必须在顶层同步注册（不能在 promise 或回调内）

```js
// ✅ 顶层注册
chrome.runtime.onInstalled.addListener(() => { ... });

// ❌ 异步回调内注册（可能丢失）
chrome.storage.local.get(["key"], ({ key }) => {
  chrome.action.onClicked.addListener(handleClick);
});
```

---

### 13. 权限最小化原则

| 方案 | 安全性 | 首次使用体验 |
|------|--------|------------|
| `<all_urls>` | 低（安装即授权所有网站） | 直接可用 |
| `activeTab` + 按需授权 | 高（仅授权当前网站） | 多一次点击授权 |

本项目采用 `activeTab` + `optional_host_permissions` + `chrome.permissions.request()` 三层机制。

---

## 构建 & 发布

```bash
# 打包 ZIP（排除 .gitignore, CODE_REVIEW.md, key.pem）
python3 -c "
import zipfile, os
exclude = {'.gitignore', 'CODE_REVIEW.md', 'key.pem'}
with zipfile.ZipFile('dist.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk('.'):
        dirs[:] = [d for d in dirs if d != '.git']
        for f in files:
            p = os.path.join(root, f)
            r = os.path.relpath(p, '.')
            if r not in exclude and not r.startswith('.git'):
                z.write(p, r.replace(os.sep, '/'))
"

# 创建 Release（curl 方式，body 不要有中文）
curl -sk -X POST -H "Authorization: token $TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/Simiely/edge-multi-account-cookie/releases" \
  -d '{"tag_name":"v2.2.0","name":"v2.2.0","body":"v2.2.0 release","draft":false,"prerelease":false}'

# 上传 ZIP
curl -sk -X POST -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/zip" \
  "https://uploads.github.com/repos/Simiely/edge-multi-account-cookie/releases/$RELEASE_ID/assets?name=extension.zip" \
  --data-binary @dist.zip
```

---

## 参考文档

- [Chrome Extensions Manifest V3](https://developer.chrome.google.cn/docs/extensions/develop/migrate)
- [chrome.cookies API](https://developer.chrome.google.cn/docs/extensions/reference/api/cookies)
- [chrome.permissions API](https://developer.chrome.google.cn/docs/extensions/reference/api/permissions)
- [activeTab permission](https://developer.chrome.google.cn/docs/extensions/develop/concepts/activeTab)
- [Service Worker migration](https://chrome.jscn.org/docs/extensions/migrating/to-service-workers/)
- [Improve security (CSP, eval, remote code)](https://chrome.jscn.org/docs/extensions/migrating/improve-security/)
- [MV3 migration checklist](https://chrome.jscn.org/docs/extensions/migrating/checklist/)
