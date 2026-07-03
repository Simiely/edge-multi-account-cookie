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
├── utils.js             # 核心工具库（加密、Cookie 操作、PIN、白名单）
├── options.html         # 设置页面
├── options.js           # 设置逻辑
├── _locales/
│   ├── zh_CN/messages.json
│   └── en/messages.json
├── assets/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
└── README.md
```

**设计原则**：
- 所有文件保留在零个目录层级（根目录），避免深嵌套
- 全部使用原生 JS，零第三方依赖
- 数据加密使用 Web Crypto API（无外部加密库）

---

## 关键问题 & 解决方案

### 1. `scripting` 权限缺失

**现象**：`chrome.scripting.executeScript()` 调用时静默失败，localStorage 读写无效。

**原因**：Manifest V3 中 `scripting` 是一个独立的 permission，必须在 manifest.json 的 `permissions` 中声明。

**解决方案**：
```json
"permissions": ["scripting"]
```

**参考**：Chrome 官方文档要求 `scripting.executeScript()` 必须在 permissions 中声明 `"scripting"`。

---

### 2. Cookie API 需要 host_permissions

**现象**：`chrome.cookies.getAll({domain})` 返回空数组 `[]`，不报错。

**原因**：`cookies` 权限**不包含主机权限**。即使有 `cookies` 权限，也需要对应域名的 `host_permissions` 才能读取 Cookie。`activeTab` 在某些浏览器版本中不一定覆盖 Cookie API。

**参考**：*"The cookies permission does not imply any host permissions. You need host permissions for the URLs of the cookies you want to access."*

**解决方案（三层防线）**：
1. 利用 `activeTab`：用户点击弹窗时获得临时主机权限（部分版本有效）
2. 声明 `optional_host_permissions: ["<all_urls>"]`：允许按需申请权限
3. 使用 `chrome.permissions.contains({origins: [...]})` 在初始化时**主动检测**权限状态，而不是等 API 报错

```js
// 正确的做法：主动检测
const hasPerm = await chrome.permissions.contains({ origins: [`*://${domain}/*`] });
if (!hasPerm) {
  // 显示授权按钮
}

// 错误的做法：等 API 报错（因为空数组不报错，永远检测不到）
const cookies = await getCookies(domain); // 返回 []，无错误
```

---

### 3. Cookie URL 构造：域名前导点号

**现象**：`chrome.cookies.remove()` 删除 Cookie 时静默失败，清除后仍有 15/17 个 Cookie 残留，用户仍处于登录状态。

**原因**：Cookie 的 `domain` 字段可能以 `.` 开头（例如 `.example.com`），直接拼接为 URL 时得到 `http://.example.com/`，这是**非法 URL**，导致 remove 操作静默失败。

**修复**：
```js
// 错误
const url = `https://${cookie.domain}${cookie.path}`;
// → https://.example.com/ （非法！）

// 正确
function cookieUrl(cookie) {
  const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
  return `${cookie.secure ? 'https' : 'http'}://${domain}${cookie.path || '/'}`;
}
// → https://example.com/ （合法）
```

**教训**：所有涉及 `chrome.cookies.set()` 和 `chrome.cookies.remove()` 的 URL 构造，都必须处理前导点号。

---

### 4. contextMenus API 在 MV3 中可能缺失

**现象**：Service Worker 启动时报错 `Cannot read properties of undefined (reading 'onClicked')`，同时 `Service worker registration failed. Status code: 15`。

**原因**：
1. `contextMenus` API 在某些 Edge 版本中需要显式声明 `"contextMenus"` 权限（尽管 Chrome 文档说不需要）
2. 背景脚本声明了 `"type": "module"` 但没有实际的 import/export，Edge 解析 ES Module 时失败，导致 Service Worker 注册失败

**解决方案**：
```json
"permissions": ["contextMenus"]
```
```json
// 如果没有 import/export，不声明 type: module
"background": {
  "service_worker": "background.js"
}
```

**教训**：
- 即使 Chrome 文档说某个 API 不需要 permission，Edge 可能需要
- 只在确实使用 `import`/`export` 时才加 `"type": "module"`

---

### 5. Edge 解压缩扩展的加载路径

**现象**：修改了工作目录下的源码文件，Edge 里点击扩展刷新按钮后没有变化。

**原因**：Edge 在加载解压缩扩展时，会把扩展文件复制到 `User Data\Profile X\UnpackedExtensions\` 目录下。修改原始目录的文件不影响这个副本。

**验证**：`edge://extensions/` 中扩展卡片会显示实际加载路径，与源码目录不同。

