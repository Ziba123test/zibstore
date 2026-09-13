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
const DIGISELLER_SELLER_ID = 810015;
const DIGISELLER_API_BASE = 'https://api.digiseller.com/api';
const AUTO_MATCH_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_MATCH_MAX_STEAM_SEARCHES = 40;
let autoMatchLastSyncAt = 0;
let autoMatchSyncPromise = null;
let autoMatchLastReport = null;
const steamLocalizationCache = new Map();
const STEAM_LOCALIZATION_CACHE_MS = 24 * 60 * 60 * 1000;
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


function cleanSalesTitle(value) {
  let s = String(value || '')
    // Remove trademark/copyright marks BEFORE NFKC.
    // NFKC turns ™ into literal "TM", which previously made:
    //   "STAR WARS Zero Company™" -> "star wars zero companytm"
    // and prevented an otherwise exact Steam match.
    .replace(/[™®©℠]/g, ' ')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .replace(/[\u{1F000}-\u{1FAFF}\uFE0F]/gu, ' ');

  // Remove multi-word seller phrases first. Avoid \b here: JavaScript word
  // boundaries are ASCII-oriented and fail on Cyrillic words like "РУ"/"СНГ"/"авто".
  const phrases = [
    /выбор\s+издания/giu,
    /весь\s+мир/giu,
    /для\s+россии/giu,
    /standard\s+edition/giu,
    /steam\s+auto/giu,

    // Digiseller sellers often append service/commission percentages to titles:
    // "0%", "5%", "+5%" etc. If '%' is stripped first, the leftover number
    // becomes a fake game-title token and breaks exact matching.
    /(?:^|\s)[+\-]?\d+(?:[.,]\d+)?\s*%(?=\s|$)/giu
  ];
  for (const re of phrases) s = s.replace(re, ' ');

  // Convert seller separators to spaces before token filtering.
  s = s
    .replace(/[+*|/\\()[\]{}<>—–_-]+/g, ' ')
    .replace(/[^a-zа-яё0-9:'&.]+/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const noiseTokens = new Set([
    'steam','gift','key','auto','autodelivery',
    'авто','автодоставка','ключ','гифт','подарок','бонус',
    'россия','мир','снг','рф','ру','уа',
    'ru','rf','ua','by','kz','tr','ar','cis',
    'кз','тр','ар',
    'chг','chн','снg','снг',
    'world','global','worldwide',
    'tm','sm',
    'standard','edition'
  ]);

  const tokens = s
    .split(/\s+/)
    .filter(token => token && !noiseTokens.has(token));

  // A percentage may be written with unusual spacing and lose the '%' during cleanup.
  // Remove a lone trailing small numeric token only when the rest already looks like a title.
  if (tokens.length >= 3 && /^\d{1,2}$/.test(tokens[tokens.length - 1])) {
    tokens.pop();
  }

  return tokens.join(' ').trim();
}

