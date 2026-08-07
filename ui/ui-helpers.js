/**
 * ui/ui-helpers.js - 跨页面共享 UI 工具（参数驱动，无 chrome API、无共享状态）
 * 由 options.html 在 webdav-options.js 之前引入（顺序：messaging → ui-helpers → webdav-options → options.js）。
 *
 * 设计原则：只放"输入 → DOM 更新"的通用函数，单一来源——页面文件（options.js）不再各自定义。
 */
/**
 * 状态消息提示（设置页 status-msg 元素通用）。
 * @param {HTMLElement} el - 状态元素（由调用方传入）
 * @param {string} msg
 * @param {string} type - success | error | warning
 */
function showMsg(el, msg, type) {
  el.textContent = msg;
  el.className = `status-msg show ${type}`;
  setTimeout(() => {
    el.className = 'status-msg';
  }, 4000);
}
