// 调试辅助（内部诊断）
// 目的：出错时自动把「环境快照 + 运行日志 + 错误栈」打到控制台并可复制到剪贴板，
//      以便用户直接粘贴回来精准定位。纯诊断，与业务逻辑分离，可在正式版移除。
window.__debugLog = window.__debugLog || [];

function installDebugTrap() {
  const push = function (rec) {
    window.__debugLog.push(Object.assign({ at: new Date().toISOString() }, rec));
    if (window.__debugLog.length > 50) window.__debugLog.shift();
  };
  window.addEventListener('error', function (ev) {
    push({
      type: 'error',
      message: ev.message || '',
      source: (ev.filename || '') + (ev.lineno ? ':' + ev.lineno : ''),
      stack: (ev.error && ev.error.stack) || ''
    });
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason || {};
    push({ type: 'unhandledrejection', message: (r.message != null ? r.message : String(r)), stack: r.stack || '' });
  });
}

function buildDebugReport(label) {
  var lines = [];
  var add = function (k, v) {
    var val;
    if (v === undefined) val = 'undefined';
    else if (v === null) val = 'null';
    else if (typeof v === 'object') { try { val = JSON.stringify(v); } catch (e) { val = String(v); } }
    else val = v;
    lines.push(k + ': ' + val);
  };
  add('label', label || '(none)');
  add('userAgent', navigator.userAgent);
  add('platform', navigator.platform || '(n/a)');
  add('url', location.href);
  add('timestamp', new Date().toISOString());
  var man = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest() : null;
  add('manifest.version', man ? man.version : '(no chrome.runtime)');
  add('manifest.permissions', man ? man.permissions : '(n/a)');
  add('chrome.browsingData.exists', !!(typeof chrome !== 'undefined' && chrome.browsingData));
  add('chrome.browsingData.remove.fn', !!(typeof chrome !== 'undefined' && chrome.browsingData && chrome.browsingData.remove));
  add('chrome.windows.create.fn', !!(typeof chrome !== 'undefined' && chrome.windows && chrome.windows.create));
  add('chrome.tabs.query.fn', !!(typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query));
  add('chrome.scripting.executeScript.fn', !!(typeof chrome !== 'undefined' && chrome.scripting && chrome.scripting.executeScript));
  add('chrome.cookies.getAllCookieStores.fn', !!(typeof chrome !== 'undefined' && chrome.cookies && chrome.cookies.getAllCookieStores));
  add('currentDomain', (typeof currentDomain !== 'undefined' ? currentDomain : '(undefined)'));
  add('currentTabId', (typeof currentTabId !== 'undefined' ? currentTabId : '(undefined)'));
  if (window.__debugLog && window.__debugLog.length) {
    add('recentErrorLog', window.__debugLog.slice(-8));
  }
  return lines.join('\n');
}

// 生成并打印完整调试快照；有剪贴板权限时一并复制，返回是否复制成功。
async function copyDebugReport(label) {
  var text = buildDebugReport(label || 'manual');
  var header = '[CookieSwitcher-debug] report for \'' + (label || 'manual') + '\'';
  console.error(header + ':\n' + text);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return { ok: true, text: text };
    }
  } catch (e) { /* clipboard 需要用户手势，失败也不致命 */ }
  return { ok: false, text: text };
}