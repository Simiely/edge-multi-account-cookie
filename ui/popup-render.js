/**
 * ui/popup-render.js - 弹窗纯视图函数（参数驱动，无共享状态）
 * 由 popup.html 在 popup.js 之前引入。
 *
 * 设计原则：本文件只包含"输入参数 → DOM 元素"的纯渲染函数，
 * 不引用 currentDomain/currentTabId 等弹窗共享状态、不引用 popup.js 全局函数——
 * 状态与行为均由调用方（popup.js）以参数/回调注入。
 */

/**
 * 头像底色（按账号名哈希取色，稳定且去重分组色依赖）。
 * 色板与主色 #FF9292 和谐：珊瑚 / 灰绿 / 紫 / 蓝。
 */
const AVATAR_PALETTE = [
  ['#FF9292', '#3D1F1F'],   // 珊瑚（主色）
  ['#5D9E8F', '#E1F5EE'],   // 灰绿
  ['#7F77DD', '#EEEDFE'],   // 紫
  ['#6E9FD8', '#E6F1FB'],   // 蓝
];
function avatarColors(name) {
  const s = String(name || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

/**
 * 账号卡片。
 * @param {string} name - 账号名
 * @param {object} account - 账号数据（含 cookies/localStorage）
 * @param {object} handlers - 行为回调 { onEdit(name), onSwitch(name, account), onDelete(name), onIncognito(name, account) }
 *                            由 popup.js 注入（保持本文件纯视图，不依赖全局函数）
 */
function createAccountCard(name, account, handlers = {}) {
  const card = document.createElement('div');
  card.className = 'account-card';

  const [bg, fg] = avatarColors(name);
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.style.background = bg;
  avatar.style.color = fg;
  avatar.textContent = name.charAt(0).toUpperCase();
  card.appendChild(avatar);

  const info = document.createElement('div');
  info.className = 'info';

  const nameEl = document.createElement('div');
  nameEl.className = 'name';
  nameEl.textContent = name;
  info.appendChild(nameEl);

  const meta = document.createElement('div');
  meta.className = 'meta-line';
  const cookieCount = (account.cookies || []).length;
  meta.textContent = `${cookieCount} 个 Cookie`;
  info.appendChild(meta);

  card.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'actions';

  const editBtn = document.createElement('button');
  editBtn.className = 'btn-edit';
  editBtn.textContent = '✎';
  editBtn.title = '重命名';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (handlers.onEdit) handlers.onEdit(name);
  });
  actions.appendChild(editBtn);

  const switchBtn = document.createElement('button');
  switchBtn.className = 'btn-switch-icon';
  switchBtn.textContent = '▶';
  switchBtn.title = '切换到该账号';
  switchBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (handlers.onSwitch) handlers.onSwitch(name, account);
  });
  actions.appendChild(switchBtn);

  if (handlers.onIncognito) {
    const incogBtn = document.createElement('button');
    incogBtn.className = 'btn-incognito';
    incogBtn.title = '在无痕窗口中打开该账号（高敏感站点隔离）';
    // 内联 SVG 图标（隐私眼睛），避免依赖字体字符渲染（Unicode ◯ 在部分字体下显示为空白）
    incogBtn.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
        '<path d="M1.5 8 C3.5 4.5 12.5 4.5 14.5 8 C12.5 11.5 3.5 11.5 1.5 8 Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
        '<circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.3"/>' +
        '<path d="M2 2 L14 14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
      '</svg>';
    incogBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onIncognito(name, account);
    });
    actions.appendChild(incogBtn);
  }

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn-delete';
  deleteBtn.textContent = '✕';
  deleteBtn.title = '删除该账号';
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (handlers.onDelete) handlers.onDelete(name);
  });
  actions.appendChild(deleteBtn);

  card.appendChild(actions);

  card.addEventListener('click', () => {
    if (handlers.onSwitch) handlers.onSwitch(name, account);
  });

  return card;
}

/**
 * 状态栏提示。
 * @param {HTMLElement} element - 状态栏元素（由调用方传入）
 * @param {string} message
 * @param {string} type - success | error | warning
 * @param {number} duration - 自动隐藏毫秒数；0 = 常驻
 */
function showStatus(element, message, type = 'success', duration = 0) {
  element.textContent = message;
  element.className = `status-bar show ${type}`;
  if (duration > 0) {
    setTimeout(() => {
      element.className = 'status-bar';
    }, duration);
  }
}
