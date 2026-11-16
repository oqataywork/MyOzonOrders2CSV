'use strict';
const $ = (id) => document.getElementById(id);
const CACHE_PREFIX = 'obo-order-cache-v4:';
const presets = { lastMonth: 'Последний месяц', week: 'Последние 7 дней', year: 'За год', all: 'Всё время', custom: 'Свои даты' };
let selectedPreset = 'lastMonth';
let mode = 'period';
let sourceTabId = null;
let connected = false;
let connecting = false;
let starting = false;
let state = { running: false, progress: { phase: 'idle' } };
let monitorTimer;
let settingsReady = false;
let cacheEntries = [];

$('version').textContent = `v${chrome.runtime.getManifest().version}`;
for (let year = new Date().getFullYear(); year >= 1998; year--) {
  const option = document.createElement('option');
  option.value = String(year); option.textContent = String(year);
  $('presetYear').appendChild(option);
}

function notify(text = '', error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}

function connection(title, hint, kind = '') {
  $('connectionTitle').textContent = title;
  $('connectionHint').textContent = hint;
  $('connectionDot').className = `dot ${kind}`;
}

function applyPreset() {
  if (selectedPreset !== 'custom') {
    const range = OzonUi.periodRange(selectedPreset, new Date(), $('presetYear').value);
    $('dateFrom').value = range.dateFrom; $('dateTo').value = range.dateTo;
  }
  renderSettings();
}

function renderSettings() {
  const single = mode === 'order';
  $('periodFields').hidden = single;
  $('orderFields').hidden = !single;
  $('periodMode').setAttribute('aria-pressed', String(!single));
  $('orderMode').setAttribute('aria-pressed', String(single));
  $('yearField').hidden = selectedPreset !== 'year';
  $('autoScroll').disabled = single;
  $('dateFrom').disabled = selectedPreset === 'all';
  $('dateTo').disabled = selectedPreset === 'all';
  $('periodBadge').textContent = presets[selectedPreset];
  for (const button of document.querySelectorAll('[data-preset]')) {
    button.setAttribute('aria-pressed', String(button.dataset.preset === selectedPreset));
  }
  $('rangeHint').textContent = selectedPreset === 'all'
    ? 'Вся история до сегодня. Большой архив может обрабатываться несколько минут.'
    : selectedPreset === 'lastMonth'
      ? 'От этой даты месяц назад до сегодня. Период обновляется автоматически.'
      : 'Обе даты включаются в выгрузку. Можно задать свой диапазон.';
  $('exportLabel').textContent = starting ? 'Подключаемся…' : state.running ? 'Выгрузка выполняется…' : 'Скачать CSV';
}

async function saveSettings() {
  await chrome.storage.local.set({
    periodPreset: selectedPreset, presetYear: Number($('presetYear').value),
    dateFrom: $('dateFrom').value, dateTo: $('dateTo').value,
    autoScroll: $('autoScroll').checked, includeReturned: $('includeReturned').checked,
    showTabs: $('showTabs').checked, useCache: $('useCache').checked,
  });
}

async function restoreSettings() {
  const saved = await chrome.storage.local.get(['periodPreset', 'presetYear', 'dateFrom', 'dateTo',
    'autoScroll', 'includeReturned', 'showTabs', 'useCache']);
  const period = OzonUi.initialPeriod(saved);
  selectedPreset = period.preset;
  $('dateFrom').value = period.dateFrom; $('dateTo').value = period.dateTo;
  if ([...$('presetYear').options].some((option) => option.value === String(saved.presetYear))) {
    $('presetYear').value = String(saved.presetYear);
  }
  for (const id of ['autoScroll', 'includeReturned', 'showTabs', 'useCache']) {
    if (typeof saved[id] === 'boolean') $(id).checked = saved[id];
  }
  settingsReady = true;
  render();
}

function render() {
  const progress = state.progress || { phase: 'idle' };
  const phase = progress.phase;
  const busy = starting || state.running;
  $('settings').disabled = busy || !settingsReady;
  $('exportButton').disabled = busy || !connected || !settingsReady;
  $('stopButton').hidden = !state.running || ['awaiting-choice', 'saving', 'stopping'].includes(phase);
  $('stopButton').disabled = !connected;
  $('partialActions').hidden = phase !== 'awaiting-choice';
  $('statusCard').dataset.state = phase;
  const titles = { idle: 'Всё готово к выгрузке', collecting: 'Собираем историю заказов',
    details: 'Проверяем состав и цены', saving: 'Сохраняем файл', completed: 'Выгрузка сохранена',
    stopping: 'Останавливаем выгрузку', 'awaiting-choice': 'Сохранить частичный результат?',
    stopped: 'Выгрузка остановлена', error: 'Не удалось завершить выгрузку', empty: 'Заказы не найдены' };
  $('statusTitle').textContent = connecting ? 'Подключаемся к Ozon' : (titles[phase] || 'Подготавливаем выгрузку');
  $('statusDetail').textContent = state.lastMessage || 'Выберите период и сохраните покупки в таблицу.';
  $('progress').hidden = !state.running || phase === 'awaiting-choice';
  if (progress.total > 0 && phase === 'details') {
    $('progress').max = progress.total; $('progress').value = progress.current;
  } else $('progress').removeAttribute('value');
  const seconds = progress.startedAt ? Math.max(0, Math.floor(((progress.finishedAt || Date.now()) - progress.startedAt) / 1000)) : 0;
  $('elapsed').textContent = progress.startedAt ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '';
  $('resultStats').hidden = !progress.summary;
  if (progress.summary) {
    $('ordersCount').textContent = progress.summary.orders;
    $('rowsCount').textContent = progress.summary.rows;
  }
  $('downloadCache').disabled = busy || !cacheEntries.length;
  $('clearCache').disabled = busy || !cacheEntries.length;
  renderSettings();
}

