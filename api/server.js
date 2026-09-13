const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const sharp = require('sharp');
const { URL } = require('url');

const PORT = 3000;
const HOST = '127.0.0.1';
const MATCHES_FILE = '/var/www/zibstore/data/steam-matches.json';
const REGION_ORDER = ['ru', 'kz', 'ua', 'us'];
const COVER_DIR = '/var/www/zibstore/api/covers';
const CUSTOM_COVER_DIR = '/var/www/zibstore/api/custom-covers';
const PUBLIC_API_BASE = String(process.env.PUBLIC_API_BASE || 'https://api.zibstore.ru').replace(/\/$/, '');
fs.mkdirSync(COVER_DIR, { recursive: true });
fs.mkdirSync(CUSTOM_COVER_DIR, { recursive: true });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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



function classifyDimensions(width, height, extra = {}) {
  width = Number(width || 0);
  height = Number(height || 0);

  if (!width || !height) {
    return { status: 'replace', statusLabel: 'Надо заменить', ideal: false, suitable: false };
  }

  const ratio = width / height;
  const ratioError = Math.abs(ratio - (2 / 3));
  const portrait = ratio < 0.9;
  const tooSmall = width < 300 || height < 450;
  const ideal = portrait && !tooSmall && ratioError <= 0.08;
  const suitable = portrait && !tooSmall && ratioError <= 0.18;

  if (tooSmall) {
    return { status: 'replace', statusLabel: 'Надо заменить', ideal, suitable, ratio };
  }
  if (!suitable) {
    return { status: 'format', statusLabel: 'Не подходит по формату', ideal, suitable, ratio };
  }
  return { status: 'ok', statusLabel: 'ОК', ideal, suitable, ratio };
}

function isPrivateIp(ip) {
  const family = net.isIP(ip);
  if (!family) return true;

  if (family === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }

  const s = ip.toLowerCase();
  return (
    s === '::1' ||
    s === '::' ||
    s.startsWith('fc') ||
    s.startsWith('fd') ||
    s.startsWith('fe8') ||
    s.startsWith('fe9') ||
    s.startsWith('fea') ||
    s.startsWith('feb')
  );
}

async function assertSafeExternalUrl(raw) {
  const u = new URL(String(raw || '').trim());
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Разрешены только http/https URL');
  if (!u.hostname || u.hostname === 'localhost') throw new Error('Недопустимый host');

  const records = await dns.lookup(u.hostname, { all: true, verbatim: true });
  if (!records.length || records.some(r => isPrivateIp(r.address))) {
    throw new Error('Локальные/служебные адреса запрещены');
  }
  return u.toString();
}

async function fetchExternalImageSafe(rawUrl, maxBytes = 12 * 1024 * 1024) {
  const safeUrl = await assertSafeExternalUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(safeUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; ZibStoreCoverAdmin/1.0)'
      }
    });

    if (!res.ok) throw new Error(`Источник вернул HTTP ${res.status}`);

    const finalUrl = await assertSafeExternalUrl(res.url || safeUrl);
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    if (!type.startsWith('image/')) throw new Error(`URL не является изображением (${type || 'unknown'})`);

    const length = Number(res.headers.get('content-length') || 0);
    if (length && length > maxBytes) throw new Error('Изображение слишком большое (максимум 12 МБ)');

    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) throw new Error('Изображение слишком большое (максимум 12 МБ)');
      chunks.push(Buffer.from(chunk));
    }

    return { buffer: Buffer.concat(chunks), source: finalUrl };
  } finally {
    clearTimeout(timer);
  }
}

async function saveCustomCoverBuffer(productId, inputBuffer, source = 'upload') {
  if (!/^[A-Za-z0-9_-]+$/.test(String(productId || ''))) throw new Error('Invalid productId');

  const meta = await sharp(inputBuffer).metadata();
  const width = Number(meta.width || 0);
  const height = Number(meta.height || 0);
  if (!width || !height) throw new Error('Не удалось определить размер изображения');

  // Versioned names avoid browser/CDN showing an older saved cover.
  const filename = `product-${productId}-${Date.now()}.webp`;
  const filePath = path.join(CUSTOM_COVER_DIR, filename);

  let pipeline = sharp(inputBuffer).rotate();
  const maxW = 1800;
  const maxH = 2700;
  if (width > maxW || height > maxH) {
    pipeline = pipeline.resize(maxW, maxH, { fit: 'inside', withoutEnlargement: true });
  }

  await pipeline.webp({ quality: 92 }).toFile(filePath);

  const savedMeta = await sharp(filePath).metadata();
  const savedWidth = Number(savedMeta.width || width);
  const savedHeight = Number(savedMeta.height || height);
  const quality = classifyDimensions(savedWidth, savedHeight);

  return {
    filename,
    filePath,
    coverUrl: `${PUBLIC_API_BASE}/api/custom-cover/${encodeURIComponent(filename)}`,
    width: savedWidth,
    height: savedHeight,
    source,
    ...quality
  };
}

function localCustomFilenameFromUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  const prefix = `${PUBLIC_API_BASE}/api/custom-cover/`;
  if (!url.startsWith(prefix)) return null;
  const filename = decodeURIComponent(url.slice(prefix.length));
  return /^[A-Za-z0-9._-]+\.webp$/.test(filename) ? filename : null;
}

function customCoverUrl(filename) {
  return `${PUBLIC_API_BASE}/api/custom-cover/${encodeURIComponent(filename)}`;
}

async function listSavedCustomCovers() {
  const files = fs.existsSync(CUSTOM_COVER_DIR)
    ? fs.readdirSync(CUSTOM_COVER_DIR).filter(name => /^[A-Za-z0-9._-]+\.webp$/.test(name))
    : [];

  const items = [];
  for (const filename of files) {
    const filePath = path.join(CUSTOM_COVER_DIR, filename);
    try {
      const stat = fs.statSync(filePath);
      const meta = await sharp(filePath).metadata();
      const width = Number(meta.width || 0);
      const height = Number(meta.height || 0);
      items.push({
        filename,
        url: customCoverUrl(filename),
        width,
        height,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        ...classifyDimensions(width, height)
      });
    } catch (_) {}
  }

  items.sort((a,b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
  return items;
}

function deleteSavedCustomCover(filename) {
  if (!/^[A-Za-z0-9._-]+\.webp$/.test(String(filename || ''))) return false;
  const filePath = path.join(CUSTOM_COVER_DIR, filename);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return true;
  } catch (_) {
    return false;
  }
}


async function inspectCustomUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return { status: 'replace', statusLabel: 'Надо заменить', width: 0, height: 0, sourceType: 'custom' };

  const localPrefix = `${PUBLIC_API_BASE}/api/custom-cover/`;
  if (url.startsWith(localPrefix)) {
    const filename = decodeURIComponent(url.slice(localPrefix.length)).replace(/[^A-Za-z0-9._-]/g, '');
    const filePath = path.join(CUSTOM_COVER_DIR, filename);
    if (!fs.existsSync(filePath)) {
      return { status: 'replace', statusLabel: 'Надо заменить', width: 0, height: 0, sourceType: 'upload' };
    }
    const meta = await sharp(filePath).metadata();
    return {
      width: Number(meta.width || 0),
      height: Number(meta.height || 0),
      sourceType: 'upload',
      ...classifyDimensions(meta.width, meta.height)
    };
  }

  try {
    const found = await fetchExternalImageSafe(url, 12 * 1024 * 1024);
    const meta = await sharp(found.buffer).metadata();
    return {
      width: Number(meta.width || 0),
      height: Number(meta.height || 0),
      sourceType: 'custom',
      ...classifyDimensions(meta.width, meta.height)
    };
  } catch (_) {
    return { status: 'replace', statusLabel: 'Надо заменить', width: 0, height: 0, sourceType: 'custom' };
  }
}

async function inspectCoverItem(item) {
  if (String(item.coverMode || 'steam').toLowerCase() === 'custom' && item.coverUrl) {
    return inspectCustomUrl(item.coverUrl);
  }

  let appId = item.coverAppId ? String(item.coverAppId) : null;
  if (!appId) {
    appId = item.type === 'package'
      ? await resolvePackageAppId(item.steamId)
      : String(item.steamId || '');
  }

  if (!appId || !/^\d+$/.test(appId)) {
    return { status: 'replace', statusLabel: 'Надо заменить', width: 0, height: 0, sourceType: 'steam' };
  }

  try {
    const result = await getOrCreateCover('app', appId, false);
    const quality = String(result.quality || 'unknown');
    if (quality === 'native') {
      return { status: 'ok', statusLabel: 'ОК', width: 600, height: 900, sourceType: 'steam' };
    }
    return { status: 'format', statusLabel: 'Не подходит по формату', width: 600, height: 900, sourceType: 'steam-fallback' };
  } catch (_) {
    return { status: 'replace', statusLabel: 'Надо заменить', width: 0, height: 0, sourceType: 'steam' };
  }
}

