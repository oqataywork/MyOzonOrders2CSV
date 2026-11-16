(() => {
  'use strict';
  function localIsoDate(date = new Date()) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')].join('-');
  }

  function periodRange(preset = 'lastMonth', now = new Date(), year = now.getFullYear()) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
    let from = new Date(today), to = new Date(today);
    if (preset === 'lastMonth') {
      const lastDay = new Date(today.getFullYear(), today.getMonth(), 0).getDate();
      from = new Date(today.getFullYear(), today.getMonth() - 1, Math.min(today.getDate(), lastDay), 12);
    } else if (preset === 'week') {
      from.setDate(from.getDate() - 6);
    } else if (preset === 'year') {
      year = Math.min(today.getFullYear(), Math.max(1998, Number(year) || today.getFullYear()));
      from = new Date(year, 0, 1, 12);
      to = year === today.getFullYear() ? today : new Date(year, 11, 31, 12);
    } else if (preset === 'all') {
      return { dateFrom: '', dateTo: localIsoDate(today) };
    }
    return { dateFrom: localIsoDate(from), dateTo: localIsoDate(to) };
  }

  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
    const [y, m, d] = value.split('-').map(Number);
    return localIsoDate(new Date(y, m - 1, d, 12)) === value;
  }

  function initialPeriod(saved = {}, now = new Date()) {
    const preset = ['lastMonth', 'week', 'year', 'all', 'custom'].includes(saved.periodPreset)
      ? saved.periodPreset : 'lastMonth';
    if (preset === 'custom' && validDate(saved.dateFrom) && validDate(saved.dateTo) && saved.dateFrom <= saved.dateTo) {
      return { preset, dateFrom: saved.dateFrom, dateTo: saved.dateTo };
    }
    const selected = preset === 'custom' ? 'lastMonth' : preset;
    return { preset: selected, ...periodRange(selected, now, saved.presetYear) };
  }

  function normalizeSpecificOrder(value) {
    const raw = String(value || '').trim();
    if (!raw) return { orderNumber: '', orderUrl: '' };
    let number = raw;
    if (!/^\d[\d-]{5,}$/.test(raw)) {
      const url = OzonSecurity.orderUrl(raw);
      number = url && (url.searchParams.get('order') || url.searchParams.get('orderNumber') ||
        url.searchParams.get('orderId') || url.pathname.match(/\/orderdetails\/(\d[\d-]{5,})/i)?.[1]);
    }
    if (!/^\d[\d-]{5,}$/.test(number || '')) throw new Error('Введите номер заказа или HTTPS-ссылку на заказ Ozon.');
    return { orderNumber: number, orderUrl: `https://www.ozon.ru/my/orderdetails/?order=${encodeURIComponent(number)}` };
  }

  globalThis.OzonUi = Object.freeze({ localIsoDate, periodRange, validDate, initialPeriod, normalizeSpecificOrder });
})();
