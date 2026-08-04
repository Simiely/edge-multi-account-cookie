/**
 * lib/messaging.js - 消息层（页面与 SW 通用）
 *
 * 职责：
 *  - 页面侧：sendMessage(action, payload) Promise 封装（超时保护，防 popup 关闭挂起）
 *  - SW 侧：registerMessageHandler(handlers) 注册路由（sender 校验 + action 白名单）
 *
 * 注意：MV3 消息监听异步响应必须 return true 保活通道（搜索结果确认的常见 bug 点）。
 */

const MSG_TIMEOUT_MS = 60000;

/**
 * 页面侧调用：向 SW 发消息并等待响应。
 * @param {string} action
 * @param {object} [payload]
 * @returns {Promise<*>}
 */
function sendMessage(action, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`消息超时：${action}`));
    }, MSG_TIMEOUT_MS);
    try {
      chrome.runtime.sendMessage({ action, payload }, (resp) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || '消息发送失败'));
          return;
        }
        if (resp && resp.__error) {
          reject(new Error(resp.__error));
          return;
        }
        resolve(resp ? resp.data : undefined);
      });
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

/**
 * SW 侧调用：注册消息路由。
 * @param {Object} handlers - { actionName: async (payload, sender) => data }
 * 返回 { ok:true, data } 或 { __error: message }
 */
function registerMessageHandler(handlers) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // sender 校验：只接受本扩展上下文
    if (!sender || sender.id !== chrome.runtime.id) {
      sendResponse({ __error: '非法来源' });
      return false;
    }
    const action = message && message.action;
    const handler = handlers[action];
    if (!handler) {
      sendResponse({ __error: `未知 action：${action}` });
      return false;
    }
    // 异步处理：return true 保活
    Promise.resolve()
      .then(() => handler(message.payload || {}, sender))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ __error: (err && err.message) || String(err) }));
    return true; // 保持消息通道开放
  });
}

/**
 * 统一错误对象（页面侧 throw 用）。
 */
function messagingError(message) {
  const e = new Error(message);
  e.__messaging = true;
  return e;
}