async function mapWithConcurrency(entries, limit, mapper) {
  const out = new Array(entries.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= entries.length) return;
      out[idx] = await mapper(entries[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, entries.length || 1) }, worker));
  return out;
}

async function getArtworkOptions(appId) {
  appId = String(appId || '').trim();
  if (!/^\d+$/.test(appId)) throw new Error('Invalid AppID');

  let exact = {};
  for (const cc of ['us', 'kz', 'ru']) {
    try {
      const data = await fetchJson(
        `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${cc}&l=english`
      );
      const block = data?.[appId];
      if (block?.success && block?.data) {
        exact = block.data;
        break;
      }
    } catch (_) {}
  }

  const candidates = [
    { label: 'library_600x900', url: `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg` },
    { label: 'library_600x900 (akamai)', url: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg` },
    { label: 'capsule_616x353', url: `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appId}/capsule_616x353.jpg` },
    { label: 'header', url: exact.header_image || `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg` },
    { label: 'capsule', url: exact.capsule_image },
    { label: 'capsule_v5', url: exact.capsule_imagev5 },
    { label: 'library_hero', url: `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appId}/library_hero.jpg` },
    { label: 'background_raw', url: exact.background_raw },
    { label: 'background', url: exact.background }
  ];

  // Add official, app-specific images found on the Steam store page.
  for (const cc of ['us', 'kz', 'ru']) {
    try {
      const html = await fetchText(
        `https://store.steampowered.com/app/${appId}/?l=english&cc=${cc}`
      );
      for (const url of extractSteamPageImages(html)) {
        const s = String(url || '');
        const belongsToApp =
          s.includes(`/steam/apps/${appId}/`) ||
          s.includes(`/store_item_assets/steam/apps/${appId}/`);
        const generic = /\/public\/images\//i.test(s) ||
          /steam_logo|logo_steam|steamlogo|default|placeholder/i.test(s);
        const screenshotLike = /screenshots|ss_[a-f0-9]+/i.test(s);

        if (belongsToApp && !generic && !screenshotLike) {
          candidates.push({ label: 'store_page', url: s });
        }
      }
      if (candidates.length > 14) break;
    } catch (_) {}
  }

  const unique = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const url = String(candidate.url || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);

    try {
      const buffer = await fetchBuffer(url, 9000);
      const meta = await sharp(buffer).metadata();
      const width = Number(meta.width || 0);
      const height = Number(meta.height || 0);
      if (!width || !height) continue;

      const ratio = width / height;
      const targetRatio = 2 / 3;
      const ratioError = Math.abs(ratio - targetRatio);
      const quality = classifyDimensions(width, height);
      const portrait = ratio < 0.9;
      const meaningless =
        width < 260 ||
        height < 260 ||
        ratio < 0.32 ||
        ratio > 2.4;

      if (meaningless) continue;

      unique.push({
        label: candidate.label,
        url,
        width,
        height,
        ratio: Math.round(ratio * 1000) / 1000,
        ideal: quality.ideal,
        suitable: quality.suitable,
        recommended: quality.status === 'ok',
        status: quality.status,
        statusLabel: quality.statusLabel,
        score:
          (quality.ideal ? 1000 : quality.suitable ? 650 : portrait ? 250 : 0) +
          Math.min(width, 2000) / 20 -
          ratioError * 100
      });
    } catch (_) {}
  }

  unique.sort((a, b) => b.score - a.score);

  return unique.map(({ score, ...item }) => item);
}

