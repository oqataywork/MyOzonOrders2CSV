const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const source = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const orderUrl = 'https://www.ozon.ru/my/orderdetails/?order=12345678-0001';
const returnUrl = 'https://www.ozon.ru/my/returnCreation/items?orderNumber=12345678-0001';
const unsafeUrls = [
  'https://example.invalid/my/orderdetails/?order=12345678',
  '//example.invalid/my/orderdetails/?order=12345678',
  'http://www.ozon.ru/my/orderdetails/?order=12345678',
  'javascript:alert(1)//my/orderdetails/',
  'data:text/html,/my/orderdetails/',
  'https://ozon.ru.example.invalid/my/orderdetails/',
  'https://seller.ozon.ru/my/orderdetails/',
  'https://ozon.ru@evil.invalid/my/orderdetails/',
  'https://user:password@ozon.ru/my/orderdetails/',
  'https://ozon.ru:8443/my/orderdetails/',
  'https://ozon.ru./my/orderdetails/',
  'https://example.invalid/?next=https://ozon.ru/my/orderdetails/',
  '', null, {},
];

function environment() {
  const calls = { get: [], set: [], messages: [], fetch: [] };
  const stored = {};
  const context = vm.createContext({
    URL, AbortController, Blob, console,
    setTimeout: (fn, delay) => delay >= 15000 ? setTimeout(fn, delay) : setTimeout(fn, 0),
    clearTimeout,
    location: new URL(orderUrl),
    window: { addEventListener() {} },
    document: { getElementById: () => null },
    chrome: {
      runtime: {
        getManifest: () => JSON.parse(source('manifest.json')),
        onMessage: { addListener() {} },
        sendMessage: async (message) => { calls.messages.push(message); return { ok: false }; },
      },
      storage: { local: {
        get: async (key) => { calls.get.push(key); return { ...stored }; },
        set: async (value) => { calls.set.push(value); Object.assign(stored, value); },
      } },
    },
    fetch: async (...args) => { calls.fetch.push(args); return { ok: false }; },
  });
  vm.runInContext(source('security.js'), context);
  vm.runInContext(source('return-tools.js'), context);
  return { context, calls, stored };
}

function content() {
  const env = environment();
  const exposed = ['csvCell', 'makeCsv', 'isOrderLink', 'findReturnUrl', 'absoluteUrl',
    'fetchOrderDetail', 'fetchWithStop', 'writeCachedOrder', 'enrichOrders', 'normalizeSpecificOrder'];
  const script = source('content.js').replace(/\}\)\(\);\s*$/, `globalThis.api = { ${exposed.join(',')} };\n})();`);
  vm.runInContext(script, env.context);
  return { ...env, api: env.context.api };
}

// Independent CSV reader: assert cell boundaries and escaped data, not just substrings.
function parseCsv(csv) {
  const rows = [], row = [];
  let field = '', quoted = false;
  csv = csv.replace(/^\uFEFF/, '');
  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = !quoted;
    } else if (!quoted && (char === ';' || char === '\r' || char === '\n')) {
      row.push(field); field = '';
      if (char !== ';') {
        rows.push([...row]); row.length = 0;
        if (char === '\r' && csv[i + 1] === '\n') i += 1;
      }
    } else field += char;
  }
  assert.equal(quoted, false, 'CSV quotes must balance');
  row.push(field); rows.push([...row]);
  return rows;
}

test('CSV neutralizes formula markers, whitespace, controls and full-width variants', () => {
  const { api } = content();
  const payloads = ['=SUM(1+1)', '+SUM(1,1)', '-1+2', '@SUM(1,1)',
    ' \t=1+1', '\r\n=1+1', '\u0000=1+1', '\u200b=1+1', '\ufeff=1+1',
    '＝1+1', '＋1+1', '－1+1', '＠SUM(1,1)', '\ttext', '\rtext', '\ntext'];
  for (const payload of payloads) {
    const parsed = parseCsv(api.csvCell(payload));
    assert.deepEqual(parsed, [['\t' + payload]], JSON.stringify(payload));
  }
});

