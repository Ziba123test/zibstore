const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8'
};

const DEFAULT_REGIONS = ['kz', 'ua', 'us'];
const FX_CACHE = new Map();
const FX_TTL = 10 * 60 * 1000;

const json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, ...extraHeaders }
});

function normalizeTerm(term) {
  return String(term || '')
    .replace(/[✅⭐🔥⚡🎁💎]/g, ' ')
    .replace(/\b(STEAM|GIFT|KEY|КЛЮЧ|GLOBAL|СНГ|РФ|RU|KZ|UA|BY)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

async function searchSteam(term, cc = 'kz') {
  const q = normalizeTerm(term);
  if (q.length < 2) return [];
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&l=russian&cc=${encodeURIComponent(cc)}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Steam search HTTP ${res.status}`);
  const data = await res.json();
  return (data.items || []).slice(0, 10).map(item => ({
    id: item.id,
    type: item.type || 'app',
    name: item.name,
    imageUrl: item.tiny_image || `https://steamcdn-a.akamaihd.net/steam/apps/${item.id}/header.jpg`,
    price: item.price || null,
    score: scoreCandidate(q, item.name)
  }));
}

function scoreCandidate(query, name) {
  const q = query.toLowerCase().replace(/[^a-zа-я0-9]+/gi, ' ').trim();
  const n = String(name || '').toLowerCase().replace(/[^a-zа-я0-9]+/gi, ' ').trim();
  if (!q || !n) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 90;
  if (n.includes(q)) return 75;
  const tokens = q.split(/\s+/).filter(Boolean);
  const hits = tokens.filter(t => n.includes(t)).length;
  return Math.round((hits / Math.max(tokens.length, 1)) * 60);
}

async function getAppPrice(appid, cc) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${cc}&filters=price_overview`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json();
  const entry = data[appid];
  const po = entry?.success ? entry?.data?.price_overview : null;
  if (!po) return null;
  return { cc, currency: po.currency, final: po.final / 100, initial: po.initial / 100, discount_percent: po.discount_percent };
}

async function getPackagePrice(subid, cc) {
  const url = `https://store.steampowered.com/api/packagedetails/?packageids=${subid}&cc=${cc}&l=russian`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json();
  const entry = data[subid];
  const price = entry?.success ? entry?.data?.price : null;
  if (!price || typeof price.final !== 'number' || !price.currency) return null;
  return { cc, currency: price.currency, final: price.final / 100, initial: price.initial / 100, discount_percent: price.discount_percent || 0 };
}

async function fetchFx(currency) {
  if (currency === 'RUB') return { rate: 1, nominal: 1, date: null, source: 'RUB' };
  const cached = FX_CACHE.get(currency);
  if (cached && cached.expires > Date.now()) return cached.value;
  const res = await fetch('https://www.cbr.ru/scripts/XML_daily.asp', { headers: { 'Accept': 'application/xml,text/xml;q=0.9,*/*;q=0.8' } });
  if (!res.ok) throw new Error(`ЦБ HTTP ${res.status}`);
  const xml = await res.text();
  const re = new RegExp(`<CharCode>${currency}</CharCode>[\\s\\S]*?<Nominal>(\\d+)</Nominal>[\\s\\S]*?<Value>([^<]+)</Value>[\\s\\S]*?</Valute>`);
  const m = xml.match(re);
  if (!m) throw new Error(`Курс ${currency} не найден в ЦБ`);
  const nominal = Number(m[1]);
  const rate = Number(m[2].replace(',', '.')) / nominal;
  const value = { rate, nominal, date: new Date().toISOString(), source: 'cbr.ru/XML_daily.asp' };
  FX_CACHE.set(currency, { value, expires: Date.now() + FX_TTL });
  return value;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  if (action === 'search') {
    const term = url.searchParams.get('term') || '';
    const cc = (url.searchParams.get('cc') || 'kz').toLowerCase();
    try {
      let items = await searchSteam(term, cc);
      items.sort((a, b) => b.score - a.score);
      return json({ ok: true, term: normalizeTerm(term), cc, items: items.map(({ score, ...item }) => ({ ...item, score })) });
    } catch (err) {
      return json({ ok: false, error: String(err) }, 200);
    }
  }

  const type = (url.searchParams.get('type') || '').toLowerCase();
  const appid = url.searchParams.get('appid');
  const packageid = url.searchParams.get('packageid');
  const requestedCc = (url.searchParams.get('cc') || 'kz').toLowerCase();
  const regions = [...new Set([requestedCc, ...DEFAULT_REGIONS])].filter(Boolean);

  if (type && !['app', 'package'].includes(type)) return json({ available: false, error: 'type must be app or package' }, 400);
  if (!appid && !packageid) return json({ available: false, error: 'appid or packageid required' }, 400);

  try {
    const steamType = packageid || type === 'package' ? 'package' : 'app';
    const steamId = String(packageid || appid);
    let priceInfo = null;
    const triedRegions = [];

    for (const cc of regions) {
      triedRegions.push(cc);
      priceInfo = steamType === 'package' ? await getPackagePrice(steamId, cc) : await getAppPrice(steamId, cc);
      if (priceInfo) break;
    }

    if (!priceInfo) return json({ available: false, steamType, steamId, requestedCc, triedRegions, reason: 'no_price_in_tried_regions' });

    let finalRub = priceInfo.final;
    let fx = null;
    if (priceInfo.currency !== 'RUB') {
      fx = await fetchFx(priceInfo.currency);
      finalRub = priceInfo.final * fx.rate;
    }

    return json({
      available: true,
      steamType,
      steamId,
      requestedCc,
      cc: priceInfo.cc,
      currency: priceInfo.currency,
      final: priceInfo.final,
      initial: priceInfo.initial,
      final_rub: Math.round(finalRub * 100) / 100,
      initial_rub: Math.round((priceInfo.initial * (fx?.rate || 1)) * 100) / 100,
      discount_percent: priceInfo.discount_percent || 0,
      triedRegions,
      fx,
      steam_url: steamType === 'package'
        ? `https://store.steampowered.com/sub/${steamId}/`
        : `https://store.steampowered.com/app/${steamId}/`
    }, 200, { 'Cache-Control': 'public, max-age=900' });
  } catch (err) {
    return json({ available: false, error: String(err) }, 200);
  }
};
