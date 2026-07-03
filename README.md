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

### 权限说明

| 权限 | 用途 |
|------|------|
| `cookies` | 读写网站登录 Cookie |
| `storage` | 本地加密存储账号数据 |
| `activeTab` | 获取当前标签页的域名 |
| `scripting` | 读写页面 localStorage |

扩展默认不申请任何网站权限，仅在点击弹窗时通过 `activeTab` 获得临时权限。如果需要长期保留对某个网站的访问，弹窗会引导你按需授权。

### 安装方法

1. 打开 Edge 浏览器，进入 `edge://extensions/`
2. 打开右上角的 **"开发人员模式"**
3. 点击 **"加载解压缩的扩展"**
4. 选择本项目文件夹即可

### 使用方法

1. 登录你的网站账号（如 bilibili.com）
2. 按 `Alt+Shift+S` 打开扩展弹窗
3. 输入账号名称（如"工作号"），点击「保存当前账号」
4. 登录第二个账号，重复步骤 2-3
5. 之后在弹窗中点击账号卡片即可一键切换

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
- Right-click context menu

### Installation

1. Go to `edge://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the extension directory

### Quick Start

1. Log into a website
2. Press `Alt+Shift+S` to open the popup
3. Enter an account name and click "Save"
4. Log into another account and repeat
5. Click any saved account to switch instantly

---

**License**: MIT