test('CSV keeps quotes, delimiters and multiline payloads within a single cell', () => {
  const { api } = content();
  for (const payload of ['=1+2";=1+2', '=1+2\r\n+SUM(1,2)', 'Товар;"=1+1"\nстрока']) {
    const cells = parseCsv([api.csvCell(payload), api.csvCell('next')].join(';'));
    assert.equal(cells.length, 1);
    assert.equal(cells[0].length, 2);
    assert.equal(cells[0][0], (payload.startsWith('=') ? '\t' : '') + payload);
    assert.equal(cells[0][1], 'next');
  }
});

test('normal text, dates, decimal prices and numeric quantities remain usable', () => {
  const { api } = content();
  for (const value of ['Молоко 3,2%', '123,45', '2026-11-16', '12345678-0001', 0, 2, -2, null]) {
    assert.deepEqual(parseCsv(api.csvCell(value)), [[String(value ?? '')]]);
  }
});

test('full CSV export protects product data and metadata, preserving price formatting', () => {
  const { api } = content();
  const csv = api.makeCsv([{
    'Товар': '=SUM(1+1)', 'Статус': '+SUM(1,1)', 'Цена товара': '123.45', 'Количество': '2',
  }], { specificOrder: '=1+1', useCache: false }, { stopReason: '@SUM(1,1)' });
  const rows = parseCsv(csv);
  const header = rows.find((row) => row[0] === 'Дата заказа');
  const product = rows.at(-1);
  assert.equal(product.length, header.length);
  assert.equal(product[header.indexOf('Товар')], '\t=SUM(1+1)');
  assert.equal(product[header.indexOf('Статус')], '\t+SUM(1,1)');
  assert.equal(product[header.indexOf('Цена товара')], '123,45');
  assert.equal(product[header.indexOf('Количество')], '2');
  assert.equal(rows.find((row) => row[0] === 'Конкретный заказ')[1], '\t=1+1');
  assert.equal(rows.find((row) => row[0] === 'Завершение списка')[1], '\t@SUM(1,1)');
});

test('URL allowlist accepts only the two HTTPS origins without credentials or alternate ports', () => {
  const { context } = environment();
  for (const input of unsafeUrls) assert.equal(context.OzonSecurity.ozonUrl(input, orderUrl), null, String(input));
  for (const input of [orderUrl, '/my/orderdetails/?order=12345678',
    'https://ozon.ru:443/my/orderdetails/?order=12345678',
    'https://WWW.OZON.RU/my/orderdetails/12345678']) {
    assert.ok(context.OzonSecurity.orderUrl(input, orderUrl), input);
  }
  for (const input of ['https://ozon.ru/my/orderlist/?x=/my/orderdetails/',
    'https://ozon.ru/redirect?next=/my/orderdetails/',
    'https://ozon.ru/my/orderdetails.evil/', 'https://ozon.ru/my/orderdetails/../redirect']) {
    assert.equal(context.OzonSecurity.orderUrl(input), null, input);
  }
  assert.ok(context.OzonSecurity.returnUrl(returnUrl));
  assert.equal(context.OzonSecurity.returnUrl('https://ozon.ru/redirect'), null);
});

test('DOM order links and manual order input apply the allowlist', () => {
  const { api } = content();
  for (const input of unsafeUrls) {
    assert.equal(api.isOrderLink({ getAttribute: () => input }), false);
    assert.equal(api.normalizeSpecificOrder(input).orderUrl, '');
    assert.equal(api.absoluteUrl(input), '');
  }
  assert.equal(api.isOrderLink({ getAttribute: () => '/my/orderdetails/?order=12345678' }), true);
  assert.equal(api.normalizeSpecificOrder('12345678-0001').orderUrl, orderUrl);
});

