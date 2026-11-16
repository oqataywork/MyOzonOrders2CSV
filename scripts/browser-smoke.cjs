const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ozon-extension-smoke-'));
const child = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update',
  '--remote-debugging-port=0', '--enable-unsafe-extension-debugging',
  `--user-data-dir=${profile}`,
], { windowsHide: true, stdio: 'ignore' });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
const pending = new Map();
let sequence = 0;
const events = [];
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function evaluate(sessionId, expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
}
(async () => {
  try {
    let activePort;
    for (let n = 0; n < 100; n++) {
      if (fs.existsSync(path.join(profile, 'DevToolsActivePort'))) {
        activePort = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n'); break;
      }
      await delay(100);
    }
    assert.ok(activePort, 'Chrome debug port available');
    ws = new WebSocket(`ws://127.0.0.1:${activePort[0]}${activePort[1]}`);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
    ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const entry = pending.get(message.id); if (!entry) return;
        pending.delete(message.id); clearTimeout(entry.timeout);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result);
      } else {
        events.push(message);
        if (message.method === 'Fetch.requestPaused') {
          send('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
            body: Buffer.from('<!doctype html><html><body><h1>Synthetic Ozon fixture</h1></body></html>').toString('base64'),
          }, message.sessionId).catch(() => {});
        }
      }
    });
    const version = await send('Browser.getVersion');
    const extension = await send('Extensions.loadUnpacked', {
      path: path.resolve(__dirname, '../dist/OzonMyOrders2csv'),
    });
    const target = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: fixture } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, fixture);
    await send('Runtime.enable', {}, fixture);
    await send('Page.navigate', { url: 'https://www.ozon.ru/my/orderlist/' }, fixture);
    await delay(500);
    const popup = await send('Target.createTarget', { url: `chrome-extension://${extension.id}/popup.html` });
    const { sessionId } = await send('Target.attachToTarget', { targetId: popup.targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    await delay(300);
    const result = await evaluate(sessionId, `(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.ozon.ru/*' });
      const status = await chrome.tabs.sendMessage(tabs[0].id, { type: 'OZON_EXPORT_STATUS' });
      const rejected = await chrome.runtime.sendMessage({ type: 'OZON_PARSE_DETAIL_IN_TAB', url: 'https://example.invalid/my/orderdetails/?order=12345678' });
      let invalidInputRejected = false;
      try { normalizeSpecificOrder('http://ozon.ru/my/orderdetails/?order=12345678'); } catch { invalidInputRejected = true; }
      return {
        version: chrome.runtime.getManifest().version,
        permissions: chrome.runtime.getManifest().permissions,
        guardLoaded: typeof OzonSecurity.orderUrl === 'function',
        cacheDefault: document.querySelector('#useCache').checked,
        orderTabUrl: tabs[0].url,
        contentScriptResponded: status.running === false,
        backgroundRejected: rejected.ok === false && rejected.error.includes('Заблокирована'),
        validInput: normalizeSpecificOrder('12345678-0001').orderNumber,
        invalidInputRejected,
        dimensions: { width: document.body.scrollWidth, height: document.body.scrollHeight },
      };
    })()`);
    assert.equal(result.guardLoaded, true);
    assert.equal(result.cacheDefault, false);
    assert.equal(result.contentScriptResponded, true);
    assert.equal(result.backgroundRejected, true);
    assert.equal(result.validInput, '12345678-0001');
    assert.equal(result.invalidInputRejected, true);
    assert.deepEqual(result.permissions, ['storage', 'downloads']);
    const exceptions = events.filter((event) => event.method === 'Runtime.exceptionThrown');
    assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
    console.log(JSON.stringify({ browser: version.product, ...result, runtimeExceptions: exceptions.length }, null, 2));
  } finally {
    if (ws?.readyState === WebSocket.OPEN) {
      await send('Browser.close').catch(() => {});
      ws.close();
    }
    child.kill();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
