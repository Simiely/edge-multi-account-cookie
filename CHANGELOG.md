# 更新日志（CHANGELOG）

## v2.6.0（当前版本）

**核心修复：Cookie 操作改回 popup 直调（花瓣登录根因）**
- **根因**：Edge 的 Service Worker 上下文 `chrome.cookies.getAll` 读不到 Cookie（CDP 实测：同一授权 SW=0 / popup=12）——v2.5 把保存/切换/清除迁到 SW 后，保存读到 0 个 Cookie → 切换无效
- **修复**：保存/切换/删除/编辑/清除/域名识别全部改回 popup 直调（v2.2 方式，activeTab + 授权均可用）；WebDAV/锁屏/设置仍走 SW
- `getCookies` 加强：父域链查询（domain/.domain/父域）覆盖子域 Cookie，修复"清除不干净"

**Cookie 明文存储（修复大 Cookie 失效）**
- 之前 AES 加密使 value 膨胀 1.35 倍，原始值 >3072B 的 Cookie 加密后超浏览器 4096 上限 → 切换写入失败 → 登录态丢失
- 改为明文存储（与浏览器自身 Cookies 数据库一致）；备份/导出仍整包加密不受影响
- 兼容旧 enc: 加密数据：applyCookies 保留解密逻辑，无缝切换

**数据自动迁移**
- 打开设置页自动把旧 enc: 加密数据解密为明文（幂等；MK 不可用时静默等下次）
- 迁移失败保护：解密失败保留原样不破坏数据

**取消过期判断**
- 不再跳过过期 Cookie（过期交由网站自行处理）；仅解密失败（坏数据）跳过
- 切换提示简化为成功/失败两态，失败只提示「使用失败」

## v2.5.0（上一版本）

**全新珊瑚粉深色 UI（主色 #FF9292）**
- 弹窗 B v2：身份锚点（大头像 + 站点 + 当前态）、分组色账号卡片、过期徽章、登录新账号警示按钮、底部 SVG 图标栏（保存/上传/下载/刷新）；保存改为图标点击展开面板
- 设置页 S2：顶部 4 格状态栏（账号数/密码锁/上次备份/WebDAV）+ 密码锁/本地备份/WebDAV 分区卡片 + 合并覆盖分段控件 + 高级选项折叠
- 深色暖灰基底 + 粉底深字按钮（对比 8.9:1），语义色保留

**模块化拆分（handlers/ + ui/）**
- `background.js` 30 个 action 按域拆为 `handlers/{tab,account,settings,backup,webdav}.js`（412 → 210 行装配）
- popup 视图层拆 `ui/popup-render.js`（卡片/分组/状态栏）+ `ui/popup-ui.js`（身份区/横幅/面板），popup.js 降到 388 行
- options WebDAV 区块拆 `ui/webdav-options.js`

**备份口令策略统一**
- 有密码锁 → 导出/导入自动用锁密码加解密（PIN 会话缓存，不落盘）；无锁 → 弹窗输入口令
- 导入先自动试锁密码，失败回退弹窗（兼容 WebDAV 密码/历史备份）

**WebDAV 增强**
- URL 留空自动用默认服务器（`http://192.168.2.1:6086`）；填入则用填入值（不自动补协议）
- 备份固定存储 `workbuddy/网页账号管理/` 目录，逐级自动创建
- 弹窗底部新增上传/下载快捷按钮

**数据一致性修复（P1）**
- `applyCookies` 快照失败不再静默（上报 `snapshotFailed`）
- `site.clear` Cookie 清除有失败时不刷 localStorage（防半退出）

**兼容性（重要）**
- **旧备份文件兼容导入**：v2.2 及更早导出的备份（PBKDF2 10 万次迭代加密）现在可正常导入——`decrypt()` 先尝试 60 万次迭代，失败后自动回退 10 万次，两者都失败才报"解密失败"
- 本地已有账号数据**无感迁移**：v2 明文 Cookie 首次打开自动用主密钥加密（v3），无需手动操作
- 旧 SHA-256 密码锁格式验证通过后自动升级为 PBKDF2 新格式

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
- **移除域名白名单功能**（匹配逻辑存在漏洞、语义与防误操作初衷相悖、体验差）——删除 UI/逻辑/多语言/落地页提及，storage 中遗留白名单数据自动忽略
- 数据版本迁移管线 v2→v3（明文 value 自动加密），失败降级重试

**WebDAV 远程备份（新功能）**
- `lib/webdav.js` 协议客户端（PROPFIND/GET/PUT/DELETE + Basic Auth），走 SW 代理绕过 CORS
- 连接测试 / 立即备份 / 下载恢复 / 定时自动备份（chrome.alarms，每日/每周）
- 远端保留最近 N 份（默认 1，可配置）自动清理
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
