# 更新日志（CHANGELOG）

> 版本号与 `manifest.json` 同步，每次发布 bump。详细改动背景见 `DEVELOPMENT.md`「关键问题与方案」与 `AGENTS.md`。

## v2.11.0 (2026-08-08)

### 修复
- **WebDAV「同步」按钮文案**：修复弹窗与设置页点击「同步」后文案误变为「一键同步」的问题，现保持「同步」并保留同步动画。
- **密码锁防暴破阈值**：修复 `recordPinFailure` 在**每次失败**后都写入 60s 锁定，导致输错一次即被锁、连正确密码也被挡的 bug。改为仅当连续失败达到阈值（5 次）才锁定，阈值内只累计次数（与文档设计一致）；指数冷却按每满 5 次失败翻倍（60s → 120s → 240s）。

### 重构 / 清理
- **共享切换核心**：新增 `lib/cookies.js: switchAccount(domain, name, account, {tabId, reload})`，封装「清→写→reload」（含主密钥守卫）。popup 经 `account.switch` 消息层、右键菜单直调，两者共用同一核心，消除重复实现（旧 `probeSessionHealthAsync` 与 background 内联探测已删除）。
- **移除会话存活探测（session-health）整套能力**：删除 `lib/health.js`、`updateAccountHealth()`、账号 `health`/`lastVerifiedAt` 字段、右键菜单 ⚠️ 失效标记、后台 `session-health-check` 每日 alarm。切换逻辑简化为「清→写→reload」，不再做存活探测（理由：探测依赖第三方 realm、跨域易误报、维护成本高，对核心「保存/切换」无增益）。
- **清理历史遗留死代码与误导性注释**：修正多处「全部操作经消息层」「探测更新健康标记」等已不成立的注释；UI 文案/布局调整（WebDAV 三按钮同行、清除配置置右；保存面板「①登录新账号 / ②保存新账号」）。

### 文档
- 同步修订 `AGENTS.md` / `DEVELOPMENT.md` / `REFACTOR_DESIGN.md`：删除对已移除会话探测功能的描述，补充实际双轨架构与 PIN 锁行为，标注 `REFACTOR_DESIGN.md` 为已演进的设计提案。

## 历史版本

v2.5.0 – v2.10.0 的逐项改动（明文主密钥、防暴破、Partitioned Cookie 透传、消息层、WebDAV、墓碑软删除等）详见 `DEVELOPMENT.md`「关键问题与方案」§10 – §36。