async function getAppArtwork(appId) {
  // Product covers should use key art, not arbitrary gameplay screenshots.
  // Artwork lookup stays independent from pricing regions.
  let exact = {};

  for (const cc of ['us', 'kz', 'ru']) {
    try {
      const data = await fetchJson(
        `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${cc}&l=english`
      );
      const block = data?.[String(appId)];
      if (block?.success && block?.data) {
        exact = block.data;
        break;
      }
    } catch (_) {}
  }

  const portraitUrls = [
    `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`,
    `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`
  ];

  const keyArtUrls = [
    exact.header_image,
    exact.capsule_image,
    exact.capsule_imagev5,
    exact.background_raw,
    exact.background
  ];

  // 1) Prefer a true vertical Steam library poster.
  let found = await fetchFirstImage(portraitUrls);
  if (found) return found;

  // 2) Otherwise use official key art only.
  found = await fetchFirstImage(keyArtUrls);
  if (found) return found;

  // 3) Store-page fallback. Accept only app-specific key-art style URLs.
  // Screenshots are intentionally excluded.
  for (const cc of ['us', 'kz', 'ru']) {
    try {
      const html = await fetchText(
        `https://store.steampowered.com/app/${appId}/?l=english&cc=${cc}`
      );
      const pageImages = extractSteamPageImages(html).filter(url => {
        const s = String(url || '');
        const belongsToApp = (
          s.includes(`/steam/apps/${appId}/`) ||
          s.includes(`/store_item_assets/steam/apps/${appId}/`)
        );
        const generic = (
          /\/public\/images\//i.test(s) ||
          /steam_logo|logo_steam|steamlogo|default|placeholder/i.test(s)
        );
        const screenshotLike = /screenshots|ss_[a-f0-9]+/i.test(s);
        return belongsToApp && !generic && !screenshotLike;
      });

      found = await fetchFirstImage(pageImages);
      if (found) return found;
    } catch (_) {}
  }

  return null;
}

async function normalizeCover(sourceBuffer) {
  const meta = await sharp(sourceBuffer).metadata();
  const width = Number(meta.width || 0);
  const height = Number(meta.height || 0);
  if (!width || !height) throw new Error('Invalid source image');

  const ratio = width / height;

  // Native portrait artwork: use it directly as a 2:3 cover.
  if (ratio <= 0.9) {
    return sharp(sourceBuffer)
      .resize(600, 900, { fit: 'cover', position: 'centre' })
      .webp({ quality: 90 })
      .toBuffer();
  }

  // Landscape/square key art:
  // one coherent 600x900 poster = dark blurred background + centered full key art.
  const background = await sharp(sourceBuffer)
    .resize(600, 900, { fit: 'cover', position: 'centre' })
    .blur(30)
    .modulate({ brightness: 0.38, saturation: 0.86 })
    .webp({ quality: 82 })
    .toBuffer();

  const foreground = await sharp(sourceBuffer)
    .resize(540, 360, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toBuffer();

  const panel = await sharp({
    create: {
      width: 570,
      height: 390,
      channels: 4,
      background: { r: 10, g: 10, b: 12, alpha: 0.62 }
    }
  }).png().toBuffer();

  return sharp(background)
    .composite([
      { input: panel, top: 255, left: 15 },
      { input: foreground, top: 270, left: 30 }
    ])
    .webp({ quality: 90 })
    .toBuffer();
}

async function getOrCreateCover(steamType, steamId, refresh = false) {
  let appId = steamType === 'app' ? String(steamId) : null;
  if (!appId && steamType === 'package') appId = await resolvePackageAppId(steamId);

  if (!appId && /^\d+$/.test(String(steamId))) appId = String(steamId);
  if (!appId) throw new Error('Could not resolve AppID for artwork');

  const cachePath = path.join(COVER_DIR, `app-${appId}.webp`);
  const metaPath = path.join(COVER_DIR, `app-${appId}.json`);

  if (!refresh && fs.existsSync(cachePath)) {
    let meta = { quality: 'unknown', source: null, appId };
    try {
      meta = { ...meta, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) };
    } catch (_) {}
    return { cachePath, appId, ...meta };
  }

  const found = await getAppArtwork(appId);
  if (!found) throw new Error(`Steam artwork unavailable for AppID ${appId}`);

  const normalized = await normalizeCover(found.buffer);
  fs.writeFileSync(cachePath, normalized);

  const source = String(found.source || '');
  const quality = /library_600x900/i.test(source) ? 'native' : 'fallback';
  const meta = { appId, quality, source, generatedAt: new Date().toISOString() };

  try {
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  } catch (_) {}

  return { cachePath, ...meta };
}