test('return links found in DOM cannot leave the approved return page', () => {
  const { api } = content();
  for (const href of ['https://example.invalid/my/returnCreation/items', 'https://ozon.ru/redirect', returnUrl]) {
    const node = { textContent: 'Вернуть товары', children: [], closest: () => null, getAttribute: () => href };
    const doc = { querySelectorAll: () => [node] };
    assert.equal(api.findReturnUrl(doc), href === returnUrl ? returnUrl : '');
  }
});

test('invalid detail URLs cause neither a background message nor a fetch', async () => {
  const { api, calls } = content();
  for (const input of unsafeUrls) assert.equal(await api.fetchOrderDetail(input, {}), null);
  assert.equal(calls.messages.length, 0);
  assert.equal(calls.fetch.length, 0);
});

test('fetch sink validates URLs and forces redirect rejection even when caller requests follow', async () => {
  const { api, calls } = content();
  for (const input of unsafeUrls) await assert.rejects(api.fetchWithStop(input, {}), /Заблокирован/);
  assert.equal(calls.fetch.length, 0);
  await api.fetchWithStop(orderUrl, { credentials: 'include', redirect: 'follow' });
  assert.equal(calls.fetch[0][0], orderUrl);
  assert.equal(calls.fetch[0][1].redirect, 'error');
  assert.equal(calls.fetch[0][1].credentials, 'include');
});

function background(detail = { products: [{ product: 'Тестовый товар' }] }, redirectedUrl) {
  const env = environment();
  const calls = { create: [], update: [], remove: [], send: [] };
  let currentUrl;
  env.context.chrome.tabs = {
    create: async (value) => { calls.create.push(value); currentUrl = value.url; return { id: 10 }; },
    update: async (id, value) => { calls.update.push([id, value]); if (value.url) currentUrl = value.url; },
    remove: async (id) => calls.remove.push(id),
    get: async () => ({ status: 'complete', url: redirectedUrl || currentUrl }),
    sendMessage: async (id, message) => {
      calls.send.push([id, message]);
      return message.type === 'OZON_PARSE_OPEN_DETAIL' ? { ok: true, detail } : {
        ok: true, returnCheck: { returnCheck: 'completed', pageRecognized: true, items: [] },
      };
    },
    onUpdated: { addListener() {}, removeListener() {} },
  };
  env.context.importScripts = (file) => vm.runInContext(source(file), env.context);
  vm.runInContext(source('background.js'), env.context);
  return { ...env, calls };
}

test('background rejects untrusted order URLs at the privileged tab-creation boundary', async () => {
  const { context, calls } = background();
  for (const input of unsafeUrls) await assert.rejects(context.parseDetailInTab(input, {}), /Заблокирована/);
  assert.equal(calls.create.length, 0);
});

test('background rejects malicious return URLs and closes its temporary tab', async () => {
  for (const badUrl of ['https://example.invalid/my/returnCreation/items', 'http://ozon.ru/my/returnCreation/items',
    'https://ozon.ru/redirect', 'https://user@ozon.ru/my/returnCreation/items']) {
    const { context, calls } = background({ products: [{ product: 'Тестовый товар' }], returnUrl: badUrl });
    const detail = await context.parseDetailInTab(orderUrl, {});
    assert.equal(detail.returnCheck.returnCheck, 'error');
    assert.match(detail.returnCheck.error, /Заблокирована/);
    assert.equal(calls.update.length, 0);
    assert.deepEqual(calls.remove, [10]);
  }
});

test('valid detail/return navigation still works without broad tab permissions', async () => {
  const { context, calls } = background({ products: [{ product: 'Тестовый товар' }], returnUrl });
  const detail = await context.parseDetailInTab(orderUrl, {});
  assert.equal(detail.returnCheck.returnCheck, 'completed');
  assert.equal(calls.create[0].url, orderUrl);
  assert.equal(calls.update[0][1].url, returnUrl);
  assert.deepEqual(calls.remove, [10]);
});

