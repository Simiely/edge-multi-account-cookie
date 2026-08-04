# 更新日志（CHANGELOG）

## v2.5.0（当前版本）

**架构重构（v2.2 大杂烩 → lib/ 七模块单向依赖）**
- `utils.js` 拆分为 `lib/{crypto,storage,cookies,security,backup,messaging,webdav}.js`
- 新增 `lib/messaging.js` 消息层：popup/options 所有 `chrome.*` 调用统一收口到 Service Worker 路由（Promise 封装 + return true 保活 + sender 校验）
- `background.js` 改为 importScripts 引入 lib，删除与 utils.js 的重复实现
- popup/options 改为按需引入 lib 模块

**安全加固（P0 修复）**
- **删除密码明文存储** `cookie_switcher_pin_raw`（导出不再读取明文，改为用户输入密码）
- 密码锁验证升级为 **PBKDF2 盐值哈希**（60 万次迭代，OWASP 2023+ 建议），兼容旧 SHA-256 格式并自动迁移
- **防暴力破解**：连续失败 5 次锁定 60s，之后失败次数每 +5 锁定时间翻倍
- **Cookie value 加密落库**：引入设备主密钥（Master Key）方案——随机 256bit 主密钥加密所有 Cookie value；开启密码锁时主密钥被锁派生密钥包裹（"开锁 = 全量加密"）
- 主密钥会话缓存走 `chrome.storage.session`（内存级，浏览器重启失效）

**功能增强**
- **Partitioned Cookie（CHIPS）支持**：partitionKey/storeId 全链路透传（Chrome 119+）
- 切换账号：过期 Cookie 自动跳过 + 统计提示；**失败自动回滚**（快照恢复）；全部成功才刷新
- 导入备份支持 **merge（合并）/ replace（覆盖）** 双模式
- 账号**重命名**、**分组编辑**（弹窗内 ✎ 按钮）
- 分组折叠、分组输入框；账号排序稳定化（group + updatedAt 双键）
- 弹窗**密码锁屏遮罩**（README 承诺的功能补上）
- 白名单支持通配符 `*.example.com`
- 数据版本迁移管线 v2→v3（明文 value 自动加密），失败降级重试

**WebDAV 远程备份（新功能）**
- `lib/webdav.js` 协议客户端（PROPFIND/GET/PUT/DELETE + Basic Auth），走 SW 代理绕过 CORS
- 连接测试 / 立即备份 / 下载恢复 / 定时自动备份（chrome.alarms，每日/每周）
- 远端保留最近 N 份（默认 10）自动清理
- WebDAV 密码用主密钥加密存储；备份文件为 AES-GCM 密文（口令 = WebDAV 密码）

**其他**
- 删除冗余：`onepage/index.html`（与 index.html 重复）、`20260704Final`（空文件）
- 右键菜单新增动态二级"切换到此站点账号"
- 多语言补充（zh_CN + en）

## v2.2.0

- 导出自动使用密码锁密码（存储原文密码，导出无需输入）
- 修复 `duplicate const encrypted` 重复声明

## v2.1.0

- manifest 添加 `key` 字段固定扩展 ID（重装后密码/数据保留）
- 导出复用密码锁密码（导出时仍需输入验证）

## v1.7.x

- 导出时单独设置密码（输入一次密码）

## v1.x

- v1.0：基础 Cookie 保存/切换 + 独立加密密钥（无需密码）
- 后续：AES-GCM 加密、密码锁、域名白名单、右键菜单、快捷键、加密备份导出/导入

## 早期

- 基础版本：Cookie 切换 + localStorage
