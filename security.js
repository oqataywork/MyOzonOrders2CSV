// Shared by the service worker, popup and isolated content scripts.
(() => {
  'use strict';

  function ozonUrl(value, base) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value, base);
      if (url.protocol !== 'https:' ||
          !['ozon.ru', 'www.ozon.ru'].includes(url.hostname) ||
          url.username || url.password || url.port) return null;
      return url;
    } catch {
      return null;
    }
  }

  function orderUrl(value, base) {
    const url = ozonUrl(value, base);
    return url && /^\/my\/orderdetails(?:\/|$)/i.test(url.pathname) ? url : null;
  }

  function returnUrl(value, base) {
    const url = ozonUrl(value, base);
    return url && /^\/my\/returnCreation\/items\/?$/i.test(url.pathname) ? url : null;
  }

  globalThis.OzonSecurity = Object.freeze({ ozonUrl, orderUrl, returnUrl });
})();
