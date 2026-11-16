const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function model() {
  const context = vm.createContext({ URL });
  vm.runInContext(read('security.js'), context);
  vm.runInContext(read('ui-model.js'), context);
  return context.OzonUi;
}
const plain = (value) => JSON.parse(JSON.stringify(value));

test('default period is one calendar month ago through local today', () => {
  assert.deepEqual(plain(model().initialPeriod({}, new Date(2026, 10, 16, 23, 59))), {
    preset: 'lastMonth', dateFrom: '2026-10-16', dateTo: '2026-11-16',
  });
});
test('month subtraction clamps month ends and leap days without overflow', () => {
  const ui = model();
  for (const [date, expected] of [[new Date(2026, 2, 31), '2026-02-28'],
    [new Date(2024, 2, 31), '2024-02-29'], [new Date(2026, 0, 31), '2025-12-31'],
    [new Date(2026, 4, 31), '2026-04-30']]) {
    assert.equal(ui.periodRange('lastMonth', date).dateFrom, expected);
  }
});
test('rolling periods recompute on opening; old saved dates do not override the new default', () => {
  const ui = model();
  for (const saved of [{ dateFrom: '2020-01-01', dateTo: '2020-02-01' },
    { periodPreset: 'lastMonth', dateFrom: '2020-01-01', dateTo: '2020-02-01' }]) {
    assert.equal(ui.initialPeriod(saved, new Date(2026, 10, 16)).dateFrom, '2026-10-16');
  }
});
test('explicit custom dates survive reopening while invalid settings fall back to a useful period', () => {
  const ui = model();
  assert.equal(ui.initialPeriod({ periodPreset: 'custom', dateFrom: '2026-01-01', dateTo: '2026-02-01' }).dateFrom, '2026-01-01');
  for (const dateFrom of ['2026-02-30', 'invalid', '2026-12-31']) {
    assert.equal(ui.initialPeriod({ periodPreset: 'custom', dateFrom, dateTo: '2026-02-01' }).preset, 'lastMonth');
  }
});
test('week has seven inclusive days; current year ends today and historical year ends December 31', () => {
  const ui = model(), now = new Date(2026, 10, 16);
  assert.equal(ui.periodRange('week', now).dateFrom, '2026-11-10');
  assert.deepEqual(plain(ui.periodRange('year', now, 2026)), { dateFrom: '2026-01-01', dateTo: '2026-11-16' });
  assert.deepEqual(plain(ui.periodRange('year', now, 2025)), { dateFrom: '2025-01-01', dateTo: '2025-12-31' });
  assert.deepEqual(plain(ui.periodRange('all', now)), { dateFrom: '', dateTo: '2026-11-16' });
});
test('single-order parser retains HTTPS and exact-domain restrictions', () => {
  const ui = model();
  assert.equal(ui.normalizeSpecificOrder('12345678-0001').orderNumber, '12345678-0001');
  for (const url of ['http://ozon.ru/my/orderdetails/?order=123456',
    'https://ozon.ru.evil.invalid/my/orderdetails/?order=123456',
    'https://user@ozon.ru/my/orderdetails/?order=123456',
    'https://ozon.ru/redirect?order=123456', '------']) assert.throws(() => ui.normalizeSpecificOrder(url));
});

function navigation(initial = [], session = {}) {
  let nextId = 100;
  const tabs = new Map(initial.map((tab) => [tab.id, { ...tab }]));
  const created = [], updated = [];
  const context = vm.createContext({ URL, chrome: {
    storage: { session: {
      get: async (key) => ({ [key]: session[key] }),
      set: async (items) => Object.assign(session, items),
    } },
    tabs: {
      get: async (id) => { if (!tabs.has(id)) throw new Error('closed'); return tabs.get(id); },
      query: async ({ windowId }) => [...tabs.values()].filter((tab) => tab.windowId === windowId),
      create: async (details) => { const tab = { ...details, id: nextId++ }; tabs.set(tab.id, tab); created.push(tab); return tab; },
      update: async (id, details) => { updated.push({ id, ...details }); Object.assign(tabs.get(id), details); return tabs.get(id); },
    },
  } });
  vm.runInContext(read('security.js'), context);
  vm.runInContext(read('navigation.js'), context);
  return { api: context.OzonNavigation, tabs, created, updated, session };
}
const archive = 'https://www.ozon.ru/my/orderlist?selectedTab=archive';
test('opening the panel creates the exact requested archive URL without navigating an unrelated tab', async () => {
  const env = navigation([{ id: 7, windowId: 1, url: 'https://example.invalid/work', active: true }]);
  const result = await env.api.ensureArchiveTab(1);
  assert.equal(env.created.length, 1); assert.equal(env.created[0].url, archive);
  assert.equal(env.tabs.get(7).url, 'https://example.invalid/work');
  assert.equal(env.updated[0].id, result.tabId); assert.equal(env.updated[0].active, true);
});
test('existing archive is reused; repeated and concurrent opens never duplicate it', async () => {
  for (const initial of [[], [{ id: 7, windowId: 1, url: archive, active: false }]]) {
    const env = navigation(initial);
    const results = await Promise.all([env.api.ensureArchiveTab(1), env.api.ensureArchiveTab(1), env.api.ensureArchiveTab(1)]);
    assert.equal(new Set(results.map((result) => result.tabId)).size, 1);
    await env.api.ensureArchiveTab(1);
    assert.equal(env.created.length, initial.length ? 0 : 1);
  }
});
test('stored source binding survives a new worker instance and does not follow the active detail tab', async () => {
  const session = { 'obo-source-tab:1': 8 };
  const env = navigation([{ id: 8, windowId: 1, url: archive, active: false },
    { id: 9, windowId: 1, url: 'https://www.ozon.ru/my/orderdetails/?order=123456', active: true }], session);
  assert.equal((await env.api.ensureArchiveTab(1, false)).tabId, 8);
  assert.equal(env.created.length, 0); assert.equal(env.updated.length, 0);
});
test('a closed or repurposed source tab is recovered safely and windows stay separate', async () => {
  const env = navigation([{ id: 7, windowId: 2, url: archive },
    { id: 8, windowId: 1, url: 'https://example.invalid/' }], { 'obo-source-tab:1': 8, 'obo-source-tab:3': 999 });
  assert.notEqual((await env.api.ensureArchiveTab(1)).tabId, 7);
  assert.equal(env.tabs.get(8).url, 'https://example.invalid/');
  await env.api.ensureArchiveTab(3);
  assert.deepEqual(env.created.map((tab) => tab.windowId), [1, 3]);
  await assert.rejects(env.api.ensureArchiveTab(-1));
});
test('archive identification rejects external domains, wrong tabs, and redirects', () => {
  const { api } = navigation();
  for (const url of ['https://example.invalid/my/orderlist?selectedTab=archive',
    'https://www.ozon.ru/my/orderlist?selectedTab=active', 'https://www.ozon.ru/?next=/my/orderlist?selectedTab=archive',
    'http://www.ozon.ru/my/orderlist?selectedTab=archive']) assert.equal(api.isArchiveUrl(url), false);
});
