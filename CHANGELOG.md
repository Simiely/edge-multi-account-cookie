# 更新日志（CHANGELOG）

## v2.7.3（当前版本）

**切换流程修复：探测不再阻塞登录刷新（P0）**

- **根因**：v2.7.0 在切换后、页面刷新前插入了 `await probeSession()`（探测 fetch 无超时保护）——若 userinfo 端点挂起，`chrome.tabs.reload` 被无限期阻塞，导致"cookie 已写入但页面不刷新"的假登录失败（v2.6.0 是写 cookie → 立即刷新，无此问题）
- **修复**：探测移到 reload 之后**后台异步执行**（fire-and-forget），切换路径恢复与 v2.6.0 一致（写 cookie → 立即 reload → 登录生效）；探测失败静默降级，绝不阻塞切换

**WebDAV 数据标记核对（防备份覆盖新数据）**

- **备份文件加元数据标记**：导出数据内附 `__meta`（exportedAt 导出时间 + accountMeta 账号清单指纹），用于新旧核对
- **下载恢复前差异核对**：新增 `webdav.preview` action——点击「下载恢复」先下载最新备份并解密，与本地数据对比，展示：远端新增 / 同名远端更新 / 本地独有 / 远端导出时间，并给出危险提示（replace 会丢本地独有账号、远端比本地旧）
- **两步确认**：核对结果确认后才真正导入，杜绝"旧备份覆盖新保存账号"

## v2.7.2

**紧急修复：保存时误删 host-only cookie 导致登录失败（P0）**

- **根因**：v2.7.0 引入的保存前按 `name` 去重（`dedupeCookies`），会把不带前导点的 host-only cookie（如 `KEYCLOAK_SESSION@www.codebuddy.cn`）误删——但域 cookie（`.www.codebuddy.cn`）与 host-only cookie 是浏览器中**并存的两套合法 cookie**，Keycloak 登录需要它们同时存在。删除后切换缺关键 cookie → 登录失败（v2.6.0 无此问题，实测可正常登录）
- **修复**：保存/切换流程**完全移除按 name 去重**，恢复 v2.6.0 的原样保存（`getCookies` 已按 `name|domain|path` 去重，粒度正确，两套 cookie 都会保留）；`dedupeCookies` 重写为只读诊断函数 `detectDuplicateNames`（仅提示不修改数据）
- **影响面**：受 v2.7.0/v2.7.1 影响的用户，**需重新登录并保存账号**以恢复完整 cookie（历史被删数据无法自动恢复）
- 切换前"会话混存"误报提示同步移除

## v2.7.1

**数据管理**

- **清空本地账号数据**：设置页新增「数据管理」卡片 + 「清空本地账号数据」按钮（双重确认，需输入"清空"确认），一键删除扩展本地保存的全部账号 Cookie 快照；密码锁 / WebDAV 配置 / 主密钥均保留不受影响

## v2.7.0

**会话健康管理（解决"数据混乱 / 登录失效"两类问题）**

- **保存前自动去重**：同名 cookie 多条时保留域 cookie（domain 带前导点），消除"多套会话混存"（如 Keycloak 双套 KEYCLOAK_SESSION/AUTH_SESSION_ID 并存导致的切换失效）；去重数量与警告实时提示
- **会话存活探测**：新增 `lib/health.js`，切换后请求 Keycloak userinfo 端点判断会话是否仍被服务端认可（200=有效 / 401=失效）；非 Keycloak 站点自动跳过，无权限/网络失败降级为 unknown 不误报
- **健康状态标记**：每个账号记录 `health`（ok/expired/unknown）与 `lastVerifiedAt`；弹窗账号卡片显示绿点（有效）/红点（失效），右键菜单失效账号带 ⚠ 前缀
- **切换前自检**：检测到历史混存数据先提示"建议删除后重新保存"（不拦截切换）
- **每日会话体检**：`chrome.alarms` 每 24h 后台探测所有账号会话存活状态，失效账号自动标红（无需等切换才发现）
- **数据兼容**：旧账号无 health 字段自动按 unknown 处理，读写无损

**UI / 交互修复**

- **移除分组功能**：删除分组输入框、分组折叠、分组编辑与分组排序（popup UI、handlers、多语言同步清理）；头像颜色改为按账号名哈希取色
- **保存交互明确**：保存面板新增「保存账号」按钮，输入名称后点击即可保存（回车仍可用）
- **WebDAV 测试连接修复**：已保存配置后密码框留空再点「连接测试」不再报"请填写用户名与密码"——`webdav.test` 自动复用已保存凭据（用户名/密码任一项留空均复用）

## v2.6.0

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
