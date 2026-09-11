// ZibStore Steam price proxy.
// Supports Steam AppID (appdetails) and Steam Package/SubID (packagedetails),
// with regional fallback and RUB conversion via CBR.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};

const REGIONS = ['kz', 'ua', 'us'];
const ALLOWED_CC = new Set(['ru', 'kz', 'ua', 'us', 'eu', 'tr']);
const APP_API = 'https://store.steampowered.com/api/appdetails';
const PACKAGE_API = 'https://store.steampowered.com/api/packagedetails/';
const CBR_API = 'https://www.cbr-xml-daily.ru/daily_json.js';

const reply = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, ...extra }
});

const isId = v => Boolean(v && /^\d+$/.test(v));

const normalizeCc = value => {
  const cc = String(value || '').toLowerCase();
  return ALLOWED_CC.has(cc) ? cc : null;
};

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'ZibStore/1.0 price-comparison'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getApp(appid, cc) {
  const u = new URL(APP_API);
  u.searchParams.set('appids', appid);
  u.searchParams.set('cc', cc);
  u.searchParams.set('filters', 'price_overview');
  const data = await fetchJson(u);
  const entry = data?.[appid];
  const p = entry?.data?.price_overview;
  if (!entry?.success || !p || typeof p.final !== 'number') return null;
  return {
    steamType: 'app',
    steamId: Number(appid),
    name: entry.data.name || null,
    currency: String(p.currency || '').toUpperCase(),
    final: p.final / 100,
    initial: typeof p.initial === 'number' ? p.initial / 100 : null,
    discount_percent: Number(p.discount_percent || 0),
    cc,
    steam_url: `https://store.steampowered.com/app/${appid}/`
  };
}

async function getPackage(packageid, cc) {
  const u = new URL(PACKAGE_API);
  u.searchParams.set('packageids', packageid);
  u.searchParams.set('cc', cc);
  u.searchParams.set('l', 'russian');
  const data = await fetchJson(u);
  const entry = data?.[packageid];
  const p = entry?.data?.price;
  if (!entry?.success || !p || typeof p.final !== 'number') return null;
  return {
    steamType: 'package',
    steamId: Number(packageid),
    name: entry.data.name || null,
    currency: String(p.currency || '').toUpperCase(),
    final: p.final / 100,
    initial: typeof p.initial === 'number' ? p.initial / 100 : null,
    discount_percent: Number(p.discount_percent || 0),
    individual: typeof p.individual === 'number' ? p.individual / 100 : null,
    cc,
    steam_url: `https://store.steampowered.com/sub/${packageid}/`
  };
}

let cbrCache = { data: null, expiresAt: 0 };

async function fetchWithRetry(url, options = {}, attempts = 3) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 350 * (i + 1)));
    }
  }
  throw lastError || new Error('fetch failed');
}

async function getCbrJson() {
  const now = Date.now();
  if (cbrCache.data && now < cbrCache.expiresAt) return cbrCache.data;

  const headers = {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': 'ZibStore/1.0 price-comparison'
  };

  const res = await fetchWithRetry(CBR_API, { headers });
  const data = await res.json();
  if (!data?.Valute) throw new Error('Некорректный ответ ЦБ');

  cbrCache = { data, expiresAt: now + 10 * 60 * 1000 };
  return data;
}

async function getCbrRate(currency) {
  if (currency === 'RUB') return { rate: 1, date: null, nominal: 1 };
  const data = await getCbrJson();
  const v = data?.Valute?.[currency];
  if (!v || typeof v.Value !== 'number' || typeof v.Nominal !== 'number') {
    throw new Error(`ЦБ РФ не публикует курс ${currency}`);
  }
  return {
    rate: v.Value / v.Nominal,
    date: data.Date || data.Timestamp || null,
    nominal: v.Nominal
  };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const u = new URL(req.url);
  const appid = u.searchParams.get('appid');
  const packageid = u.searchParams.get('packageid') || u.searchParams.get('subid');
  const requestedCc = normalizeCc(u.searchParams.get('cc'));

  let type;
  let id;
  if (isId(packageid)) {
    type = 'package';
    id = packageid;
  } else if (isId(appid)) {
    type = 'app';
    id = appid;
  } else {
    return reply({ available: false, error: 'Укажите appid или packageid (только числа)' }, 400);
  }

  const regions = [];
  if (requestedCc && requestedCc !== 'ru') regions.push(requestedCc);
  for (const cc of REGIONS) if (!regions.includes(cc)) regions.push(cc);

  let info = null;
  const errors = [];
  for (const cc of regions) {
    try {
      info = type === 'package' ? await getPackage(id, cc) : await getApp(id, cc);
      if (info) break;
    } catch (err) {
      errors.push(`${cc}: ${err?.message || err}`);
    }
  }

  if (!info) {
    return reply({ available: false, steamType: type, steamId: Number(id), reason: 'no_price_in_tried_regions', errors }, 200, {
      'Cache-Control': 'public, max-age=300'
    });
  }

  let finalRub = info.final;
  let initialRub = info.initial;
  let fx = { source: 'none', rate: 1, nominal: 1, date: null, from: info.currency, to: 'RUB' };

  try {
    if (info.currency !== 'RUB') {
      const cbr = await getCbrRate(info.currency);
      finalRub = info.final * cbr.rate;
      initialRub = info.initial == null ? null : info.initial * cbr.rate;
      fx = {
        source: 'cbr-xml-daily.ru',
        rate: cbr.rate,
        nominal: cbr.nominal,
        date: cbr.date,
        from: info.currency,
        to: 'RUB'
      };
    }
  } catch (err) {
    return reply({
      available: false,
      steamType: info.steamType,
      steamId: info.steamId,
      cc: info.cc,
      currency: info.currency,
      final: info.final,
      error: `Не удалось перевести цену в RUB: ${err?.message || err}`
    }, 200, { 'Cache-Control': 'public, max-age=300' });
  }

  return reply({
    available: true,
    steamType: info.steamType,
    steamId: info.steamId,
    name: info.name,
    cc: info.cc,
    currency: info.currency,
    final: info.final,
    initial: info.initial,
    final_rub: finalRub,
    initial_rub: initialRub,
    discount_percent: info.discount_percent,
    individual: info.individual ?? null,
    fx,
    steam_url: info.steam_url
  }, 200, { 'Cache-Control': 'public, max-age=1800' });
};
