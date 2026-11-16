(() => {
  'use strict';
  const ARCHIVE_URL = 'https://www.ozon.ru/my/orderlist?selectedTab=archive';
  const pending = new Map();

  function isArchiveUrl(value) {
    const url = OzonSecurity.ozonUrl(value);
    return Boolean(url && /^\/my\/orderlist\/?$/.test(url.pathname) && url.searchParams.get('selectedTab') === 'archive');
  }

  async function findOrCreate(windowId) {
    const key = `obo-source-tab:${windowId}`;
    const saved = await chrome.storage.session.get(key);
    let tab = saved[key] ? await chrome.tabs.get(saved[key]).catch(() => null) : null;
    if (!tab || tab.windowId !== windowId || !isArchiveUrl(tab.url || tab.pendingUrl)) {
      const tabs = await chrome.tabs.query({ windowId, url: ['https://ozon.ru/*', 'https://www.ozon.ru/*'] });
      tab = tabs.filter((item) => isArchiveUrl(item.url || item.pendingUrl)).sort((a, b) => Number(b.active) - Number(a.active))[0];
    }
    if (!tab) tab = await chrome.tabs.create({ windowId, url: ARCHIVE_URL, active: false });
    await chrome.storage.session.set({ [key]: tab.id });
    return tab;
  }

  async function ensureArchiveTab(windowId, activate = true) {
    if (!Number.isInteger(windowId) || windowId < 0) throw new Error('Не удалось определить окно Chrome.');
    // Panel initialization and the toolbar click may happen simultaneously.
    if (!pending.has(windowId)) {
      pending.set(windowId, findOrCreate(windowId).finally(() => pending.delete(windowId)));
    }
    const tab = await pending.get(windowId);
    if (activate) await chrome.tabs.update(tab.id, { active: true });
    return { tabId: tab.id, url: ARCHIVE_URL };
  }

  globalThis.OzonNavigation = Object.freeze({ ARCHIVE_URL, isArchiveUrl, ensureArchiveTab });
})();
