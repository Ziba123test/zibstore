const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = 3000;
const HOST = '127.0.0.1';
const MATCHES_FILE = '/var/www/zibstore/data/steam-matches.json';
const REGION_ORDER = ['ru', 'kz', 'ua', 'us'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=60'
};

function readMatches() {
  try {
    return JSON.parse(fs.readFileSync(MATCHES_FILE, 'utf8'));
  } catch (err) {
    console.error('Failed to read matches:', err.message);
    return {};
  }
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'ZibStore/1.0'
    }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getAppPrice(appid, cc) {
  const data = await fetchJson(
    `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${cc}&filters=basic,price_overview`
  );
  const entry = data?.[appid];
  if (!entry?.success || !entry.data?.price_overview) return null;

  const d = entry.data;
  const p = d.price_overview;
  return {
    steamType: 'app',
    steamId: Number(appid),
    cc,
    currency: p.currency,
    final: p.final / 100,
    initial: p.initial / 100,
    discount_percent: p.discount_percent || 0,
    steam_url: `https://store.steampowered.com/app/${appid}/`,
    header_image: d.header_image || null,
    capsule_image: d.capsule_image || null,
    capsule_imagev5: d.capsule_imagev5 || null
  };
}

async function getPackagePrice(packageid, cc) {
  const data = await fetchJson(
    `https://store.steampowered.com/api/packagedetails?packageids=${packageid}&cc=${cc}`
  );
  const entry = data?.[packageid];
  if (!entry?.success || !entry.data?.price) return null;

  const p = entry.data.price;
  return {
    steamType: 'package',
    steamId: Number(packageid),
    cc,
    currency: p.currency,
    final: p.final / 100,
    initial: p.initial / 100,
    discount_percent: p.discount_percent || 0,
    steam_url: `https://store.steampowered.com/sub/${packageid}/`
  };
}

async function getCbrRate(currency) {
  if (currency === 'RUB') return { rate: 1, date: null };

  const data = await fetchJson('https://www.cbr-xml-daily.ru/daily_json.js');
  const value = data?.Valute?.[currency];
  if (!value) throw new Error(`ЦБ РФ не публикует курс ${currency}`);

  return { rate: value.Value / value.Nominal, date: data.Date };
}

async function withRub(info) {
  const cbr = await getCbrRate(info.currency);
  return {
    ...info,
    final_rub: Math.round(info.final * cbr.rate * 100) / 100,
    initial_rub: Math.round(info.initial * cbr.rate * 100) / 100,
    fx: {
      source: 'cbr-xml-daily.ru',
      rate: cbr.rate,
      date: cbr.date,
      from: info.currency,
      to: 'RUB'
    }
  };
}

async function findPrice(type, id, requestedCc = 'ru') {
  const order = [requestedCc, ...REGION_ORDER.filter(r => r !== requestedCc)];
  // Some matcher entries were historically saved as package while the Steam ID
  // is actually an AppID (for example R.E.P.O., Dawnwalker, Slay the Spire 2).
  // Keep the user's preferred type first, but safely try the alternate endpoint
  // if the preferred lookup returns no price.
  const types = type === 'package' ? ['package', 'app'] : ['app', 'package'];

  for (const cc of order) {
    for (const lookupType of types) {
      try {
        const info = lookupType === 'package'
          ? await getPackagePrice(id, cc)
          : await getAppPrice(id, cc);
        if (info) {
          return await withRub(info);
        }
      } catch (_) {}
    }
  }
  return null;
}

function json(res, status, body) {
  res.writeHead(status, CORS);
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'zibstore-api' });
  }

  if (url.pathname === '/api/steam-matches') {
    return json(res, 200, {
      version: 1,
      matches: readMatches()
    });
  }

  if (url.pathname !== '/api/steam-price') {
    return json(res, 404, { error: 'Not found' });
  }

  const appid = url.searchParams.get('appid');
  const packageid = url.searchParams.get('packageid');
  const cc = (url.searchParams.get('cc') || 'ru').toLowerCase();

  let type;
  let id;

  if (appid && /^\d+$/.test(appid)) {
    type = 'app';
    id = appid;
  } else if (packageid && /^\d+$/.test(packageid)) {
    type = 'package';
    id = packageid;
  } else {
    return json(res, 400, {
      available: false,
      error: 'Нужен appid или packageid'
    });
  }

  try {
    const info = await findPrice(type, id, cc);
    if (!info) {
      return json(res, 200, {
        available: false,
        steamType: type,
        steamId: Number(id),
        reason: 'no_price_in_supported_regions'
      });
    }
    return json(res, 200, { available: true, ...info });
  } catch (err) {
    return json(res, 200, { available: false, error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ZibStore API listening on http://${HOST}:${PORT}`);
});