function sendCover(res, buffer, meta = {}) {
  res.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'X-ZibStore-Cover-Quality, X-ZibStore-Cover-AppId',
    'X-ZibStore-Cover-Quality': String(meta.quality || 'unknown'),
    'X-ZibStore-Cover-AppId': String(meta.appId || ''),
    'Content-Type': 'image/webp',
    'Content-Length': buffer.length,
    'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400'
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

function adminJson(res, status, body) {
  res.writeHead(status, {
    ...CORS,
    'Cache-Control': 'no-store, max-age=0'
  });
  res.end(JSON.stringify(body));
}

const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || '');
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const adminSessions = new Map();
const loginAttempts = new Map();

function safeEqualText(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

function cleanupAdminSessions() {
  const now = Date.now();
  for (const [token, session] of adminSessions.entries()) {
    if (!session || session.expiresAt <= now) adminSessions.delete(token);
  }
}

function createAdminSession(username) {
  cleanupAdminSessions();
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, {
    username,
    expiresAt: Date.now() + ADMIN_SESSION_TTL_MS
  });
  return token;
}

function getBearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function requireAdmin(req, res) {
  cleanupAdminSessions();

  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    adminJson(res, 503, {
      ok: false,
      error: 'Admin credentials are not configured on the server'
    });
    return null;
  }

  const token = getBearerToken(req);
  const session = token ? adminSessions.get(token) : null;

  if (!session || session.expiresAt <= Date.now()) {
    if (token) adminSessions.delete(token);
    adminJson(res, 401, { ok: false, error: 'Unauthorized' });
    return null;
  }

  // Sliding expiration while the admin is actively using the page.
  session.expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  return { token, session };
}

function loginRateLimited(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const maxAttempts = 10;
  const entry = loginAttempts.get(ip);

  if (!entry || now - entry.startedAt > windowMs) {
    loginAttempts.set(ip, { startedAt: now, count: 0 });
    return false;
  }

  return entry.count >= maxAttempts;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const entry = loginAttempts.get(ip);

  if (!entry || now - entry.startedAt > windowMs) {
    loginAttempts.set(ip, { startedAt: now, count: 1 });
  } else {
    entry.count += 1;
  }
}

async function readJsonBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

const MATCHES_PATH = path.join(__dirname, '..', 'data', 'steam-matches.json');

