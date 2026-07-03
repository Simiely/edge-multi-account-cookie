# Edge Multi-Account Cookie Switcher

> 安全的 Edge 多账号 Cookie 切换器 — 本地加密存储、PIN 锁保护，一键切换网站账号。

[English](#english) | [中文](#中文)

---

## 中文

### 简介

一款基于 **Manifest V3** 的 Edge/Chrome 浏览器扩展，让你在同一浏览器中**保存和切换多个网站账号**，无需反复登录退出。

比 SwitchID 更安全：**AES-256-GCM 加密**存储 Cookie、可选 **PIN 锁**、域名白名单、纯原生 JS 零第三方依赖。

### 核心功能

| 功能 | 说明 |
|------|------|
| 🔄 **一键切换** | 保存当前网站的 Cookie + localStorage，点击卡片即可切换到目标账号 |
| 💾 **保存账号** | 自动抓取当前登录状态的 Cookie（含 httpOnly）和 localStorage 数据 |
| 🔒 **AES-GCM 加密** | Cookie value 使用 Web Crypto API 加密存储，即使本地数据被读取也无法解密 |
| 🔐 **PIN 锁** | 可选 4-10 位数字 PIN 码保护，打开弹窗需验证身份 |
| 🌐 **域名白名单** | 可配置允许操作的域名，避免误操作 |
| 📦 **加密备份** | 数据可加密导出为 JSON 文件，导入需正确 PIN 码 |
| ⌨️ **快捷键** | `Alt+Shift+S` 快速打开弹窗 |
| 🖱️ **右键菜单** | 右键页面 → "清除此站点 Cookie 并重新登录" |
| 🐛 **调试面板** | 底部折叠调试面板，实时显示每一步的操作详情和 Cookie 读写情况 |

### 权限说明

| 权限 | 用途 |
|------|------|
| `cookies` | 读写网站登录 Cookie |
| `storage` | 本地加密存储账号数据 |
| `activeTab` | 获取当前标签页的域名 |
| `scripting` | 读写页面 localStorage |
| `contextMenus` | 右键菜单 |

扩展默认不申请任何网站权限，仅在点击弹窗时通过 `activeTab` 获得临时权限。如果需要长期保留对某个网站的访问，弹窗会引导你按需授权。

### 安装方法

1. 下载最新 Release 的 ZIP 包
2. 解压到任意目录
3. 打开 Edge 浏览器，进入 `edge://extensions/`
4. 打开右上角的 **"开发人员模式"**
5. 点击 **"加载解压缩的扩展"**
6. 选择解压后的文件夹（不要选 ZIP 本身）

### 使用方法

1. 登录你的网站账号（如 bilibili.com、huaban.com）
2. 按 `Alt+Shift+S` 打开扩展弹窗
3. 如果弹窗显示授权横幅，点击「授权访问此网站」
4. 输入账号名称（如"工作号"），点击「保存当前账号」
5. 登录第二个账号，重复步骤 2-4
6. 之后在弹窗中点击账号卡片即可一键切换

> ⚠️ **注意**：切换账号时使用扩展的「切换到该账号」功能，不要使用网站自带的"退出登录"，否则已保存的 Cookie 会被服务器端作废。

### 与 SwitchID 对比

| 对比项 | SwitchID | 本项目 |
|--------|----------|--------|
| 数据加密 | 未公开 | **AES-256-GCM** |
| PIN 锁 | ❌ | ✅ |
| 域名白名单 | ❌ | ✅ |
| 第三方依赖 | 未公开 | **零依赖** |
| 代码可见 | 闭源 | **开源可审查** |
| 权限模型 | `<all_urls>` | `activeTab` + 按需授权 |

### 常见问题

**Q: 保存了 0 个 Cookie？**
A: 未获得当前网站的访问权限。弹窗顶部会显示授权按钮，点击「授权访问此网站」即可。

**Q: 点击"登录新账号"后还是登录状态？**
A: v1.0.0 早期版本的问题，Cookie 域名带 `.` 前缀时删除失败。请更新到最新版本。

**Q: 刷新扩展没看到新代码？**
A: Edge 解压缩扩展的加载路径可能和工作目录不同。`edge://extensions/` 卡片上会显示实际路径，需要确认文件是否写到了正确的位置。

**Q: 插件崩溃 / Service Worker 注册失败？**
A: 已修复 contextMenus 权限缺失和 `type: module` 的问题。如果还有问题请提 Issue。

---

## English

### Overview

A **Manifest V3** Edge/Chrome extension for saving and switching multiple website accounts without repeated login/logout.

More secure than SwitchID: **AES-256-GCM encrypted** cookie storage, optional **PIN lock**, domain whitelist, zero third-party dependencies.

### Features

- **One-click switch** between saved accounts per website
- **Save cookies** (including httpOnly) and localStorage
- **AES-GCM encryption** via Web Crypto API
- **Optional PIN lock** (4-10 digits)
- **Domain whitelist** for controlled access
- **Encrypted backup/restore**
- Keyboard shortcut: `Alt+Shift+S`
- Right-click context menu: "Clear cookies & re-login"
- Built-in debug log panel

### Installation

1. Download the latest release ZIP
2. Extract to any folder
3. Go to `edge://extensions/`
4. Enable **Developer mode**
5. Click **Load unpacked**
6. Select the extracted folder

### Quick Start

1. Log into a website
2. Press `Alt+Shift+S` to open the popup
3. Click "Grant permission" if prompted
4. Enter an account name and click "Save Current Account"
5. Log into another account and repeat
6. Click any saved account to switch instantly

---

**License**: MIT