async function refreshStatus() {
  const tab = await chrome.tabs.get(sourceTabId);
  const url = OzonSecurity.ozonUrl(tab.url);
  if (!url || !/^\/my\/orderlist\/?$/.test(url.pathname) || url.searchParams.get('selectedTab') !== 'archive') {
    throw new Error('Вернитесь в архив заказов кнопкой ↗. Если Ozon просит войти — сначала войдите в аккаунт.');
  }
  const next = await chrome.tabs.sendMessage(sourceTabId, { type: 'OZON_EXPORT_STATUS' });
  if (typeof next?.running !== 'boolean') throw new Error('Страница заказов ещё не готова.');
  const wasRunning = state.running;
  state = next;
  connected = true;
  connection('Архив заказов открыт', 'Можно выгружать. Панель останется рядом.', 'ready');
  render();
  if (wasRunning && !state.running) await refreshCacheInfo().catch((error) => notify(`Не удалось обновить сведения о кэше: ${error.message}`, true));
  return next;
}

function startMonitoring() {
  clearTimeout(monitorTimer);
  monitorTimer = setTimeout(async () => {
    try { await refreshStatus(); }
    catch {
      connected = false;
      connection('Нет связи со страницей', 'Нажмите ↗, чтобы открыть архив и подключиться снова.', 'error');
      render();
    }
    if (connected) startMonitoring();
  }, 650);
}

