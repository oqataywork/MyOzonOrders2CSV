// Real Chrome + real extension APIs, isolated profile, all page HTTP requests intercepted.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ozon-extension-smoke-'));
const child = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--remote-debugging-port=0', '--enable-unsafe-extension-debugging',
  '--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE localhost',
  '--proxy-server=http://127.0.0.1:9',
  `--user-data-dir=${profile}`,
], { windowsHide: true, stdio: 'ignore' });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pending = new Map(), sessions = new Map(), errors = [];
let ws, sequence = 0;
const archive = 'https://www.ozon.ru/my/orderlist?selectedTab=archive';
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function evaluate(sessionId, expression, userGesture = false) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture }, sessionId);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitFor(fn, label) {
  for (let attempt = 0; attempt < 100; attempt++) { const result = await fn(); if (result) return result; await delay(100); }
  throw new Error(`Timeout waiting for ${label}`);
}
async function attach(targetId) {
  const session = await waitFor(() => sessions.get(targetId), 'attached target');
  await session.ready;
  return session.id;
}
async function onAttached(message) {
  const { sessionId, targetInfo } = message.params;
  if (process.env.OZON_TEST_DEBUG) console.log('Attached', targetInfo.type, targetInfo.url);
  const ready = (async () => {
    await send('Runtime.enable', {}, sessionId);
    if (targetInfo.type !== 'service_worker') {
      await send('Fetch.enable', { patterns: [{ urlPattern: 'http*' }] }, sessionId);
      await send('Page.enable', {}, sessionId);
    }
    await send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  })();
  sessions.set(targetInfo.targetId, { id: sessionId, ready });
  ready.catch((error) => errors.push(error.message));
}
(async () => {
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    await waitFor(() => fs.existsSync(portFile), 'Chrome debugger');
    const [port, endpoint] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
    ws = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
    ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const entry = pending.get(message.id); if (!entry) return;
        pending.delete(message.id); clearTimeout(entry.timeout);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result);
      } else if (message.method === 'Target.attachedToTarget') onAttached(message);
      else if (message.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(message.params.exceptionDetails));
      else if (message.method === 'Fetch.requestPaused') {
        if (process.env.OZON_TEST_DEBUG) console.log('Intercepted', message.params.request.url);
        send('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
          body: Buffer.from('<!doctype html><html lang="ru"><body><h1>Синтетический архив заказов</h1><p>Тест без аккаунта и сетевых запросов к Ozon.</p></body></html>').toString('base64'),
        }, message.sessionId).catch((error) => errors.push(error.message));
      }
    });
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      filter: [{ type: 'page' }, { type: 'service_worker' }, { type: 'other' }, { exclude: true }] });
    const browser = await send('Browser.getVersion');
    const extension = await send('Extensions.loadUnpacked', { path: path.resolve(__dirname, '../dist/OzonMyOrders2csv') });
    const panelTarget = await send('Target.createTarget', { url: `chrome-extension://${extension.id}/popup.html` });
    const panel = await attach(panelTarget.targetId);
    await send('Emulation.setDeviceMetricsOverride', { width: 380, height: 900, deviceScaleFactor: 1, mobile: false }, panel);
    await waitFor(() => evaluate(panel, `typeof connected !== 'undefined' && connected && settingsReady`), 'panel connected');
    const initial = await evaluate(panel, `(async () => ({
      dateFrom: $('dateFrom').value, dateTo: $('dateTo').value, expected: OzonUi.periodRange('lastMonth'),
      cache: $('useCache').checked, enabled: !$('exportButton').disabled,
      permissions: chrome.runtime.getManifest().permissions,
      archives: (await chrome.tabs.query({url:'https://www.ozon.ru/*'})).map(t=>t.url),
      sourceTabId, version: chrome.runtime.getManifest().version,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }))()`);
    assert.equal(initial.dateFrom, initial.expected.dateFrom); assert.equal(initial.dateTo, initial.expected.dateTo);
    assert.equal(initial.cache, false); assert.equal(initial.enabled, true); assert.equal(initial.overflow, false);
    assert.deepEqual(initial.permissions, ['storage', 'downloads', 'sidePanel']);
    assert.equal(initial.archives.length, 1);
    const openedArchive = new URL(initial.archives[0]);
    assert.equal(openedArchive.origin + openedArchive.pathname, 'https://www.ozon.ru/my/orderlist');
    assert.equal(openedArchive.searchParams.get('selectedTab'), 'archive');
    for (const width of [320, 600, 380]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, panel);
      assert.equal(await evaluate(panel, `document.documentElement.scrollWidth > innerWidth`), false, `layout at ${width}px`);
    }
    if (process.env.OZON_CAPTURE_UI) {
      await send('Page.bringToFront', {}, panel);
      const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, panel);
      fs.writeFileSync(path.resolve(__dirname, '../dist/ui-preview.png'), Buffer.from(screenshot.data, 'base64'));
    }

    await evaluate(panel, `$('openOrders').click()`);
    await waitFor(() => evaluate(panel, `!connecting && connected`), 'reconnect');
    assert.equal(await evaluate(panel, `(async()=> (await chrome.tabs.query({url:'https://www.ozon.ru/*'})).length)()`), 1);

    await evaluate(panel, `document.querySelector('[data-preset="week"]').click()`);
    assert.equal(await evaluate(panel, `$('dateFrom').value === OzonUi.periodRange('week').dateFrom`), true);
    await evaluate(panel, `$('dateFrom').value='2026-01-01'; $('dateTo').value='2026-02-01'; $('dateFrom').dispatchEvent(new Event('change'))`);
    await waitFor(() => evaluate(panel, `(async()=> (await chrome.storage.local.get('periodPreset')).periodPreset === 'custom')()`), 'saved custom dates');
    await send('Page.reload', {}, panel);
    await waitFor(() => evaluate(panel, `typeof connected !== 'undefined' && connected`), 'panel reopened');
    assert.equal(await evaluate(panel, `$('dateFrom').value`), '2026-01-01');

    await evaluate(panel, `$('dateFrom').value='2026-12-31'; $('dateTo').value='2026-01-01'; $('exportButton').click()`);
    assert.equal(await evaluate(panel, `$('message').classList.contains('error') && $('dateFrom').getAttribute('aria-invalid') === 'true'`), true);
    await evaluate(panel, `$('orderMode').click(); $('specificOrder').value='https://example.invalid/my/orderdetails/?order=123456'; $('exportButton').click()`);
    assert.match(await evaluate(panel, `$('message').textContent`), /HTTPS/);

    // A different active Ozon tab must not steal progress or stop commands.
    const other = await send('Target.createTarget', { url: 'https://www.ozon.ru/product/synthetic-123456/' });
    await attach(other.targetId);
    await delay(800);
    assert.equal(await evaluate(panel, `connected && sourceTabId === ${initial.sourceTabId}`), true);
    await evaluate(panel, `$('periodMode').click(); document.querySelector('[data-preset="lastMonth"]').click(); $('autoScroll').checked=false; $('exportButton').click()`);
    await waitFor(() => evaluate(panel, `state.progress?.phase === 'empty' && !state.running`), 'empty export state');
    assert.equal(await evaluate(panel, `!$('exportButton').disabled && $('stopButton').hidden`), true);

    // Start scrolling the empty fixture and stop it; decide from the panel itself.
    await evaluate(panel, `$('autoScroll').checked=true; $('exportButton').click()`);
    await waitFor(() => evaluate(panel, `state.running && !$('stopButton').hidden`), 'running state');
    await evaluate(panel, `$('stopButton').click()`);
    await waitFor(() => evaluate(panel, `!$('partialActions').hidden`), 'partial-result controls');
    await evaluate(panel, `$('discardPartial').click()`);
    await waitFor(() => evaluate(panel, `!state.running && state.progress.phase === 'stopped'`), 'stopped state');

    // Chrome's actual toolbar action should open the native side panel.
    const protocol = await (await fetch(`http://127.0.0.1:${port}/json/protocol`)).json();
    const action = protocol.domains.find(d => d.domain === 'Extensions').commands.find(c => c.name === 'triggerAction');
    if (action) {
      const tabTargets = (await send('Target.getTargets', { filter: [{ type: 'tab' }, { exclude: true }] })).targetInfos;
      const tabTarget = tabTargets.find(target => target.url === 'https://www.ozon.ru/product/synthetic-123456/');
      assert.ok(tabTarget, 'Chrome tab target for toolbar action');
      await send('Extensions.triggerAction', { id: extension.id, targetId: tabTarget.targetId });
      await waitFor(async () => (await send('Target.getTargets')).targetInfos.filter(t => t.url === `chrome-extension://${extension.id}/popup.html`).length >= 2, 'native side panel');
    } else throw new Error('This Chrome does not support Extensions.triggerAction for the native panel check');

    const rejected = await evaluate(panel, `(async()=>await chrome.runtime.sendMessage({type:'OZON_PARSE_DETAIL_IN_TAB',url:'https://example.invalid/my/orderdetails/?order=123456'}))()`);
    assert.equal(rejected.ok, false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: browser.product, ...initial,
      checks: ['automatic archive opening', 'no duplicate tabs', 'rolling dates', 'custom dates retained',
        'validation', 'source tab binding', 'empty result', 'stop and discard from panel', 'native side panel', 'external URL blocked'],
      runtimeExceptions: errors.length,
    }, null, 2));
  } finally {
    if (ws?.readyState === WebSocket.OPEN) { await send('Browser.close').catch(() => {}); ws.close(); }
    child.kill();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
