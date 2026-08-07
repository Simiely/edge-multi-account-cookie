/**
 * ui/popup-ui.js - 弹窗身份区 / 授权横幅 / 保存面板 视图层（参数驱动，无共享状态）
 * 由 popup.html 在 popup.js 之前引入（顺序：popup-render → popup-ui → popup）。
 *
 * 设计原则：只做"输入 → DOM 更新"，不持有 currentDomain 等共享状态。
 * 依赖：由调用方传入具体值；popup.js 持有状态并编排。
 */

/**
 * 渲染身份锚点（大头像 + 站点 + 当前账号）。
 * @param {object} opts - { domain, sub, currentAccount, avatarChar, granted }
 *   granted: true=已授权(主色头像) | false=未授权(灰头像) | null=不支持页面
 *   currentAccount: 当前使用的已保存账号名（v2.8.0，无则显示 sub 原文）
 */
function renderIdentity(opts = {}) {
  const avatar = document.getElementById('identityAvatar');
  const domainEl = document.getElementById('domainText');
  const subEl = document.getElementById('identitySub');
  const permEl = document.getElementById('permStatus');

  domainEl.textContent = opts.domain || '不支持该页面';
  // 已匹配到当前账号 → 突出显示；否则显示调用方传入的 sub（授权状态/提示）
  if (opts.currentAccount) {
    subEl.textContent = `当前使用：${opts.currentAccount}`;
    subEl.className = 'identity-sub';
  } else {
    subEl.textContent = opts.sub || '';
    subEl.className = 'identity-sub muted';
  }

  if (opts.granted === true) {
    avatar.textContent = (opts.avatarChar || '?').charAt(0).toUpperCase();
    avatar.style.background = '#FF9292';
    avatar.style.color = '#3D1F1F';
    permEl.className = 'header-status';
  } else if (opts.granted === false) {
    avatar.textContent = (opts.avatarChar || '?').charAt(0).toUpperCase();
    avatar.style.background = '#5F5E5A';
    avatar.style.color = '#F1EFE8';
    permEl.className = 'header-status gray';
  } else {
    // 不支持页面 / 权限 API 不可用
    avatar.textContent = '?';
    avatar.style.background = '#5F5E5A';
    avatar.style.color = '#F1EFE8';
    permEl.className = 'header-status gray';
  }
}

/**
 * 显示授权横幅（含授权按钮）。
 * @param {string} domain - 待授权域名
 * @param {Function} onGrant - 点击授权按钮的回调（由 popup.js 传入 requestHostPermission）
 */
function renderGrantBanner(domain, onGrant) {
  const banner = document.getElementById('grantBanner');
  banner.style.display = 'block';
  banner.innerHTML = `
    <div>需要授权才能操作 <strong>${domain}</strong> 的 Cookie</div>
    <button class="grant-btn" id="btnGrantPerm">授权访问此网站</button>
  `;
  document.getElementById('btnGrantPerm').addEventListener('click', onGrant);
}

/**
 * 隐藏授权横幅。
 */
function hideGrantBanner() {
  const banner = document.getElementById('grantBanner');
  banner.style.display = 'none';
}

/**
 * 保存按钮忙碌态（顶部保存面板按钮置灰）。
 */
function setSaveBusy(busy) {
  const btn = document.getElementById('btnSaveConfirm');
  btn.disabled = busy;
  btn.textContent = busy ? '保存中...' : '保存账号';
}