async function connectToOrders() {
  if (connecting) return;
  connecting = true; connected = false;
  clearTimeout(monitorTimer);
  connection('Открываем архив заказов', 'Ищем открытую вкладку или создаём новую…');
  render();
  try {
    const currentWindow = await chrome.windows.getCurrent();
    const result = await chrome.runtime.sendMessage({ type: 'OZON_ENSURE_ORDERS_TAB', windowId: currentWindow.id });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось открыть архив заказов.');
    sourceTabId = result.tabId;
    let reloaded = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const tab = await chrome.tabs.get(sourceTabId);
      if (tab.status === 'complete') {
        try { await refreshStatus(); break; }
        catch (error) {
          const url = OzonSecurity.ozonUrl(tab.url);
          if (!url || !/^\/my\/orderlist\/?$/.test(url.pathname)) throw error;
          if (!reloaded && attempt >= 2) { await chrome.tabs.reload(sourceTabId); reloaded = true; }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (!connected) throw new Error('Ozon ещё загружается. Войдите в аккаунт, если нужно, и нажмите ↗ для повторного подключения.');
    notify();
    startMonitoring();
  } catch (error) {
    connected = false;
    connection('Нужно подключиться к Ozon', 'Нажмите ↗, чтобы попробовать снова.', 'error');
    notify(error.message, true);
  } finally { connecting = false; render(); }
}

async function refreshCacheInfo() {
  const stored = await chrome.storage.local.get(null);
  cacheEntries = Object.entries(stored).filter(([key, value]) => key.startsWith(CACHE_PREFIX) && value?.detail?.products?.length);
  const products = cacheEntries.reduce((total, [, item]) => total + item.detail.products.length, 0);
  $('cacheInfo').textContent = cacheEntries.length ? `В кэше: ${cacheEntries.length} заказов · ${products} товарных позиций` : 'Кэш пуст. История покупок не сохранена.';
  render();
}

async function exportOrders(event) {
  event.preventDefault();
  if (starting || state.running || !connected) return;
  notify();
  for (const id of ['dateFrom', 'dateTo', 'specificOrder']) $(id).removeAttribute('aria-invalid');
  try {
    if (mode === 'period') applyPreset();
    const single = mode === 'order' ? OzonUi.normalizeSpecificOrder($('specificOrder').value) : { orderNumber: '', orderUrl: '' };
    if (mode === 'order' && !single.orderNumber) {
      $('specificOrder').setAttribute('aria-invalid', 'true'); $('specificOrder').focus();
      throw new Error('Укажите номер заказа или вставьте ссылку на него.');
    }
    if (mode === 'period' && ((!OzonUi.validDate($('dateFrom').value) && selectedPreset !== 'all') ||
        !OzonUi.validDate($('dateTo').value) || $('dateFrom').value > $('dateTo').value)) {
      $('dateFrom').setAttribute('aria-invalid', 'true'); $('dateFrom').focus();
      throw new Error('Проверьте даты: начало периода должно быть не позже окончания.');
    }
    starting = true; render();
    await saveSettings();
    await refreshStatus();
    if (state.running) return;
    const response = await chrome.tabs.sendMessage(sourceTabId, {
      type: 'OZON_EXPORT_ORDERS', options: {
        dateFrom: single.orderNumber ? '' : $('dateFrom').value, dateTo: single.orderNumber ? '' : $('dateTo').value,
        autoScroll: !single.orderNumber && $('autoScroll').checked,
        specificOrder: single.orderNumber, specificOrderUrl: single.orderUrl,
        showTabs: $('showTabs').checked, includeReturned: $('includeReturned').checked, useCache: $('useCache').checked,
      },
    });
    if (!response?.ok) throw new Error(response?.error || 'Не удалось запустить выгрузку.');
    await refreshStatus();
    startMonitoring();
  } catch (error) { notify(error.message, true); }
  finally { starting = false; render(); }
}

$('exportForm').addEventListener('submit', exportOrders);
$('openOrders').addEventListener('click', async () => {
  if (state.running && sourceTabId && connected) await chrome.tabs.update(sourceTabId, { active: true }).catch(() => connectToOrders());
  else await connectToOrders();
});
for (const name of ['period', 'order']) $(name + 'Mode').addEventListener('click', () => {
  mode = name; notify(); renderSettings(); if (name === 'order') $('specificOrder').focus();
});
for (const button of document.querySelectorAll('[data-preset]')) button.addEventListener('click', () => {
  selectedPreset = button.dataset.preset; applyPreset(); notify(); saveSettings().catch((error) => notify(error.message, true));
});
$('presetYear').addEventListener('change', () => { applyPreset(); saveSettings().catch((error) => notify(error.message, true)); });
for (const id of ['dateFrom', 'dateTo']) $(id).addEventListener('change', () => {
  selectedPreset = 'custom'; renderSettings(); saveSettings().catch((error) => notify(error.message, true));
});
for (const id of ['autoScroll', 'includeReturned', 'showTabs', 'useCache']) $(id).addEventListener('change', () => saveSettings().catch((error) => notify(error.message, true)));
$('stopButton').addEventListener('click', async () => {
  $('stopButton').disabled = true;
  try { await chrome.tabs.sendMessage(sourceTabId, { type: 'OZON_STOP_EXPORT' }); await refreshStatus(); }
  catch (error) { notify(error.message, true); render(); }
});
for (const [id, download] of [['savePartial', true], ['discardPartial', false]]) $(id).addEventListener('click', async () => {
  $('savePartial').disabled = true; $('discardPartial').disabled = true;
  try {
    const response = await chrome.tabs.sendMessage(sourceTabId, { type: 'OZON_PARTIAL_EXPORT_DECISION', download });
    if (!response?.ok) throw new Error(response?.error || 'Не удалось завершить выгрузку.');
    await refreshStatus();
  } catch (error) { notify(error.message, true); }
  finally { $('savePartial').disabled = false; $('discardPartial').disabled = false; }
});
$('clearCache').addEventListener('click', async () => {
  if (!cacheEntries.length || !confirm(`Удалить ${cacheEntries.length} заказов из кэша? Скачанные файлы и настройки останутся.`)) return;
  try { await chrome.storage.local.remove(cacheEntries.map(([key]) => key)); await refreshCacheInfo(); notify('Кэш удалён.'); }
  catch (error) { notify(error.message, true); }
});
$('downloadCache').addEventListener('click', async () => {
  try {
    await refreshCacheInfo();
    if (!cacheEntries.length) return;
    const payload = { format: 'OzonMyOrders2csv order cache', cacheSchema: 4,
      extensionVersion: chrome.runtime.getManifest().version, exportedAt: new Date().toISOString(),
      orders: cacheEntries.map(([key, entry]) => ({ cacheKey: key, ...entry })) };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Не удалось подготовить файл.')); reader.readAsDataURL(blob);
    });
    const response = await chrome.runtime.sendMessage({ type: 'OZON_DOWNLOAD_DATA_URL', dataUrl,
      filename: `ozon_order_cache_${OzonUi.localIsoDate()}_v${chrome.runtime.getManifest().version}.json` });
    if (!response?.ok) throw new Error(response?.error || 'Не удалось сохранить файл.');
    notify('Копия кэша сохранена.');
  } catch (error) { notify(error.message, true); }
});
window.addEventListener('focus', () => { if (!state.running && settingsReady) applyPreset(); });
window.addEventListener('pagehide', () => clearTimeout(monitorTimer));
async function initialize() {
  try { await restoreSettings(); await refreshCacheInfo(); }
  catch (error) { settingsReady = true; applyPreset(); notify(`Не удалось прочитать настройки: ${error.message}`, true); }
  await connectToOrders();
}
initialize();
