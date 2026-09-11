// netlify/functions/steam-price.js
// Поддержка app (/app/ID) и package (/sub/ID).
// Регионы: ru → kz → ua. Конвертация в RUB по курсу ЦБ.

const REGION_TRY_ORDER = ['ru', 'kz', 'ua'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json; charset=utf-8',
};

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...CORS, ...extraHeaders },
    body: JSON.stringify(body),
  };
}

async function getAppPrice(appid, cc) {
  const res = await fetch(
    `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${cc}&filters=price_overview`,
    { headers: { Accept: 'application/json', 'User-Agent': 'ZibStore/1.0' } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const entry = data[appid];
  if (!entry?.success || !entry.data?.price_overview) return null;
  const po = entry.data.price_overview;
  return {
    steamType: 'app',
    steamId: Number(appid),
    name: entry.data.name || null,
    cc,
    currency: po.currency,
    final: po.final / 100,
    initial: po.initial / 100,
    discount_percent: po.discount_percent || 0,
    individual: null,
    steam_url: `https://store.steampowered.com/app/${appid}/`,
  };
}

async function getPackagePrice(packageid, cc) {
  const res = await fetch(
    `https://store.steampowered.com/api/packagedetails?packageids=${packageid}&cc=${cc}`,
    { headers: { Accept: 'application/json', 'User-Agent': 'ZibStore/1.0' } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const entry = data[packageid];
  if (!entry?.success || !entry.data?.price) return null;
  const po = entry.data.price;
  return {
    steamType: 'package',
    steamId: Number(packageid),
    name: entry.data.name || null,
    cc,
    currency: po.currency,
    final: po.final / 100,
    initial: po.initial / 100,
    discount_percent: po.discount_percent || 0,
    individual: po.individual ? po.individual / 100 : null,
    steam_url: `https://store.steampowered.com/sub/${packageid}/`,
  };
}

async function getCbrRate(currencyCode) {
  if (currencyCode === 'RUB') return { rate: 1, date: null, nominal: 1 };
  const res = await fetch('https://www.cbr-xml-daily.ru/daily_json.js', {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Курс ЦБ недоступен (${res.status})`);
  const data = await res.json();
  const valute = data.Valute && data.Valute[currencyCode];
  if (!valute) throw new Error(`ЦБ не публикует курс ${currencyCode}`);
  return {
    rate: valute.Value / valute.Nominal,
    date: data.Date || null,
    nominal: valute.Nominal,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...CORS,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  const q = event.queryStringParameters || {};
  const id = q.appid || q.id || q.packageid;
  const forcedType = (q.type || '').toLowerCase(); // app | package | auto

  if (!id || !/^\d+$/.test(id)) {
    return json(400, { available: false, error: 'id/appid обязателен и должен быть числом' });
  }

  try {
    let priceInfo = null;

    const tryOrder =
      forcedType === 'package'
        ? ['package']
        : forcedType === 'app'
          ? ['app']
          : ['app', 'package']; // auto: сначала app, потом package

    for (const kind of tryOrder) {
      for (const cc of REGION_TRY_ORDER) {
        priceInfo =
          kind === 'package' ? await getPackagePrice(id, cc) : await getAppPrice(id, cc);
        if (priceInfo) break;
      }
      if (priceInfo) break;
    }

    if (!priceInfo) {
      return json(200, {
        available: false,
        reason: 'no_price_in_tried_regions',
        steamId: Number(id),
      });
    }

    let finalRub = priceInfo.final;
    let initialRub = priceInfo.initial;
    let fx = null;

    if (priceInfo.currency !== 'RUB') {
      const cbr = await getCbrRate(priceInfo.currency);
      finalRub = priceInfo.final * cbr.rate;
      initialRub = priceInfo.initial * cbr.rate;
      fx = {
        source: 'cbr-xml-daily.ru',
        rate: cbr.rate,
        nominal: cbr.nominal,
        date: cbr.date,
        from: priceInfo.currency,
        to: 'RUB',
      };
    }

    return json(
      200,
      {
        available: true,
        steamType: priceInfo.steamType,
        steamId: priceInfo.steamId,
        name: priceInfo.name,
        cc: priceInfo.cc,
        currency: priceInfo.currency,
        final: priceInfo.final,
        initial: priceInfo.initial,
        final_rub: Math.round(finalRub * 100) / 100,
        initial_rub: Math.round(initialRub * 100) / 100,
        discount_percent: priceInfo.discount_percent,
        individual: priceInfo.individual,
        fx,
        steam_url: priceInfo.steam_url,
      },
      { 'Cache-Control': 'public, max-age=1800' }
    );
  } catch (err) {
    return json(200, {
      available: false,
      error: String(err && err.message ? err.message : err),
    });
  }
};