function readSteamMatchesFile() {
  try {
    return JSON.parse(fs.readFileSync(MATCHES_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeSteamMatchesFile(data) {
  const tmp = `${MATCHES_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, MATCHES_PATH);
}

function sanitizeCoverPatch(input = {}) {
  const out = {};

  if ('coverMode' in input) {
    const mode = String(input.coverMode || '').toLowerCase();
    out.coverMode = ['steam', 'custom'].includes(mode) ? mode : 'steam';
  }

  if ('coverAppId' in input) {
    const value = String(input.coverAppId || '').trim();
    out.coverAppId = /^\d+$/.test(value) ? value : null;
  }

  if ('coverUrl' in input) {
    const value = String(input.coverUrl || '').trim();
    out.coverUrl = value || null;
  }

  if ('coverSource' in input) {
    const value = String(input.coverSource || '').trim().toLowerCase();
    out.coverSource = ['steam', 'url', 'upload', 'saved'].includes(value) ? value : null;
  }

  return out;
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




  if (url.pathname === '/api/admin/login' && req.method === 'POST') {
    const ip = getClientIp(req);

    if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
      return adminJson(res, 503, {
        ok: false,
        error: 'Admin credentials are not configured on the server'
      });
    }

    if (loginRateLimited(ip)) {
      return adminJson(res, 429, {
        ok: false,
        error: 'Too many login attempts. Try again later.'
      });
    }

    try {
      const body = await readJsonBody(req, 16 * 1024);
      const username = String(body.username || '');
      const password = String(body.password || '');

      const validUser = safeEqualText(username, ADMIN_USERNAME);
      const validPassword = safeEqualText(password, ADMIN_PASSWORD);

      if (!validUser || !validPassword) {
        recordLoginFailure(ip);
        return adminJson(res, 401, { ok: false, error: 'Неверный логин или пароль' });
      }

      loginAttempts.delete(ip);
      const token = createAdminSession(username);

      return adminJson(res, 200, {
        ok: true,
        token,
        expiresIn: Math.floor(ADMIN_SESSION_TTL_MS / 1000)
      });
    } catch (err) {
      return adminJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (url.pathname === '/api/admin/logout' && req.method === 'POST') {
    const token = getBearerToken(req);
    if (token) adminSessions.delete(token);
    return adminJson(res, 200, { ok: true });
  }


  if (url.pathname.startsWith('/api/custom-cover/') && req.method === 'GET') {
    const filename = decodeURIComponent(url.pathname.slice('/api/custom-cover/'.length));
    if (!/^[A-Za-z0-9._-]+\.webp$/.test(filename)) {
      return json(res, 400, { ok: false, error: 'Invalid filename' });
    }

    const filePath = path.join(CUSTOM_COVER_DIR, filename);
    if (!fs.existsSync(filePath)) {
      return json(res, 404, { ok: false, error: 'Cover not found' });
    }

    const buffer = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'image/webp',
      'Content-Length': buffer.length,
      'Cache-Control': 'public, max-age=86400'
    });
    return res.end(buffer);
  }

  if (url.pathname === '/api/admin/cover-library' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;

    try {
      const items = await listSavedCustomCovers();
      return adminJson(res, 200, { ok: true, items });
    } catch (err) {
      return adminJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (url.pathname === '/api/admin/use-saved-cover' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;

    try {
      const body = await readJsonBody(req, 64 * 1024);
      const productId = String(body.productId || '').trim();
      const filename = String(body.filename || '').trim();

      if (!productId || !/^[A-Za-z0-9._-]+\.webp$/.test(filename)) {
        return adminJson(res, 400, { ok: false, error: 'productId and valid filename are required' });
      }

      const matches = readSteamMatchesFile();
      if (!matches[productId]) {
        return adminJson(res, 404, { ok: false, error: 'Product mapping not found' });
      }

      const filePath = path.join(CUSTOM_COVER_DIR, filename);
      if (!fs.existsSync(filePath)) {
        return adminJson(res, 404, { ok: false, error: 'Saved cover not found' });
      }

      const meta = await sharp(filePath).metadata();
      const width = Number(meta.width || 0);
      const height = Number(meta.height || 0);
      const quality = classifyDimensions(width, height);

      matches[productId] = {
        ...matches[productId],
        coverMode: 'custom',
        coverUrl: customCoverUrl(filename),
        coverSource: 'saved'
      };
      writeSteamMatchesFile(matches);

      return adminJson(res, 200, {
        ok: true,
        productId,
        item: matches[productId],
        cover: { filename, width, height, ...quality }
      });
    } catch (err) {
      return adminJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (url.pathname === '/api/admin/delete-saved-cover' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;

    try {
      const body = await readJsonBody(req, 64 * 1024);
      const filename = String(body.filename || '').trim();
      if (!/^[A-Za-z0-9._-]+\.webp$/.test(filename)) {
        return adminJson(res, 400, { ok: false, error: 'Invalid filename' });
      }

      const targetUrl = customCoverUrl(filename);
      const matches = readSteamMatchesFile();
      const inUseBy = Object.entries(matches)
        .filter(([, item]) => item?.coverUrl === targetUrl)
        .map(([productId]) => productId);

      if (inUseBy.length) {
        return adminJson(res, 409, {
          ok: false,
          error: `Обложка используется товарами: ${inUseBy.join(', ')}`
        });
      }

      deleteSavedCustomCover(filename);
      return adminJson(res, 200, { ok: true, filename });
    } catch (err) {
      return adminJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (url.pathname === '/api/admin/import-cover' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;

    try {
      const body = await readJsonBody(req, 64 * 1024);
      const productId = String(body.productId || '').trim();
      const sourceUrl = String(body.url || '').trim();
      if (!productId || !sourceUrl) {
        return adminJson(res, 400, { ok: false, error: 'productId and url are required' });
      }

      const matches = readSteamMatchesFile();
      if (!matches[productId]) {
        return adminJson(res, 404, { ok: false, error: 'Product mapping not found' });
      }

      const found = await fetchExternalImageSafe(sourceUrl);
      const saved = await saveCustomCoverBuffer(productId, found.buffer, 'url');

      matches[productId] = {
        ...matches[productId],
        coverMode: 'custom',
        coverUrl: saved.coverUrl,
        coverSource: 'url'
      };
      writeSteamMatchesFile(matches);

      return adminJson(res, 200, {
        ok: true,
        productId,
        item: matches[productId],
        cover: saved
      });
    } catch (err) {
      return adminJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (url.pathname === '/api/admin/upload-cover' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;

    try {
      const body = await readJsonBody(req, 18 * 1024 * 1024);
      const productId = String(body.productId || '').trim();
      const dataUrl = String(body.dataUrl || '');
      if (!productId || !dataUrl) {
        return adminJson(res, 400, { ok: false, error: 'productId and dataUrl are required' });
      }

      const matches = readSteamMatchesFile();
      if (!matches[productId]) {
        return adminJson(res, 404, { ok: false, error: 'Product mapping not found' });
      }

      const m = dataUrl.match(/^data:image\/(?:png|jpe?g|webp|avif);base64,([A-Za-z0-9+/=]+)$/i);
      if (!m) {
        return adminJson(res, 400, { ok: false, error: 'Поддерживаются PNG, JPG, WEBP, AVIF' });
      }

      const buffer = Buffer.from(m[1], 'base64');
      if (!buffer.length || buffer.length > 12 * 1024 * 1024) {
        return adminJson(res, 400, { ok: false, error: 'Файл должен быть не больше 12 МБ' });
      }

      const saved = await saveCustomCoverBuffer(productId, buffer, 'upload');

      matches[productId] = {
        ...matches[productId],
        coverMode: 'custom',
        coverUrl: saved.coverUrl,
        coverSource: 'upload'
      };
      writeSteamMatchesFile(matches);

      return adminJson(res, 200, {
        ok: true,
        productId,
        item: matches[productId],
        cover: saved
      });
    } catch (err) {
      return adminJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (url.pathname === '/api/admin/cover-options' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;

    const steamType = String(url.searchParams.get('steamType') || 'app').toLowerCase();
    const steamId = String(url.searchParams.get('steamId') || '').trim();
    const requestedAppId = String(url.searchParams.get('appId') || '').trim();

    if (!['app', 'package'].includes(steamType) || !/^\d+$/.test(steamId)) {
      return adminJson(res, 400, { ok: false, error: 'steamType and numeric steamId are required' });
    }

    try {
      let appId = /^\d+$/.test(requestedAppId) ? requestedAppId : null;
      if (!appId) {
        appId = steamType === 'app' ? steamId : await resolvePackageAppId(steamId);
      }
      if (!appId) {
        return adminJson(res, 404, { ok: false, error: 'Could not resolve AppID for artwork' });
      }

      const options = await getArtworkOptions(appId);
      return adminJson(res, 200, {
        ok: true,
        appId,
        options
      });
    } catch (err) {
      return adminJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (url.pathname === '/api/admin/covers' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;

    const matches = readSteamMatchesFile();
    const entries = Object.entries(matches);

    const items = await mapWithConcurrency(entries, 4, async ([productId, item]) => {
      const health = await inspectCoverItem(item);
      return {
        productId,
        type: item.type || 'app',
        steamId: item.steamId || '',
        title: item.title || '',
        region: item.region || 'ru',
        coverMode: item.coverMode || 'steam',
        coverAppId: item.coverAppId || '',
        coverUrl: item.coverUrl || '',
        coverSource: item.coverSource || (item.coverMode === 'custom' ? 'url' : 'steam'),
        coverStatus: health.status,
        coverStatusLabel: health.statusLabel,
        coverWidth: health.width || 0,
        coverHeight: health.height || 0,
        coverSourceType: health.sourceType || ''
      };
    });

    return adminJson(res, 200, { ok: true, items });
  }

  if (url.pathname === '/api/admin/covers' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;

    try {
      const body = await readJsonBody(req);
      const productId = String(body.productId || '').trim();
      if (!productId) return adminJson(res, 400, { ok: false, error: 'productId is required' });

      const matches = readSteamMatchesFile();
      if (!matches[productId]) {
        return adminJson(res, 404, { ok: false, error: 'Product mapping not found' });
      }

      const patch = sanitizeCoverPatch(body);
      const next = { ...matches[productId], ...patch };

      if (!next.coverAppId) delete next.coverAppId;
      if (!next.coverUrl) delete next.coverUrl;
      if (!next.coverSource) delete next.coverSource;
      if (!next.coverMode) next.coverMode = 'steam';
      if (next.coverMode === 'steam') {
        delete next.coverUrl;
        delete next.coverSource;
      }

      matches[productId] = next;
      writeSteamMatchesFile(matches);

      return adminJson(res, 200, { ok: true, productId, item: next });
    } catch (err) {
      return adminJson(res, 400, { ok: false, error: err.message });
    }
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
      return sendCover(res, fs.readFileSync(result.cachePath), result);
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