function editionInfo(value) {
  const s = String(value || '').toLowerCase();
  const tags = [
    ['premium', /\bpremium\b/i],
    ['deluxe', /\bdeluxe\b/i],
    ['ultimate', /\bultimate\b/i],
    ['gold', /\bgold\b/i],
    ['complete', /\bcomplete\b/i],
    ['collector', /\bcollector'?s?\b/i],
    ['definitive', /\bdefinitive\b/i],
    ['anniversary', /\banniversary\b/i],
    ['bundle', /\bbundle\b/i],
    ['standard', /\bstandard(?:\s+edition)?\b/i]
  ];
  const hit = tags.find(([, re]) => re.test(s));
  return { tag: hit ? hit[0] : null, flexible: /выбор\s+издания/i.test(s) };
}

function baseGameTitle(value) {
  return cleanSalesTitle(value)
    .replace(/\b(?:premium|deluxe|ultimate|gold|complete|collector'?s?|definitive|anniversary|bundle)(?:\s+edition)?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleTokens(value) {
  return new Set(baseGameTitle(value).split(/\s+/).filter(x => x.length > 1));
}

function titleSimilarity(a, b) {
  const aa = baseGameTitle(a);
  const bb = baseGameTitle(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;

  const A = titleTokens(a);
  const B = titleTokens(b);
  if (!A.size || !B.size) return 0;

  let intersection = 0;
  for (const t of A) if (B.has(t)) intersection++;
  const union = new Set([...A, ...B]).size;
  const jaccard = union ? intersection / union : 0;
  const containment = intersection / Math.min(A.size, B.size);
  const contains = aa.includes(bb) || bb.includes(aa) ? 0.08 : 0;

  return Math.min(1, (jaccard * 0.58) + (containment * 0.34) + contains);
}

function editionsCompatible(currentTitle, knownTitle) {
  const a = editionInfo(currentTitle);
  const b = editionInfo(knownTitle);

  if (a.flexible || b.flexible) return true;
  if (!a.tag && !b.tag) return true;
  if (a.tag === 'standard' && !b.tag) return true;
  if (b.tag === 'standard' && !a.tag) return true;
  if (!a.tag || !b.tag) return false;
  return a.tag === b.tag;
}


function shouldIgnoreDigisellerProduct(product) {
  const raw = String(product?.name || '').normalize('NFKC').toLowerCase();

  // Steam top-up/recharge is a partner service, not a game. Never try to map it to Steam AppID.
  return (
    /пополн(?:ение|ить|ения|ить\s+баланс)/iu.test(raw) ||
    /steam\s*(?:wallet|balance|top\s*up|recharge)/iu.test(raw) ||
    /(?:wallet|balance)\s*steam/iu.test(raw) ||
    /пополн.*steam/iu.test(raw)
  );
}

function historicalCandidates(product, matches, limit = 5) {
  const candidates = [];

  for (const [oldProductId, item] of Object.entries(matches || {})) {
    if (!item?.steamId || !item?.title) continue;
    if (String(oldProductId) === String(product.id)) continue;

    const score = titleSimilarity(product.name, item.title);
    const sameBase = baseGameTitle(product.name) === baseGameTitle(item.title);
    const editionOk = editionsCompatible(product.name, item.title);

    candidates.push({
      oldProductId: String(oldProductId),
      steamId: String(item.steamId),
      type: item.type === 'package' ? 'package' : 'app',
      knownTitle: String(item.title),
      normalizedKnownTitle: baseGameTitle(item.title),
      score: Math.round(score * 1000) / 1000,
      exactNormalized: sameBase,
      editionCompatible: editionOk
    });
  }

  return candidates
    .sort((a, b) => {
      if (a.exactNormalized !== b.exactNormalized) return a.exactNormalized ? -1 : 1;
      if (a.editionCompatible !== b.editionCompatible) return a.editionCompatible ? -1 : 1;
      return b.score - a.score;
    })
    .slice(0, Math.max(1, limit));
}

function cloneHistoricalMatch(product, matches) {
  const candidates = historicalCandidates(product, matches, 20)
    .filter(c => c.editionCompatible);

  if (!candidates.length) return null;

  // Strongest automatic case: after stripping seller noise, titles are identical.
  const exact = candidates.filter(c => c.exactNormalized);
  let best = null;

  if (exact.length === 1) {
    best = exact[0];
  } else if (exact.length > 1) {
    // Several Digiseller lots for the same game are okay only if they all point
    // to the same Steam target. Then inheritance is still unambiguous.
    const targets = new Set(exact.map(c => `${c.type}:${c.steamId}`));
    if (targets.size === 1) best = exact[0];
  }

  // Fuzzy fallback: still conservative and requires a clear lead.
  if (!best) {
    const first = candidates[0];
    const second = candidates[1];
    if (!first || first.score < 0.965) return null;

    const margin = first.score - (second?.score || 0);
    if (margin < 0.08) return null;
    best = first;
  }

  const source = matches[best.oldProductId];
  if (!source) return null;

  return {
    type: source.type === 'package' ? 'package' : 'app',
    steamId: String(source.steamId),
    title: String(product.name || source.title),
    region: 'ru',
    savedAt: new Date().toISOString(),
    coverMode: source.coverMode || 'steam',
    ...(source.coverAppId ? { coverAppId: String(source.coverAppId) } : {}),
    ...(source.coverUrl ? { coverUrl: String(source.coverUrl) } : {}),
    ...(source.coverSource ? { coverSource: String(source.coverSource) } : {}),
    autoMatched: true,
    matchSource: 'history',
    matchedFromProductId: String(best.oldProductId),
    matchConfidence: best.exactNormalized ? 1 : best.score
  };
}

async function steamStoreSearch(term) {
  const q = String(term || '').trim();
  if (!q) return [];

  try {
    const data = await fetchJson(
      `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&l=english&cc=us`
    );
    return Array.isArray(data?.items) ? data.items : [];
  } catch (_) {
    return [];
  }
}

async function matchFromSteamSearch(product) {
  const currentEdition = editionInfo(product.name);

  // A new paid edition/package cannot safely be inferred from a base app.
  // Seller changes are still automated through historical matches above.
  if (currentEdition.tag && currentEdition.tag !== 'standard') return null;

  const query = baseGameTitle(product.name);
  if (!query || query.length < 3) return null;

  const items = await steamStoreSearch(query);
  const scored = [];

  for (const item of items.slice(0, 12)) {
    if (!item?.id || !item?.name) continue;

    const score = titleSimilarity(product.name, item.name);
    const exactBase = baseGameTitle(product.name) === baseGameTitle(item.name);
    if (!exactBase && score < 0.97) continue;

    scored.push({ item, score, exactBase });
  }

  scored.sort((a, b) => {
    if (a.exactBase !== b.exactBase) return a.exactBase ? -1 : 1;
    return b.score - a.score;
  });

  const best = scored[0];
  const second = scored[1];
  if (!best) return null;

  if (!best.exactBase) {
    const margin = best.score - (second?.score || 0);
    if (best.score < 0.985 || margin < 0.10) return null;
  }

  return {
    type: 'app',
    steamId: String(best.item.id),
    title: String(product.name || best.item.name),
    region: 'ru',
    savedAt: new Date().toISOString(),
    coverMode: 'steam',
    autoMatched: true,
    matchSource: 'steam-search',
    steamSearchName: String(best.item.name),
    matchConfidence: best.exactBase ? 1 : Math.round(best.score * 1000) / 1000
  };
}

async function fetchDigisellerCatalog() {
  const catData = await fetchJson(
    `${DIGISELLER_API_BASE}/categories?seller_id=${DIGISELLER_SELLER_ID}&format=json`
  );
  const categories = Array.isArray(catData?.category) ? catData.category : [];

  const all = [];
  const seen = new Set();

  for (const category of categories) {
    if (!category?.id) continue;

    try {
      const data = await fetchJson(
        `${DIGISELLER_API_BASE}/shop/products?seller_id=${DIGISELLER_SELLER_ID}` +
        `&category_id=${encodeURIComponent(category.id)}&rows=100&currency=RUR&format=json`
      );
      const products = Array.isArray(data?.product) ? data.product : [];

      for (const p of products) {
        const id = String(p?.id || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        all.push({ id, name: String(p?.name || '') });
      }
    } catch (err) {
      console.warn('Digiseller category sync failed:', category.id, err.message);
    }
  }

  return all;
}

async function runAutomaticMatchSync(force = false) {
  const now = Date.now();

  if (!force && autoMatchLastSyncAt && now - autoMatchLastSyncAt < AUTO_MATCH_SYNC_INTERVAL_MS) {
    return autoMatchLastReport || { ok: true, skipped: true, reason: 'interval' };
  }
  if (autoMatchSyncPromise) return autoMatchSyncPromise;

  autoMatchSyncPromise = (async () => {
    const report = {
      ok: true,
      scanned: 0,
      alreadyMatched: 0,
      inherited: 0,
      steamSearchMatched: 0,
      ignored: [],
      unresolved: [],
      errors: []
    };

    try {
      const products = await fetchDigisellerCatalog();
      const matches = readSteamMatchesFile();
      let changed = false;
      let steamSearches = 0;

      report.scanned = products.length;

      for (const product of products) {
        const productId = String(product.id);

        if (shouldIgnoreDigisellerProduct(product)) {
          report.ignored.push({
            productId,
            name: product.name,
            reason: 'non_game_service'
          });
          continue;
        }

        if (matches[productId]?.steamId) {
          report.alreadyMatched++;
          continue;
        }

        // Safest case: same game was previously sold under another Digiseller Product ID.
        const inherited = cloneHistoricalMatch(product, matches);
        if (inherited) {
          matches[productId] = inherited;
          changed = true;
          report.inherited++;
          continue;
        }

        // Truly new title: ask Steam and auto-accept only high-confidence app matches.
        if (steamSearches < AUTO_MATCH_MAX_STEAM_SEARCHES) {
          steamSearches++;
          const steam = await matchFromSteamSearch(product);
          if (steam) {
            matches[productId] = steam;
            changed = true;
            report.steamSearchMatched++;
            continue;
          }
        }

        report.unresolved.push({
          productId,
          name: product.name,
          normalizedName: baseGameTitle(product.name),
          edition: editionInfo(product.name),
          reason: steamSearches >= AUTO_MATCH_MAX_STEAM_SEARCHES ? 'search_limit' : 'low_confidence',
          candidates: historicalCandidates(product, matches, 5)
        });
      }

      if (changed) writeSteamMatchesFile(matches);

      autoMatchLastSyncAt = Date.now();
      autoMatchLastReport = report;

      console.log('Digiseller automatic Steam sync:', JSON.stringify({
        scanned: report.scanned,
        alreadyMatched: report.alreadyMatched,
        inherited: report.inherited,
        steamSearchMatched: report.steamSearchMatched,
        ignored: report.ignored.length,
        unresolved: report.unresolved.length
      }));

      return report;
    } catch (err) {
      report.ok = false;
      report.errors.push(err.message);
      autoMatchLastSyncAt = Date.now();
      autoMatchLastReport = report;
      console.error('Automatic Steam match sync failed:', err.message);
      return report;
    } finally {
      autoMatchSyncPromise = null;
    }
  })();

  return autoMatchSyncPromise;
}


function decodeBasicHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = parseInt(n, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

function sellerText(value, maxLength = 14000) {
  let text = String(value || '');
  if (!text) return '';

  text = text
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(?:p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ');

  text = decodeBasicHtmlEntities(text)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text.slice(0, maxLength);
}

async function getDigisellerProductDetails(productId) {
  const id = String(productId || '').trim();
  if (!/^\d+$/.test(id)) throw new Error('Invalid productId');

  // Do not pass seller_id here: Digiseller can then return the actual product
  // seller name. Category comes from our storefront catalog separately.
  const url =
    `${DIGISELLER_API_BASE}/products/${encodeURIComponent(id)}/data` +
    `?currency=RUB&lang=ru-RU&format=json&cache=1`;

  const data = await fetchJson(url);
  if (Number(data?.retval || 0) !== 0 || !data?.product) {
    throw new Error(data?.retdesc || 'Digiseller product details unavailable');
  }

  const p = data.product;
  return {
    id: String(p.id || id),
    name: String(p.name || ''),
    info: sellerText(p.info),
    addInfo: sellerText(p.add_info),
    seller: p.seller ? {
      id: p.seller.id ? String(p.seller.id) : '',
      name: String(p.seller.name || '')
    } : null,
    releaseDate: String(p.release_date || ''),
    productUrl: String(p.url || ''),
    collection: String(p.collection || ''),
    ownerId: Number.isFinite(Number(p.owner_id)) ? Number(p.owner_id) : null,
    isAvailable: Number(p.is_available ?? 1),
    statistics: p.statistics ? {
      sales: Number(p.statistics.sales),
      refunds: Number(p.statistics.refunds),
      goodReviews: Number(p.statistics.good_reviews),
      badReviews: Number(p.statistics.bad_reviews)
    } : null
  };
}


function htmlAttrValue(tag, name) {
  const re = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i');
  return String(tag || '').match(re)?.[1] || '';
}

function extractElementByDataType(block, type) {
  const source = String(block || '');
  const re = new RegExp(
    `<(div|p|span)\\b([^>]*\\bdata-tr-type=["']${type}["'][^>]*)>([\\s\\S]*?)<\\/\\1>`,
    'i'
  );
  const match = source.match(re);
  if (!match) return null;

  return {
    attrs: match[2] || '',
    html: match[3] || '',
    text: sellerText(match[3] || '', 4000)
  };
}

function looksLikePlatiDate(text) {
  const value = String(text || '').trim();
  return /^\d{2}\.\d{2}\.\d{4}(?:\s+.*)?$/i.test(value);
}

function parsePlatiPublicReviews(html) {
  const source = String(html || '');
  const reviews = [];

  // The browser version we inspected marks the review text with:
  //   data-tr-type="review"
  // This attribute is more stable than the optional digi-er-body CSS class.
  const itemBlocks = source.match(/<li\b[\s\S]*?<\/li>/gi) || [];

  for (const block of itemBlocks) {
    let reviewNode = extractElementByDataType(block, 'review');

    // Fallback #1: old/alternate markup with digi-er-body.
    if (!reviewNode) {
      const bodyMatch = block.match(
        /<(div|p|span)\b([^>]*\bclass=["'][^"']*\bdigi-er-body\b[^"']*["'][^>]*)>([\s\S]*?)<\/\1>/i
      );
      if (bodyMatch) {
        reviewNode = {
          attrs: bodyMatch[2] || '',
          html: bodyMatch[3] || '',
          text: sellerText(bodyMatch[3] || '', 4000)
        };
      }
    }

    // Fallback #2: some Plati responses omit both the class and data-tr-type
    // but keep data-tr-id on the text element.
    if (!reviewNode) {
      const idNodeMatch = block.match(
        /<(div|p|span)\b([^>]*\bdata-tr-id=["'][^"']+["'][^>]*)>([\s\S]*?)<\/\1>/i
      );
      if (idNodeMatch) {
        const candidate = sellerText(idNodeMatch[3] || '', 4000);
        if (candidate && !looksLikePlatiDate(candidate)) {
          reviewNode = {
            attrs: idNodeMatch[2] || '',
            html: idNodeMatch[3] || '',
            text: candidate
          };
        }
      }
    }

    // Fallback #3: extract visible text chunks from the <li> and choose the
    // most plausible non-date/non-label review text.
    if (!reviewNode) {
      const candidates = [];
      const nodeRe = /<(div|p|span)\b[^>]*>([\s\S]*?)<\/\1>/gi;
      let nodeMatch;

      while ((nodeMatch = nodeRe.exec(block))) {
        const text = sellerText(nodeMatch[2] || '', 4000);
        if (!text) continue;
        if (looksLikePlatiDate(text)) continue;
        if (/^(?:отзыв|ответ продавца|положительный отзыв|отрицательный отзыв)$/i.test(text)) continue;
        if (text.length > 2000) continue;

        // Ignore pure numbers / navigation fragments.
        if (/^[\d\s.,:+-]+$/.test(text)) continue;

        candidates.push(text);
      }

      if (candidates.length) {
        // In the public response the actual review is usually the shortest
        // meaningful free-text chunk after the date, not the whole wrapper.
        candidates.sort((a, b) => {
          const aWords = a.split(/\s+/).length;
          const bWords = b.split(/\s+/).length;
          return aWords - bWords || a.length - b.length;
        });

        reviewNode = {
          attrs: '',
          html: '',
          text: candidates[0]
        };
      }
    }

    const info = String(reviewNode?.text || '').trim();
    if (!info) continue;

    const id =
      htmlAttrValue(reviewNode?.attrs || '', 'data-tr-id') ||
      htmlAttrValue(block, 'data-tr-id');

    // Date: choose the last date-like span/p before/inside this list item.
    const dateCandidates = [];
    const dateNodeRe = /<(?:span|p)\b[^>]*>([\s\S]*?)<\/(?:span|p)>/gi;
    let dateMatch;
    while ((dateMatch = dateNodeRe.exec(block))) {
      const text = sellerText(dateMatch[1] || '', 500);
      if (looksLikePlatiDate(text)) dateCandidates.push(text);
    }
    const date = dateCandidates.length ? dateCandidates[0] : '';

    const isNegative =
      /#thumb-down\b/i.test(block) ||
      /\bthumb-down\b/i.test(block) ||
      /\bicon-error\b/i.test(block);

    // Seller replies, if Plati marks them explicitly.
    const commentNode =
      extractElementByDataType(block, 'comment') ||
      extractElementByDataType(block, 'answer') ||
      extractElementByDataType(block, 'response') ||
      extractElementByDataType(block, 'reply') ||
      extractElementByDataType(block, 'seller-comment');

    reviews.push({
      id: String(id || ''),
      type: isNegative ? 'bad' : 'good',
      good: isNegative ? 0 : 1,
      date,
      info,
      comment: String(commentNode?.text || '').trim()
    });
  }

  return reviews;
}

function collectSetCookies(headers) {
  if (!headers) return [];

  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  const value = headers.get('set-cookie');
  return value ? [value] : [];
}

function cookieHeaderFromSetCookies(setCookies) {
  return (setCookies || [])
    .map(value => String(value || '').split(';', 1)[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function getPlatiPublicReviews({
  productId,
  sellerId,
  page = 1,
  rows = 20,
  productUrl = ''
}) {
  const qs = new URLSearchParams({
    id_d: String(productId),
    id_s: String(sellerId),
    mode: '0',
    page: String(page),
    rows: String(rows),
    cat: 'pins',
    ord: '1',
    lang: 'ru-RU'
  });

  const reviewsUrl = `https://plati.market/asp/block_responses2.asp?${qs.toString()}`;
  const pageUrl = String(productUrl || '').startsWith('http')
    ? String(productUrl)
    : `https://plati.market/itm/${encodeURIComponent(productId)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  const commonHeaders = {
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36'
  };

  try {
    // Plati's browser first opens the product page and receives visitor/session
    // cookies. A direct standalone request to block_responses2.asp can return
    // HTTP 200 with an empty review fragment.
    let cookieHeader = '';

    try {
      const pageResponse = await fetch(pageUrl, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          ...commonHeaders,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });

      cookieHeader = cookieHeaderFromSetCookies(
        collectSetCookies(pageResponse.headers)
      );

      // Consume body so the connection can be reused cleanly.
      await pageResponse.arrayBuffer();
    } catch (_) {
      // Reviews request below may still work without the bootstrap cookies.
    }

    const reviewHeaders = {
      ...commonHeaders,
      'Accept': 'text/html, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': pageUrl,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin'
    };

    if (cookieHeader) reviewHeaders.Cookie = cookieHeader;

    const response = await fetch(reviewsUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: reviewHeaders
    });

    if (!response.ok) {
      throw new Error(`Plati reviews HTTP ${response.status}`);
    }

    const html = await response.text();
    const reviews = parsePlatiPublicReviews(html);

    return {
      url: reviewsUrl,
      reviews,
      diagnostics: {
        bytes: Buffer.byteLength(html, 'utf8'),
        hasReviewBody: /\bdigi-er-body\b/i.test(html),
        hasReviewDataType: /data-tr-type=["']review["']/i.test(html),
        hasDataTrId: /data-tr-id=["'][^"']+["']/i.test(html),
        hasListItem: /<li\b/i.test(html),
        cookieBootstrap: Boolean(cookieHeader)
      }
    };
  } finally {
    clearTimeout(timer);
  }
}


function stripSteamHtml(value) {
  return decodeHtmlAttr(
    String(value || '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function steamLanguageCellChecked(cellHtml) {
  const cell = String(cellHtml || '');
  return (
    /\bcheckmark\b/i.test(cell) ||
    /(?:&#10003;|&#x2713;|✓)/i.test(cell) ||
    /(?:icon_check|ico_check)/i.test(cell)
  );
}

function parseSteamRussianLanguageTable(html) {
  const source = String(html || '');
  const tables = source.match(/<table\b[\s\S]*?<\/table>/gi) || [];

  for (const table of tables) {
    if (!/game_language_options|Full Audio|Subtitles|Interface/i.test(table)) continue;

    const rows = table.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
      const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map(match => match[1]);

      if (cells.length < 2) continue;

      const languageName = stripSteamHtml(cells[0]);
      if (!/^Russian$/i.test(languageName) && !/^Русский$/i.test(languageName)) continue;

      return {
        russian: true,
        interface: cells.length > 1 ? steamLanguageCellChecked(cells[1]) : null,
        audio: cells.length > 2 ? steamLanguageCellChecked(cells[2]) : null,
        subtitles: cells.length > 3 ? steamLanguageCellChecked(cells[3]) : null,
        detailed: cells.length >= 4,
        source: 'steam-store-language-table'
      };
    }

    // We found the language table but it contained no Russian row.
    if (/game_language_options|Full Audio|Subtitles|Interface/i.test(table)) {
      return {
        russian: false,
        interface: false,
        audio: false,
        subtitles: false,
        detailed: true,
        source: 'steam-store-language-table'
      };
    }
  }

  return null;
}

function parseSteamSupportedLanguages(raw) {
  const value = String(raw || '');
  if (!value.trim()) return null;

  const russian = /\bRussian\b/i.test(value);
  const audio =
    /\bRussian\s*(?:<[^>]+>\s*)*\*/i.test(value) ||
    /\bRussian\s*<strong>\s*\*\s*<\/strong>/i.test(value);

  return {
    russian,
    interface: russian ? null : false,
    subtitles: russian ? null : false,
    audio: russian ? audio : false,
    detailed: false,
    source: 'steam-appdetails-supported-languages'
  };
}

async function getSteamRussianLocalization(appId) {
  appId = String(appId || '').trim();
  if (!/^\d+$/.test(appId)) throw new Error('Invalid Steam AppID');

  const cached = steamLocalizationCache.get(appId);
  if (cached && Date.now() - cached.savedAt < STEAM_LOCALIZATION_CACHE_MS) {
    return cached.value;
  }

  let localization = null;

  // First choice: Steam's language table gives Interface / Full Audio / Subtitles separately.
  for (const cc of ['us', 'ru', 'kz']) {
    try {
      const html = await fetchText(
        `https://store.steampowered.com/app/${appId}/?l=english&cc=${cc}`
      );
      localization = parseSteamRussianLanguageTable(html);
      if (localization) break;
    } catch (_) {}
  }

  // Fallback: appdetails confirms Russian support and marks languages with full audio.
  if (!localization) {
    try {
      const data = await fetchJson(
        `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=us&l=english&filters=supported_languages`
      );
      const entry = data?.[appId];
      if (entry?.success) {
        localization = parseSteamSupportedLanguages(entry?.data?.supported_languages);
      }
    } catch (_) {}
  }

  const value = {
    available: Boolean(localization),
    appId: Number(appId),
    localization: localization || null
  };

  steamLocalizationCache.set(appId, { savedAt: Date.now(), value });
  return value;
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

  // IMPORTANT: AppID and PackageID live in different Steam ID namespaces.
  // Never try the same numeric ID in the other endpoint: an AppID with no price
  // can accidentally match a completely unrelated Steam package with the same number.
  // The matcher/admin must explicitly store the correct type.
  for (const cc of order) {
    try {
      const info = type === 'package'
        ? await getPackagePrice(id, cc)
        : await getAppPrice(id, cc);

      if (info) return await withRub(info);
    } catch (_) {}
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

  if (url.pathname === '/api/product-reviews' && req.method === 'GET') {
    const productId = String(url.searchParams.get('productId') || '').trim();
    const page = Math.max(1, Number(url.searchParams.get('page') || 1));
    const rows = Math.min(50, Math.max(1, Number(url.searchParams.get('rows') || 20)));

    if (!/^\d+$/.test(productId)) {
      return json(res, 400, { ok: false, error: 'Valid productId is required' });
    }

    try {
      const product = await getDigisellerProductDetails(productId);
      const sellerId = String(product?.seller?.id || '').trim();

      if (!/^\d+$/.test(sellerId)) {
        return json(res, 404, { ok: false, error: 'Seller ID is unavailable for this product' });
      }

      const statsGood = Math.max(0, Number(product?.statistics?.goodReviews || 0));
      const statsBad = Math.max(0, Number(product?.statistics?.badReviews || 0));
      const statsTotal = statsGood + statsBad;

      let publicResult;
      try {
        publicResult = await getPlatiPublicReviews({
          productId,
          sellerId,
          page,
          rows,
          productUrl: product?.productUrl || ''
        });
      } catch (err) {
        return json(res, 200, {
          ok: true,
          source: 'digiseller-statistics',
          productId,
          sellerId,
          totalItems: statsTotal,
          totalGood: statsGood,
          totalBad: statsBad,
          textItems: 0,
          reviews: [],
          publicReviewsError: err.message
        });
      }

      const seen = new Set();
      const reviews = [];

      for (const review of publicResult.reviews || []) {
        const key = `${review.id}:${review.date}:${review.info}`;
        if (seen.has(key)) continue;
        seen.add(key);
        reviews.push(review);
      }

      return json(res, 200, {
        ok: true,
        source: 'plati-public-html',
        productId,
        sellerId,
        totalItems: statsTotal || reviews.length,
        totalGood: statsGood || reviews.filter(r => r.type === 'good').length,
        totalBad: statsBad || reviews.filter(r => r.type === 'bad').length,
        textItems: reviews.length,
        reviews: reviews.slice(0, rows),
        diagnostics: publicResult.diagnostics
      });
    } catch (err) {
      return json(res, 502, {
        ok: false,
        error: err.message
      });
    }
  }

  if (url.pathname === '/api/product-details' && req.method === 'GET') {
    const productId = String(url.searchParams.get('productId') || '').trim();
    if (!/^\d+$/.test(productId)) {
      return json(res, 400, { ok: false, error: 'Valid productId is required' });
    }

    try {
      const product = await getDigisellerProductDetails(productId);
      return json(res, 200, {
        ok: true,
        product
      });
    } catch (err) {
      return json(res, 502, {
        ok: false,
        error: err.message
      });
    }
  }

  if (url.pathname === '/api/steam-matches') {
    const sync = await runAutomaticMatchSync(false);
    return json(res, 200, {
      version: 2,
      matches: readMatches(),
      autoSync: {
        ok: sync?.ok !== false,
        lastSyncAt: autoMatchLastSyncAt || null,
        inherited: Number(sync?.inherited || 0),
        steamSearchMatched: Number(sync?.steamSearchMatched || 0),
        ignored: Array.isArray(sync?.ignored) ? sync.ignored.length : 0,
        unresolved: Array.isArray(sync?.unresolved) ? sync.unresolved.length : 0
      }
    });
  }




  if (url.pathname === '/api/admin/apply-match-candidate' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;

    try {
      const body = await readJsonBody(req, 64 * 1024);
      const productId = String(body.productId || '').trim();
      const sourceProductId = String(body.sourceProductId || '').trim();

      if (!productId || !sourceProductId) {
        return adminJson(res, 400, { ok: false, error: 'productId and sourceProductId are required' });
      }

      const matches = readSteamMatchesFile();
      const source = matches[sourceProductId];
      if (!source?.steamId) {
        return adminJson(res, 404, { ok: false, error: 'Source Steam mapping not found' });
      }

      const catalog = await fetchDigisellerCatalog();
      const product = catalog.find(x => String(x.id) === productId);
      if (!product) {
        return adminJson(res, 404, { ok: false, error: 'Current Digiseller product not found' });
      }

      matches[productId] = {
        type: source.type === 'package' ? 'package' : 'app',
        steamId: String(source.steamId),
        title: String(product.name || source.title || ''),
        region: 'ru',
        savedAt: new Date().toISOString(),
        coverMode: source.coverMode || 'steam',
        ...(source.coverAppId ? { coverAppId: String(source.coverAppId) } : {}),
        ...(source.coverUrl ? { coverUrl: String(source.coverUrl) } : {}),
        ...(source.coverSource ? { coverSource: String(source.coverSource) } : {}),
        autoMatched: false,
        matchSource: 'admin-candidate',
        matchedFromProductId: sourceProductId,
        matchConfidence: 1
      };

      writeSteamMatchesFile(matches);
      autoMatchLastSyncAt = 0;

      return adminJson(res, 200, {
        ok: true,
        productId,
        item: matches[productId]
      });
    } catch (err) {
      return adminJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (url.pathname === '/api/admin/sync-digiseller' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const report = await runAutomaticMatchSync(true);
    return adminJson(res, report.ok === false ? 502 : 200, report);
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

  if (url.pathname === '/api/steam-localization' && req.method === 'GET') {
    const appid = String(url.searchParams.get('appid') || '').trim();
    const packageid = String(url.searchParams.get('packageid') || '').trim();

    let appId = null;

    if (/^\d+$/.test(appid)) {
      appId = appid;
    } else if (/^\d+$/.test(packageid)) {
      appId = await resolvePackageAppId(packageid);
    }

    if (!appId) {
      return json(res, 400, {
        available: false,
        error: 'Нужен appid или packageid, который можно сопоставить с AppID'
      });
    }

    try {
      const result = await getSteamRussianLocalization(appId);
      return json(res, 200, result);
    } catch (err) {
      return json(res, 200, {
        available: false,
        appId: Number(appId),
        error: err.message
      });
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
