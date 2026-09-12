const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { URL } = require('url');

const PORT = 3000;
const HOST = '127.0.0.1';
const MATCHES_FILE = '/var/www/zibstore/data/steam-matches.json';
const REGION_ORDER = ['ru', 'kz', 'ua', 'us'];
const COVER_DIR = '/var/www/zibstore/api/covers';
fs.mkdirSync(COVER_DIR, { recursive: true });

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

async function fetchText(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
        'Cookie': 'birthtime=0; lastagecheckage=1-January-1970; mature_content=1'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtmlAttr(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractSteamPageImages(html) {
  const urls = [];
  const metaTags = String(html || '').match(/<meta\b[^>]*>/gi) || [];

  for (const tag of metaTags) {
    const prop =
      tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    if (!/^(?:og:image|twitter:image(?::src)?)$/i.test(prop)) continue;

    const content = tag.match(/content\s*=\s*["']([^"']+)["']/i)?.[1];
    if (content) urls.push(decodeHtmlAttr(content));
  }

  // Steam pages also often contain canonical CDN URLs outside meta tags.
  const cdnMatches = String(html || '').match(
    /https:\/\/[^"'\s<>]+steamstatic\.com\/[^"'\s<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\s<>]*)?/gi
  ) || [];

  urls.push(...cdnMatches.map(decodeHtmlAttr));
  return [...new Set(urls)];
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


async function fetchBuffer(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; ZibStore/1.0)'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = String(res.headers.get('content-type') || '');
    if (!type.startsWith('image/')) throw new Error(`Not an image: ${type || 'unknown'}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFirstImage(urls) {
  const tried = [];
  for (const raw of urls) {
    const url = String(raw || '').trim();
    if (!url || tried.includes(url)) continue;
    tried.push(url);
    try {
      return { buffer: await fetchBuffer(url), source: url };
    } catch (_) {}
  }
  return null;
}

async function resolvePackageAppId(packageId) {
  try {
    const data = await fetchJson(
      `https://store.steampowered.com/api/packagedetails?packageids=${packageId}&cc=ru&l=english`
    );
    const entry = data?.[String(packageId)];
    const apps = entry?.success && Array.isArray(entry?.data?.apps) ? entry.data.apps : [];
    const app = apps.find(x => /^\d+$/.test(String(x?.id ?? x?.appid ?? '')));
    return app ? String(app.id ?? app.appid) : null;
  } catch (_) {
    return null;
  }
}

async function getAppArtwork(appId) {
  let exact = {};
  try {
    // First ask Steam API for canonical hashed artwork URLs.
    const data = await fetchJson(
      `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=ru&l=english`
    );
    exact = data?.[String(appId)]?.success ? (data[String(appId)].data || {}) : {};
  } catch (_) {}

  const exactUrls = [
    exact.header_image,
    exact.capsule_image,
    exact.capsule_imagev5,
    exact.background_raw,
    exact.background
  ];

  const guessedPortrait = [
    `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`,
    `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`
  ];

  const guessedLandscape = [
    `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`,
    `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appId}/capsule_616x353.jpg`
  ];

  // 1) Best case: a real portrait exists.
  let found = await fetchFirstImage(guessedPortrait);
  if (found) return found;

  // 2) Canonical hashed URLs from appdetails.
  found = await fetchFirstImage(exactUrls);
  if (found) return found;

  // 3) Common predictable Steam CDN paths.
  found = await fetchFirstImage(guessedLandscape);
  if (found) return found;

  // 4) Final fallback for new/unreleased apps:
  // scrape the official Steam store page and use its og:image/twitter:image/CDN URL.
  try {
    const html = await fetchText(
      `https://store.steampowered.com/app/${appId}/?l=english&cc=ru`
    );
    const pageImages = extractSteamPageImages(html);
    found = await fetchFirstImage(pageImages);
    if (found) return found;
  } catch (_) {}

  return null;
}

async function normalizeCover(sourceBuffer) {
  const meta = await sharp(sourceBuffer).metadata();
  const width = Number(meta.width || 0);
  const height = Number(meta.height || 0);
  if (!width || !height) throw new Error('Invalid source image');

  const ratio = width / height;
  if (ratio <= 0.9) {
    // Real portrait artwork: fill the 2:3 poster directly.
    return sharp(sourceBuffer)
      .resize(600, 900, { fit: 'cover', position: 'centre' })
      .webp({ quality: 88 })
      .toBuffer();
  }

  // Landscape artwork: make a real 600x900 poster server-side.
  // The background is a darkened/blurred crop; the original art is centered uncut.
  const background = await sharp(sourceBuffer)
    .resize(600, 900, { fit: 'cover', position: 'centre' })
    .blur(26)
    .modulate({ brightness: 0.48, saturation: 0.92 })
    .webp({ quality: 80 })
    .toBuffer();

  const foreground = await sharp(sourceBuffer)
    .resize(552, 620, {
      fit: 'inside',
      withoutEnlargement: false
    })
    .webp({ quality: 92 })
    .toBuffer();

  return sharp(background)
    .composite([{ input: foreground, gravity: 'center' }])
    .webp({ quality: 88 })
    .toBuffer();
}

async function getOrCreateCover(steamType, steamId, refresh = false) {
  let appId = steamType === 'app' ? String(steamId) : null;
  if (!appId && steamType === 'package') appId = await resolvePackageAppId(steamId);

  // Historical matcher records can still have the wrong type. If a package cannot
  // be resolved, safely try the numeric ID as an AppID (same fallback as steam-price).
  if (!appId && /^\d+$/.test(String(steamId))) appId = String(steamId);
  if (!appId) throw new Error('Could not resolve AppID for artwork');

  const cachePath = path.join(COVER_DIR, `app-${appId}.webp`);
  if (!refresh && fs.existsSync(cachePath)) return { cachePath, appId };

  const found = await getAppArtwork(appId);
  if (!found) throw new Error(`Steam artwork unavailable for AppID ${appId}`);

  const normalized = await normalizeCover(found.buffer);
  fs.writeFileSync(cachePath, normalized);
  return { cachePath, appId, source: found.source };
}

function sendCover(res, buffer) {
  res.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'image/webp',
    'Content-Length': buffer.length,
    'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800'
  });
  res.end(buffer);
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



  if (url.pathname === '/api/cover') {
    const steamType = String(url.searchParams.get('steamType') || '').toLowerCase();
    const steamId = String(url.searchParams.get('steamId') || '');
    const refresh = url.searchParams.get('refresh') === '1';

    if (!['app', 'package'].includes(steamType) || !/^\d+$/.test(steamId)) {
      return json(res, 400, { ok: false, error: 'steamType=app|package and numeric steamId are required' });
    }

    try {
      const result = await getOrCreateCover(steamType, steamId, refresh);
      return sendCover(res, fs.readFileSync(result.cachePath));
    } catch (err) {
      console.error('cover error:', steamType, steamId, err.message);
      return json(res, 404, { ok: false, error: err.message });
    }
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