test('unexpected tab destination is not parsed and the tab is closed', async () => {
  const { context, calls } = background(undefined, 'https://example.invalid/');
  await assert.rejects(context.parseDetailInTab(orderUrl, {}), /недопустимую/);
  assert.equal(calls.send.length, 0);
  assert.deepEqual(calls.remove, [10]);
});

test('cache disabled or unspecified: export reads fresh data and writes no order history', async () => {
  for (const options of [{ useCache: false }, {}]) {
    const { context, api, calls } = content();
    const base = { 'Номер заказа': '12345678-0001', 'Ссылка на заказ': orderUrl, 'Статус': 'Доставлен' };
    const detail = { orderDate: '2026-11-16', status: 'Доставлен', goodsTotal: '10',
      products: [{ product: 'Тестовый товар', price: '10', quantity: '1' }],
      returnCheck: { returnCheck: 'unavailable', cacheable: true } };
    context.chrome.runtime.sendMessage = async (message) => { calls.messages.push(message); return { ok: true, detail }; };
    const result = await api.enrichOrders([base], options);
    assert.equal(result.rows.length, 1);
    assert.equal(result.cacheWrites, 0);
    assert.equal(result.cacheHits, 0);
    assert.equal(calls.get.length, 0);
    assert.equal(calls.set.length, 0);
    assert.equal(calls.messages.length, 1);
    assert.equal(await api.writeCachedOrder(base, detail, options), false);
    assert.equal(calls.set.length, 0);
  }
});

test('cache enabled: closed orders are saved and reused on the next export', async () => {
  const { context, api, calls } = content();
  const base = { 'Номер заказа': '12345678-0001', 'Ссылка на заказ': orderUrl, 'Статус': 'Доставлен' };
  const detail = { orderDate: '2026-11-16', status: 'Доставлен', goodsTotal: '10',
    products: [{ product: 'Тестовый товар', price: '10', quantity: '1' }],
    returnCheck: { returnCheck: 'unavailable', cacheable: true } };
  context.chrome.runtime.sendMessage = async () => ({ ok: true, detail });
  const first = await api.enrichOrders([base], { useCache: true });
  assert.equal(first.cacheWrites, 1);
  context.chrome.runtime.sendMessage = async () => assert.fail('cached order should not be fetched');
  const second = await api.enrichOrders([base], { useCache: true });
  assert.equal(second.cacheHits, 1);
  assert.equal(second.cacheWrites, 0);
  assert.equal(calls.set.length, 1);
});

test('cache period restrictions remain enforced when saving is enabled', async () => {
  const { api, calls } = content();
  const base = { 'Номер заказа': '12345678-0001' };
  for (const orderDate of ['', '2025-12-31', '2027-01-01']) {
    assert.equal(await api.writeCachedOrder(base, { orderDate }, {
      useCache: true, dateFrom: '2026-01-01', dateTo: '2026-12-31',
    }), false);
  }
  assert.equal(calls.set.length, 0);
});

test('manifest and popup load the shared guard and retain only required permissions', () => {
  const manifest = JSON.parse(source('manifest.json'));
  assert.deepEqual(manifest.permissions, ['storage', 'downloads']);
  assert.deepEqual(manifest.host_permissions, ['https://ozon.ru/*', 'https://www.ozon.ru/*']);
  assert.deepEqual(manifest.content_scripts[0].matches, manifest.host_permissions);
  assert.equal(manifest.content_scripts[0].js[0], 'security.js');
  for (const file of manifest.content_scripts[0].js) assert.ok(fs.existsSync(path.join(root, file)));
  const popup = source('popup.html');
  assert.ok(popup.indexOf('src="security.js"') < popup.indexOf('src="popup.js"'));
  assert.doesNotMatch(popup.match(/<input id="useCache"[^>]*>/)[0], /checked/);
});
