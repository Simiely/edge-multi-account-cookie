# AGENTS.md · 项目规则

> 写给 AI / 未来维护者的项目上下文。只记录代码里看不出的信息。

## 技术栈

- **Manifest V3** Edge/Chrome 扩展，纯原生 JS **零第三方依赖**（杜绝供应链风险）
- 加密：Web Crypto API（AES-256-GCM + PBKDF2）；存储：`chrome.storage.local`（按扩展 ID 隔离）
- 权限模型：`activeTab` + `optional_host_permissions` + 按需 `chrome.permissions.request()`

## 关键坑（改代码前必读）

1. **权限三层防线**：`cookies` 权限**不包含主机权限**（官方：cookies permission does not imply host permissions）——`getAll` 返回空数组不报错，永远检测不到。用 `chrome.permissions.contains({origins})` **主动检测**，配合 activeTab + optional_host_permissions
2. **MV3 Service Worker 规范**：`service_worker` 必须是**字符串**；不能有 `background.persistent`；**监听器必须在顶层同步注册**（不能放 promise/回调里，可能丢失）
3. **Cookie URL 前导点号**：Cookie `domain` 以 `.` 开头（`.example.com`），拼 URL 得 `http://.example.com/` 非法——`set/remove` 前必须 `slice(1)` 去点号
4. **重装丢数据**：`chrome.storage.local` 按扩展 ID 隔离，每次加载无 `key` 的扩展生成随机 ID → 旧数据隔离。**manifest 加 `key`（RSA 公钥 SPKI Base64）固定扩展 ID**（key.pem 私钥不提交 Git）
5. **栈溢出**：`btoa(String.fromCharCode(...packed))` 展开运算符拆大数组超参数限制 → **按 8KB 分块**；解密侧 `atob().split('').map()` 也改 for 循环
6. **Edge 特有**：`contextMenus` 权限 Edge 必须显式声明（Chrome 文档说不需要）；`type: "module"` 无实际 import/export 时 Edge 解析失败（不加）；加载扩展时 Edge 复制到 UnpackedExtensions，改源码要确认实际加载路径

## 约定

- 密码锁存两份：SHA-256 哈希（验证）+ 原文（导出加密用，存 storage.local 沙箱）
- 权限最小化：不用 `<all_urls>`，按需授权；扩展默认不申请网站权限
- 设置页 label 撑宽要排除 toggle（`:not(.toggle)`），否则滑块视觉卡中间

## 常用命令

- 无构建；打包 ZIP 用仓库内 Python 脚本（排除 .gitignore/CODE_REVIEW.md/key.pem）
- 发布：创建 Release（curl body 别带中文）+ 上传 zip；GitHub API 中文用 Python ensure_ascii=False
- 详细开发记录见 DEVELOPMENT.md；版本历史见 CHANGELOG.md
