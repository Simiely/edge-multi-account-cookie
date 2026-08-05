/**
 * ui/popup-ui.js - 弹窗身份区 / 授权横幅 / 保存面板 视图层（参数驱动，无共享状态）
 * 由 popup.html 在 popup.js 之前引入（顺序：popup-render → popup-ui → popup）。
 *
 * 设计原则：只做"输入 → DOM 更新"，不持有 currentDomain 等共享状态。
 * 依赖：由调用方传入具体值；popup.js 持有状态并编排。
 */

/**
 * 渲染身份锚点（大头像 + 站点 + 子标题）。
 * @param {object} opts - { domain, sub, avatarChar, granted }
 *   granted: true=已授权(主色头像) | false=未授权(灰头像) | null=不支持页面
 */
function renderIdentity(opts = {}) {
  const avatar = document.getElementById('identityAvatar');
  const domainEl = document.getElementById('domainText');
  const subEl = document.getElementById('identitySub');
  const permEl = document.getElementById('permStatus');

  domainEl.textContent = opts.domain || '不支持该页面';
  subEl.textContent = opts.sub || '';

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
 * 切换保存面板展开/收起。返回切换后的可见状态（供调用方判断）。
 * @returns {boolean} true=已展开, false=已收起
 */
function toggleSavePanel() {
  const panel = document.getElementById('savePanel');
  const show = panel.style.display !== 'block';
  panel.style.display = show ? 'block' : 'none';
  if (show) document.getElementById('inputName').focus();
  return show;
}

/**
 * 设置保存面板可见性（保存成功等场景主动收起）。
 */
function setSavePanel(show) {
  document.getElementById('savePanel').style.display = show ? 'block' : 'none';
}

/**
 * 保存按钮忙碌态（图标 div 置灰）。
 */
function setSaveBusy(busy) {
  const btn = document.getElementById('btnSave');
  btn.style.opacity = busy ? '0.5' : '1';
  btn.style.pointerEvents = busy ? 'none' : 'auto';
}