**解决方案**：
```bash
# 将最新文件复制到 Edge 实际读取的目录
cp -r cookie-switcher/* "C:\Users\...\Edge\User Data\Profile 2\UnpackedExtensions\extension-name_hash/"
# 或者删除扩展重新加载（选源码目录）
```

**教训**：永远先确认 Edge/Chrome 实际读的是哪个目录。

---

### 6. JSON 中文乱码（GitHub API）

**现象**：通过 `curl --data-raw` 发送带中文的 JSON 到 GitHub API 时，Release 描述出现乱码。

**原因**：Git Bash 下 curl 的 `--data-raw` 参数在传递包含 `\n` 转义符的中文 JSON 时编码被破坏。

**解决方案**：使用 Python 的 `urllib.request` 发送 `ensure_ascii=False` 的 UTF-8 JSON。

```python
body = json.dumps(data, ensure_ascii=False).encode('utf-8')
req.add_header("Content-Type", "application/json; charset=utf-8")
resp = urllib.request.urlopen(req, body)
```

**教训**：涉及中文的 API 请求，优先用 Python 而不是 Bash curl。

---

### 7. Windows 下 SSL/TLS 连接问题

**现象**：Git push 和 curl 频繁报 `schannel: failed to receive handshake, SSL/TLS connection failed`。

**解决方案**：
```bash
# Git
GIT_SSL_NO_VERIFY=1 git push origin main

# curl
curl -sk ...
```

**说明**：Windows 的 Schannel SSL 实现在某些网络环境下会有握手问题。

---

### 8. MV3 Service Worker 注册规范

**关键要求**：
- `background.service_worker` 的值必须是字符串（不是数组）
- 不能有 `background.persistent` 字段
- 监听器必须在顶层同步注册（不能在 promise 或回调内注册）
- Service Worker 中不能访问 DOM、window、document

```js
// ✅ 正确：顶层注册
chrome.runtime.onInstalled.addListener(() => { ... });
chrome.commands.onCommand.addListener(() => { ... });

// ❌ 错误：异步回调内注册
chrome.storage.local.get(["key"], ({ key }) => {
  chrome.action.onClicked.addListener(handleClick); // 可能丢失
});
```

---

### 9. 权限最小化原则

本项目不直接声明 `<all_urls>` 主机权限，而是使用：
- `activeTab`：点击弹窗时获得当前标签页的临时权限
- `optional_host_permissions`：用户按需授权
- `chrome.permissions.request()`：在弹窗中主动引导用户授权

**权限声明对比**：

| 方案 | 安全性 | 首次使用体验 |
|------|--------|------------|
| `<all_urls>` | 低（安装即授权所有网站） | 直接可用，无需额外操作 |
| `activeTab` + 按需授权 | 高（仅授权当前网站） | 需要多一次点击授权 |

---

## 调试技巧

### 查看 Service Worker 日志

`edge://extensions/` → 点击扩展卡片上的 **Service Worker** 蓝色链接 → 打开 DevTools 控制台。

### 查看 Cookie API 调用

在扩展弹窗底部展开 **🐛 调试日志**，可以看到每一次 Cookie 操作的详细记录，包括：
- Cookie 数量变化
- 移除失败的 Cookie 名称和错误原因
- 权限检查结果

### Service Worker 刷新

修改 `background.js` 后，需要在 `edge://extensions/` 中点击扩展卡片的 **↻ 刷新** 按钮。仅重新打开弹窗不会重新加载 Service Worker。

### 确认扩展加载路径

在 `edge://extensions/` 中查看扩展卡片下的 **加载位置**，确认文件修改到了正确的目录。

---

## 构建 & 发布

```bash
# 打包
python -c "import zipfile, os; z = zipfile.ZipFile('dist.zip', 'w', zipfile.ZIP_DEFLATED); [z.write(f, f.replace(os.sep, '/')) for f in ['manifest.json','background.js','popup.html','popup.js','utils.js','options.html','options.js']]"

# 发布 Release（通过 GitHub API）
# 详见 scripts/release.py（如有）
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
