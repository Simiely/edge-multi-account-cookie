/**
 * ui/popup-render.js - 弹窗纯视图函数（参数驱动，无共享状态）
 * 由 popup.html 在 popup.js 之前引入。
 *
 * 设计原则：本文件只包含"输入参数 → DOM 元素"的纯渲染函数，
 * 不引用 currentDomain/currentTabId 等弹窗共享状态——状态由 popup.js 编排时传入。
 * 依赖：popup.js 的全局 handleEditAccount/handleSwitchAccount/handleDeleteAccount
 *       （卡片回调闭包调用，函数声明提升，跨文件可用）。
 */

/**
 * 分组 → 头像底色（降饱和，与主色 #FF9292 和谐）。空分组用主色。
 */
const GROUP_COLORS = {
  '': ['#FF9292', '#3D1F1F'],           // 默认（主色）
  '工作': ['#D47373', '#2B1212'],        // 深珊瑚
  '个人': ['#5D9E8F', '#E1F5EE'],        // 灰绿
  '测试': ['#7F77DD', '#EEEDFE'],        // 紫
};
function avatarColors(group) {
  const g = String(group || '').trim();
  return GROUP_COLORS[g] || ['#7F77DD', '#EEEDFE']; // 未知分组 → 紫
}

/**
 * 分组标题行（可折叠）。
 * @param {string} group
 * @param {Set<string>} collapsedGroups - 折叠状态集（由调用方持有，避免跨文件共享状态）
 * @returns {HTMLElement}
 */
function createGroupHeader(group, collapsedGroups) {
  const header = document.createElement('div');
  header.className = 'group-header';
  const label = document.createElement('span');
  label.textContent = group || '未分组';
  const toggle = document.createElement('span');
  toggle.className = 'group-toggle';
  toggle.textContent = collapsedGroups.has(group) ? '▸' : '▾';
  header.appendChild(label);
  header.appendChild(toggle);
  header.addEventListener('click', () => {
    if (collapsedGroups.has(group)) {
      collapsedGroups.delete(group);
    } else {
      collapsedGroups.add(group);
    }
    renderAccountList();
  });
  return header;
}

/**
 * 账号卡片。回调引用 popup.js 的全局操作函数（声明提升，跨文件可用）。
 */
function createAccountCard(name, account, group) {
  const card = document.createElement('div');
  card.className = 'account-card';

  const [bg, fg] = avatarColors(group);
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
  meta.className = 'group-tag';
  const cookieCount = (account.cookies || []).length;
  meta.textContent = `${cookieCount} 个 Cookie`;
  if (group) meta.textContent += ` · ${group}`;
  info.appendChild(meta);

  card.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'actions';

  const editBtn = document.createElement('button');
  editBtn.className = 'btn-edit';
  editBtn.textContent = '✎';
  editBtn.title = '编辑（重命名/分组）';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handleEditAccount(name);
  });
  actions.appendChild(editBtn);

  const switchBtn = document.createElement('button');
  switchBtn.className = 'btn-switch-icon';
  switchBtn.textContent = '▶';
  switchBtn.title = '切换到该账号';
  switchBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handleSwitchAccount(name, account);
  });
  actions.appendChild(switchBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn-delete';
  deleteBtn.textContent = '✕';
  deleteBtn.title = '删除该账号';
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handleDeleteAccount(name);
  });
  actions.appendChild(deleteBtn);

  card.appendChild(actions);

  card.addEventListener('click', () => {
    handleSwitchAccount(name, account);
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
