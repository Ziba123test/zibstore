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
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); }
      catch (_) { return _; }
    })
    .replace(/&#([0-9]+);?/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); }
      catch (_) { return _; }
    })
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



function isMixedCisToken(value) {
  const token = String(value || '').normalize('NFKC').toLowerCase();

  // Sellers frequently mix Latin and Cyrillic lookalikes in СНГ/CIS markers:
  // СНГ, CНГ, СHG, CHГ, CНG, СHГ, etc. Treat all C/С + H/Н + G/Г
  // combinations as the same seller-region token.
  return /^[cс][hн][gг]$/u.test(token);
}

function collapseTranslatedSellerAlias(value) {
  let s = String(value || '');

  // Sellers sometimes write a localized DLC/subtitle immediately followed by
  // its official English Steam name, e.g.:
  //   «Откровения» (Revelations)
  // Keeping both halves hurts exact Steam matching even though they refer to
  // the same title. Only collapse the pair when the quoted part contains
  // Cyrillic and the parenthesized alias contains Latin letters.
  s = s.replace(
    /[«“"]([^»”"]*[\p{Script=Cyrillic}][^»”"]*)[»”"]\s*\(\s*([A-Za-z][A-Za-z0-9:'’&.\- ]{1,80})\s*\)/gu,
    ' $2 '
  );

  return s;
}

function cleanSalesTitle(value) {
  const rawTitle = collapseTranslatedSellerAlias(value);
  const hadPercent = rawTitle.includes('%');

  let s = rawTitle
    // Seller-only release-year disambiguator, e.g. "Fable (2027)".
    // Do this before parentheses are converted into spaces below.
    .replace(/\((?:19|20)\d{2}\)/g, ' ')

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
    /стандарт[а-яё]*\s+издани[а-яё]*/giu,
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
    // Removing ™/® can leave a space before punctuation (\"War™:\" -> \"War :\").
    // Canonicalize colon spacing so seller and Steam titles normalize identically.
    .replace(/\s*:\s*/g, ': ')
    .replace(/\s+/g, ' ')
    .trim();

  const noiseTokens = new Set([
    'steam','gift','key','auto','autodelivery',
    'dlc','addon','add-on','expansion',
    'авто','автодоставка','ключ','гифт','подарок','бонус',
    'дополнение','дополнения','доп',
    'россия','мир','снг','рф','ру','уа','укр','украина',
    'ru','rf','ua','ukr','ukraine','by','kz','tr','ar','cis','latam',
    'кз','тр','ар','латам',
    'chг','chн','снg','снг',
    'world','global','worldwide',
    'digital','цифровой','цифровая','цифровое','цифровые',
    'электронный','электронная','электронное','электронные',
    'tm','sm',
    'standard','edition','издание','издания','издании','изданием'
  ]);

  const tokens = s
    .split(/\s+/)
    .filter(token => token && !noiseTokens.has(token) && !isMixedCisToken(token));

  // A percentage may be written with unusual spacing and lose the '%' during cleanup.
  // Remove a lone trailing small numeric token only when the rest already looks like a title.
  if (hadPercent && tokens.length >= 3 && /^\d{1,2}$/.test(tokens[tokens.length - 1])) {
    tokens.pop();
  }

  return tokens.join(' ').trim();
}

function editionInfo(value) {
  const s = String(value || '').toLowerCase();
  const tags = [
    ['super_deluxe', /\bsuper\s+deluxe\b|супер\s+делюкс/iu],
    ['premium', /\bpremium\b|премиум/iu],
    ['deluxe', /\bdeluxe\b|делюкс/iu],
    ['ultimate', /\bultimate\b|ультимейт/iu],
    ['gold', /\bgold\b|золот(?:ое|ой|ая|ые)?(?:\s+издани[ея])?/iu],
    ['complete', /\bcomplete\b/i],
    ['collector', /\bcollector'?s?\b/i],
    ['definitive', /\bdefinitive\b/i],
    ['commander', /\bcommander(?:\s+edition)?\b/i],
    ['devout', /\bdevout(?:\s+edition)?\b/i],
    ['eclipse', /\beclipse(?:\s+edition)?\b/i],
    ['anniversary', /\banniversary\b/i],
    ['goty', /\bgoty\b|\bgame\s+of\s+the\s+year\b/i],
    ['special', /\bspecial(?:\s+edition)?\b/i],
    ['limited', /\blimited(?:\s+edition)?\b/i],
    ['divine', /\bdivine(?:\s+edition)?\b/i],
    ['eternal', /\beternal(?:\s+edition)?\b/i],
    ['bundle', /\bbundle\b/i],
    ['standard', /\bstandard(?:\s+edition)?\b|стандарт[а-яё]*(?:\s+издани[а-яё]*)?/iu]
  ];
  const hit = tags.find(([, re]) => re.test(s));
  return { tag: hit ? hit[0] : null, flexible: /выбор\s+издания/i.test(s) };
}

function baseGameTitle(value) {
  return cleanSalesTitle(value)
    .replace(/\bgame\s+of\s+the\s+year\b/gi, ' ')
    .replace(/\b(?:super\s+deluxe|premium|deluxe|ultimate|gold|complete|collector'?s?|definitive|commander|devout|eclipse|anniversary|goty|special|limited|divine|eternal|bundle)(?:\s+edition)?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Comparison-only canonical form. Seller titles frequently omit punctuation that
// Steam uses as a franchise separator:
//   "Middle-earth Shadow of War" vs "Middle-earth: Shadow of War"
// The colon must not make these look like different games.
function canonicalBaseGameTitle(value) {
  return baseGameTitle(value)
    .replace(/:+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleTokens(value) {
  return new Set(canonicalBaseGameTitle(value).split(/\s+/).filter(x => x.length > 1));
}

function titleSimilarity(a, b) {
  const aa = canonicalBaseGameTitle(a);
  const bb = canonicalBaseGameTitle(b);
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

function titleInitialismAlias(a, b) {
  const A = String(a || '').split(/\s+/).filter(Boolean);
  const B = String(b || '').split(/\s+/).filter(Boolean);
  if (!A.length || !B.length) return false;

  let shared = 0;
  while (shared < A.length && shared < B.length && A[shared] === B[shared]) shared++;

  // Require a real shared franchise/base prefix. This keeps the alias narrow and
  // prevents unrelated short acronyms from matching arbitrary titles.
  if (shared < 1) return false;

  const left = A.slice(shared);
  const right = B.slice(shared);

  const matches = (words, acronymTokens) => {
    if (words.length < 2 || acronymTokens.length !== 1) return false;
    const acronym = acronymTokens[0];
    if (!/^[a-z0-9]{2,8}$/i.test(acronym)) return false;
    const initialism = words.map(word => word[0] || '').join('');
    return initialism === acronym;
  };

  return matches(left, right) || matches(right, left);
}

function baseTitlesEquivalent(a, b) {
  const aa = canonicalBaseGameTitle(a);
  const bb = canonicalBaseGameTitle(b);
  if (!aa || !bb) return false;
  if (aa === bb) return true;

  // Steam occasionally shortens a subtitle to an initialism in package names.
  // Example: "Onimusha: Way of the Sword" <-> "Onimusha: WotS".
  if (titleInitialismAlias(aa, bb)) return true;

  // Steam occasionally appends a non-commercial descriptor to the base app
  // while sellers keep the cleaner retail title. Treat only known-safe aliases
  // as the same base game. This is intentionally conservative.
  const softSuffixes = ['remake'];
  return softSuffixes.some(suffix =>
    aa === `${bb} ${suffix}` || bb === `${aa} ${suffix}`
  );
}


function canonicalCommerceTitle(value) {
  return cleanSalesTitle(value)
    .replace(/:+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function namedPackageInfo(value) {
  const s = canonicalCommerceTitle(value);
  const tags = [
    ['trilogy', /\btrilogy\b/i],
    ['collection', /\bcollection\b/i],
    ['anthology', /\banthology\b/i],
    ['compilation', /\bcompilation\b/i],
    ['franchise-pack', /\bfranchise\s+pack\b/i]
  ];
  const hit = tags.find(([, re]) => re.test(s));
  return { tag: hit ? hit[0] : null };
}

function isNamedCollectionPackage(value) {
  return Boolean(namedPackageInfo(value).tag);
}

function collectionSuffixAliasMatch(a, b) {
  const aa = canonicalCommerceTitle(a);
  const bb = canonicalCommerceTitle(b);
  if (!aa || !bb || aa === bb) return false;

  // Some sellers omit the final commercial descriptor even though Steam names
  // the complete package "... Collection". Keep this alias deliberately narrow:
  // only one exact trailing word may differ, and final package validation still
  // requires the package to contain the anchor/base app.
  return aa === `${bb} collection` || bb === `${aa} collection`;
}

function packageTitleSimilarity(a, b) {
  const aa = canonicalCommerceTitle(a);
  const bb = canonicalCommerceTitle(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;

  const A = new Set(aa.split(/\s+/).filter(x => x.length > 1));
  const B = new Set(bb.split(/\s+/).filter(x => x.length > 1));
  if (!A.size || !B.size) return 0;

  let intersection = 0;
  for (const t of A) if (B.has(t)) intersection++;
  const union = new Set([...A, ...B]).size;
  const jaccard = union ? intersection / union : 0;
  const containment = intersection / Math.min(A.size, B.size);
  const contains = aa.includes(bb) || bb.includes(aa) ? 0.08 : 0;

  return Math.min(1, (jaccard * 0.58) + (containment * 0.34) + contains);
}

function steamSearchTermVariants(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];

  const plain = raw
    .replace(/[:'&.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = plain.split(/\s+/).filter(Boolean);
  const softAlias = plain
    .replace(/\b(?:remake|enhanced)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const variants = [raw, plain, softAlias];

  // Steam storesearch can be surprisingly sensitive to punctuation/franchise
  // prefixes. A shorter tail query fixes titles such as
  // "Middle-earth: Shadow of War" without weakening final matching rules.
  if (tokens.length >= 4) variants.push(tokens.slice(-4).join(' '));
  if (tokens.length >= 5) variants.push(tokens.slice(-3).join(' '));

  return [...new Set(variants.filter(x => x && x.length >= 3))].slice(0, 5);
}



function hasDlcTitleLabel(title) {
  const name = String(title || '').normalize('NFKC').toLowerCase();
  // Ignore bundle wording, e.g. "Game + DLC" or "Game includes DLC".
  // Check the title only; descriptions often mention optional add-ons.
  const standalone = name.replace(
    /(?:[+＋]|\b(?:includes?|including|with|and)\b|включая|включает|\sс\s)\s*(?:(?:all|все|\d+)\s+)?dlc\b/giu,
    ' '
  );
  return /(?:^|[^\p{L}\p{N}_])dlc(?:$|[^\p{L}\p{N}_])/iu.test(standalone)
    || /\bdownloadable\s+content\b/i.test(standalone);
}

function isDlcDigisellerProduct(product) {
  const category = String(product?.categoryName || product?._categoryName || '')
    .normalize('NFKC')
    .toLowerCase();
  const name = String(product?.name || '')
    .normalize('NFKC')
    .toLowerCase();

  return (
    /дополн/iu.test(category) ||
    /\bdlc\b/i.test(category) ||
    /\badd[\s-]?on\b/i.test(category) ||
    /\bexpansion\b/i.test(category) ||
    hasDlcTitleLabel(name) ||
    /\bdownloadable\s+content\b/i.test(name)
  );
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

    const sameBase = baseTitlesEquivalent(product.name, item.title);
    const score = sameBase ? 1 : titleSimilarity(product.name, item.title);
    const editionOk = editionsCompatible(product.name, item.title);

    candidates.push({
      oldProductId: String(oldProductId),
      steamId: String(item.steamId),
      type: item.type === 'package' ? 'package' : 'app',
      knownTitle: String(item.title),
      normalizedKnownTitle: canonicalBaseGameTitle(item.title),
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

function shouldRematchVirtualPaidEdition(product, matches) {
  if (!product?.isEditionVariant || !product?.sourceProductId) return false;

  const tag = String(product.editionVariantTag || editionInfo(product.name).tag || '');
  if (!tag || tag === 'standard') return false;

  const current = matches?.[String(product.id)];
  if (!current?.steamId) return false;

  // A paid/special edition represented as a Digiseller virtual variant should
  // normally compare against a Steam package/SubID, not the base AppID. Older
  // builds could save the parent's base-app match before the variant tag was
  // recognized correctly (e.g. Super Deluxe -> Borderlands 4 base app).
  if (current.type !== 'package') return true;

  // If both parent and child point to the exact same Steam target, the child did
  // not get an edition-specific package. Re-evaluate it conservatively.
  const parent = matches?.[String(product.sourceProductId)];
  if (parent?.steamId &&
      String(parent.type || 'app') === String(current.type || 'app') &&
      String(parent.steamId) === String(current.steamId)) {
    return true;
  }

  return false;
}

function isVirtualPaidEdition(product) {
  if (!product?.isEditionVariant) return false;
  const tag = String(product.editionVariantTag || editionInfo(product.name).tag || '');
  return Boolean(tag && tag !== 'standard');
}

function cloneDefaultVariantParentMatch(product, matches) {
  if (!product?.isEditionVariant || !product?.sourceProductId) return null;

  const editionTag = String(product.editionVariantTag || editionInfo(product.name).tag || '');
  const isDefaultVariant = Boolean(product.editionVariantDefault) || editionTag === 'standard';
  if (!isDefaultVariant) return null;

  const parentId = String(product.sourceProductId);
  const source = matches?.[parentId];
  if (!source?.steamId) return null;

  return {
    type: source.type === 'package' ? 'package' : 'app',
    steamId: String(source.steamId),
    title: String(product.name || source.title || ''),
    region: 'ru',
    savedAt: new Date().toISOString(),
    coverMode: source.coverMode || 'steam',
    ...(source.coverAppId ? { coverAppId: String(source.coverAppId) } : {}),
    ...(source.coverUrl ? { coverUrl: String(source.coverUrl) } : {}),
    ...(source.coverSource ? { coverSource: String(source.coverSource) } : {}),
    autoMatched: true,
    matchSource: 'parent-default-variant',
    matchedFromProductId: parentId,
    matchConfidence: 1
  };
}

function cloneHistoricalMatch(product, matches) {
  const wantedEdition = String(product?.editionVariantTag || editionInfo(product?.name).tag || '');
  const paidVirtualEdition = isVirtualPaidEdition(product);

  const candidates = historicalCandidates(product, matches, 20)
    .filter(c => {
      if (!c.editionCompatible) return false;

      // Never let a paid virtual edition inherit the parent's/base AppID just
      // because the parent title says "Выбор издания". That was the cause of
      // Super Deluxe Borderlands showing the Standard Steam price.
      if (paidVirtualEdition) {
        if (c.type !== 'package') return false;
        const source = matches?.[c.oldProductId] || {};
        const sourceEdition = String(source.packageEdition || editionInfo(source.title || c.knownTitle).tag || '');
        if (!sourceEdition || sourceEdition !== wantedEdition) return false;
      }

      return true;
    });

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
  const queries = steamSearchTermVariants(term);
  if (!queries.length) return [];

  const seen = new Set();
  const out = [];

  for (const q of queries) {
    try {
      const data = await fetchJson(
        `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&l=english&cc=us`
      );
      for (const item of Array.isArray(data?.items) ? data.items : []) {
        const id = String(item?.id || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(item);
      }
    } catch (_) {}

    // Once an exact-looking result is present, extra fallback requests are not
    // useful. The caller still applies strict title/edition checks.
    if (out.some(item => baseTitlesEquivalent(term, item?.name))) break;
  }

  return out;
}


async function getSteamAppDetails(appId, filters = '') {
  appId = String(appId || '').trim();
  if (!/^\d+$/.test(appId)) return null;

  const suffix = filters ? `&filters=${encodeURIComponent(filters)}` : '';
  for (const cc of ['us', 'kz', 'ru']) {
    try {
      const data = await fetchJson(
        `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${cc}&l=english${suffix}`
      );
      const entry = data?.[appId];
      if (entry?.success && entry?.data) return entry.data;
    } catch (_) {}
  }

  return null;
}

async function getSteamPackageDetails(packageId) {
  packageId = String(packageId || '').trim();
  if (!/^\d+$/.test(packageId)) return null;

  for (const cc of ['us', 'kz', 'ru']) {
    try {
      const data = await fetchJson(
        `https://store.steampowered.com/api/packagedetails?packageids=${packageId}&cc=${cc}&l=english`
      );
      const entry = data?.[packageId];
      if (entry?.success && entry?.data) return entry.data;
    } catch (_) {}
  }

  return null;
}

function steamPackageApps(data) {
  return (Array.isArray(data?.apps) ? data.apps : [])
    .map(x => ({
      id: String(x?.id ?? x?.appid ?? '').trim(),
      name: String(x?.name || '').trim()
    }))
    .filter(x => /^\d+$/.test(x.id));
}

function bestPackageCoverAppId(productTitle, apps, fallbackAppId = '') {
  const list = Array.isArray(apps) ? apps : [];
  if (!list.length) return /^\d+$/.test(String(fallbackAppId || '')) ? String(fallbackAppId) : '';

  const ranked = list
    .map(app => ({
      ...app,
      exactBase: baseTitlesEquivalent(productTitle, app.name),
      score: titleSimilarity(productTitle, app.name)
    }))
    .sort((a, b) => {
      if (a.exactBase !== b.exactBase) return a.exactBase ? -1 : 1;
      return b.score - a.score;
    });

  const best = ranked[0];
  if (best && (best.exactBase || best.score >= 0.90)) return best.id;
  if (/^\d+$/.test(String(fallbackAppId || ''))) return String(fallbackAppId);
  return best?.id || '';
}

function historicalBaseAppCandidate(product, matches) {
  if (!matches || typeof matches !== 'object') return null;

  const sameBase = historicalCandidates(product, matches, 30)
    .filter(c => c.exactNormalized && c.type === 'app');
  if (!sameBase.length) return null;

  const ids = new Set(sameBase.map(c => String(c.steamId)));
  if (ids.size !== 1) return null;

  const best = sameBase[0];
  const source = matches?.[best.oldProductId] || {};
  return {
    appId: String(best.steamId),
    name: String(source.steamSearchName || best.knownTitle || product.name || ''),
    score: 1,
    exactBase: true,
    clear: true,
    query: canonicalBaseGameTitle(product?.name),
    source: 'history-base-app'
  };
}

async function findSteamBaseAppCandidate(product, matches = null) {
  const query = canonicalBaseGameTitle(product?.name);
  if (!query || query.length < 3) return null;

  // If another edition of the same game is already mapped to an AppID, reuse
  // that AppID as the package-search anchor. This avoids needless Steam search
  // ambiguity for Standard -> Deluxe/Ultimate transitions.
  const historical = historicalBaseAppCandidate(product, matches);
  if (historical) return historical;

  const items = await steamStoreSearch(query);
  const scored = [];

  for (const item of items.slice(0, 24)) {
    if (!item?.id || !item?.name) continue;
    const exactBase = baseTitlesEquivalent(product.name, item.name);
    const score = exactBase ? 1 : titleSimilarity(product.name, item.name);
    if (!exactBase && score < 0.94) continue;
    scored.push({ item, exactBase, score });
  }

  scored.sort((a, b) => {
    if (a.exactBase !== b.exactBase) return a.exactBase ? -1 : 1;
    return b.score - a.score;
  });

  const best = scored[0];
  const second = scored[1];
  if (!best) return null;

  const exactCount = scored.filter(x => x.exactBase).length;
  const clear = best.exactBase
    ? exactCount === 1 || scored.filter(x => x.exactBase).every(x => String(x.item.id) === String(best.item.id))
    : best.score >= 0.985 && (best.score - (second?.score || 0)) >= 0.10;

  return {
    appId: String(best.item.id),
    name: String(best.item.name),
    score: Math.round(best.score * 1000) / 1000,
    exactBase: best.exactBase,
    clear,
    query
  };
}


async function packageIdsForAnchorApp(appId, productTitle = '') {
  let appDetails = await getSteamAppDetails(appId, 'packages');
  if (!appDetails) return [];

  const filteredHasPackages =
    (Array.isArray(appDetails.packages) && appDetails.packages.length) ||
    (Array.isArray(appDetails.package_groups) && appDetails.package_groups.length);
  if (!filteredHasPackages) {
    appDetails = await getSteamAppDetails(appId) || appDetails;
  }

  const hints = new Map();
  for (const group of Array.isArray(appDetails.package_groups) ? appDetails.package_groups : []) {
    for (const sub of Array.isArray(group?.subs) ? group.subs : []) {
      const id = String(sub?.packageid || '').trim();
      if (!/^\d+$/.test(id)) continue;
      hints.set(id, {
        optionText: String(sub?.option_text || '').trim(),
        optionDescription: String(sub?.option_description || '').trim()
      });
    }
  }

  const packageIds = [];
  const pushId = id => {
    id = String(id || '').trim();
    if (/^\d+$/.test(id) && !packageIds.includes(id)) packageIds.push(id);
  };
  for (const id of Array.isArray(appDetails.packages) ? appDetails.packages : []) pushId(id);
  for (const id of hints.keys()) pushId(id);

  // Store-visible package-group labels are the strongest cheap hint. Put likely
  // matches first so we do not need to request dozens of unrelated SubIDs.
  packageIds.sort((a, b) => {
    const ah = hints.get(a) || {};
    const bh = hints.get(b) || {};
    const at = `${ah.optionText || ''} ${ah.optionDescription || ''}`.trim();
    const bt = `${bh.optionText || ''} ${bh.optionDescription || ''}`.trim();
    return packageTitleSimilarity(productTitle, bt) - packageTitleSimilarity(productTitle, at);
  });

  return packageIds.map(id => ({ packageId: id, hint: hints.get(id) || {} }));
}


function isEnhancedVersionTitle(value) {
  return /(?:^|[^a-z0-9])enhanced(?:$|[^a-z0-9])/i.test(String(value || ''));
}

function stripEnhancedVersionTitle(value) {
  return canonicalBaseGameTitle(value)
    .replace(/(?:^|\s)enhanced(?:\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function discoverEnhancedSiblingApp(product, matches = null) {
  if (!isEnhancedVersionTitle(product?.name)) return null;

  const wanted = canonicalBaseGameTitle(product?.name);
  const baseQuery = stripEnhancedVersionTitle(product?.name);
  if (!wanted || !baseQuery || wanted === baseQuery) return null;

  const anchors = [];
  const seenAnchors = new Set();
  const pushAnchor = (appId, name = '', source = '') => {
    appId = String(appId || '').trim();
    if (!/^\d+$/.test(appId) || seenAnchors.has(appId)) return;
    seenAnchors.add(appId);
    anchors.push({ appId, name: String(name || ''), source });
  };

  // Reuse an already-known base/Legacy app only as a discovery anchor. It is
  // never accepted as the final target for an Enhanced product.
  for (const [, item] of Object.entries(matches || {})) {
    if (!item?.steamId || item.type === 'package') continue;
    const known = canonicalBaseGameTitle(item.steamSearchName || item.title || '');
    if (known === baseQuery || known === `${baseQuery} legacy`) {
      pushAnchor(item.steamId, item.steamSearchName || item.title, 'history');
    }
    if (anchors.length >= 4) break;
  }

  const searchItems = await steamStoreSearch(baseQuery);
  const directExactApps = new Map();
  for (const item of searchItems.slice(0, 16)) {
    if (!item?.id || !item?.name) continue;
    const name = canonicalBaseGameTitle(item.name);

    // A broader base-title search sometimes returns the Enhanced app even when
    // searching for the full "... Enhanced" phrase does not.
    if (name === wanted) {
      directExactApps.set(String(item.id), { appId: String(item.id), name: String(item.name) });
    }

    // Steam may expose the previous build as "... Legacy" while the Enhanced
    // app is bundled with it. Legacy is accepted only as an anchor here.
    if (name === baseQuery || name === `${baseQuery} legacy`) {
      pushAnchor(item.id, item.name, 'steam-search-base');
    }
    if (anchors.length >= 6) break;
  }

  if (directExactApps.size === 1) return [...directExactApps.values()][0];

  const exactApps = new Map();
  for (const anchor of anchors.slice(0, 6)) {
    const packageRefs = await packageIdsForAnchorApp(anchor.appId, product.name);
    for (const ref of packageRefs.slice(0, 30)) {
      const details = await getSteamPackageDetails(ref.packageId);
      if (!details) continue;
      for (const app of steamPackageApps(details)) {
        if (canonicalBaseGameTitle(app.name) !== wanted) continue;
        exactApps.set(app.id, { appId: app.id, name: app.name, anchorAppId: anchor.appId });
      }
    }
  }

  // Do not guess if several different exact Enhanced apps exist.
  if (exactApps.size !== 1) return null;
  return [...exactApps.values()][0];
}

async function matchEnhancedSiblingApp(product, matches = null) {
  const found = await discoverEnhancedSiblingApp(product, matches);
  if (!found) return null;

  return {
    type: 'app',
    steamId: String(found.appId),
    title: String(product.name || found.name),
    region: 'ru',
    savedAt: new Date().toISOString(),
    coverMode: 'steam',
    autoMatched: true,
    matchSource: 'steam-enhanced-sibling',
    steamSearchName: String(found.name),
    steamProductType: 'app',
    categoryName: String(product.categoryName || ''),
    matchConfidence: 1
  };
}

async function findNamedPackageAnchorApps(product, matches = null) {
  const anchors = [];
  const seen = new Set();

  const push = (appId, name = '', score = 0, source = '') => {
    appId = String(appId || '').trim();
    if (!/^\d+$/.test(appId) || seen.has(appId)) return;
    seen.add(appId);
    anchors.push({
      appId,
      name: String(name || `App ${appId}`),
      score: Number(score || 0),
      source
    });
  };

  // Existing verified mappings are excellent anchors for a franchise package.
  // We do NOT auto-bind to them directly; they are used only to enumerate Steam
  // packages, and the final package title still has to match the seller title.
  for (const c of historicalCandidates(product, matches, 20)) {
    if (c.type !== 'app' || Number(c.score || 0) < 0.50) continue;
    const source = matches?.[c.oldProductId] || {};
    push(c.steamId, source.steamSearchName || c.knownTitle, c.score, 'history');
    if (anchors.length >= 4) break;
  }

  // If history is thin, let Steam search suggest additional apps from the same
  // franchise. A weak anchor is safe because package acceptance below is exact.
  const query = canonicalCommerceTitle(product?.name);
  const searchItems = await steamStoreSearch(query);
  for (const item of searchItems.slice(0, 12)) {
    if (!item?.id || !item?.name) continue;
    const score = packageTitleSimilarity(product.name, item.name);
    if (score < 0.45) continue;
    push(item.id, item.name, score, 'steam-search');
    if (anchors.length >= 6) break;
  }

  // If a seller title is a commercial subtitle (for example
  // "Diablo IV: Age of Hatred") Steam search may not return the base app for
  // the full phrase. The franchise prefix before ':' is a safe *anchor only*;
  // the package itself still has to pass exact/Collection-suffix validation.
  if (!anchors.length) {
    const cleaned = cleanSalesTitle(product?.name);
    const colon = cleaned.indexOf(':');
    const prefix = colon > 0 ? cleaned.slice(0, colon).trim() : '';
    if (prefix && prefix.length >= 3 && prefix !== query) {
      const prefixItems = await steamStoreSearch(prefix);
      for (const item of prefixItems.slice(0, 10)) {
        if (!item?.id || !item?.name) continue;
        const prefixBase = canonicalBaseGameTitle(prefix);
        const itemBase = canonicalBaseGameTitle(item.name);
        const exactPrefix = prefixBase && prefixBase === itemBase;
        const score = exactPrefix ? 1 : titleSimilarity(prefix, item.name);
        if (!exactPrefix && score < 0.94) continue;
        push(item.id, item.name, score, 'steam-search-prefix');
        if (anchors.length >= 4) break;
      }
    }
  }

  return anchors;
}

async function discoverNamedPackageCandidates(product, matches = null, { allowImplicitCollection = false } = {}) {
  if (!isNamedCollectionPackage(product?.name) && !allowImplicitCollection) return [];

  const anchors = await findNamedPackageAnchorApps(product, matches);
  if (!anchors.length) return [];

  const packageMap = new Map();

  for (const anchor of anchors.slice(0, 6)) {
    const refs = await packageIdsForAnchorApp(anchor.appId, product.name);

    // 24 per anchor is intentionally bounded. Exact/higher-similarity package
    // group hints are sorted first, and duplicate SubIDs are fetched once.
    for (const ref of refs.slice(0, 24)) {
      const id = String(ref.packageId);
      if (!packageMap.has(id)) {
        packageMap.set(id, {
          packageId: id,
          hint: ref.hint || {},
          anchorAppId: anchor.appId,
          anchorName: anchor.name,
          anchorScore: anchor.score
        });
      }
    }
  }

  const refs = [...packageMap.values()].sort((a, b) => {
    const ah = `${a.hint?.optionText || ''} ${a.hint?.optionDescription || ''}`.trim();
    const bh = `${b.hint?.optionText || ''} ${b.hint?.optionDescription || ''}`.trim();
    return packageTitleSimilarity(product.name, bh) - packageTitleSimilarity(product.name, ah);
  });

  const candidates = [];
  for (const ref of refs.slice(0, 36)) {
    const details = await getSteamPackageDetails(ref.packageId);
    if (!details) continue;

    const apps = steamPackageApps(details);
    if (!apps.some(x => x.id === String(ref.anchorAppId))) continue;

    const name = String(details.name || '').trim();
    const hintText = String(ref.hint?.optionText || '').trim();
    const optionDescription = String(ref.hint?.optionDescription || '').trim();
    const comparedName = name || hintText;
    const score = packageTitleSimilarity(product.name, comparedName);
    const exactTitle =
      canonicalCommerceTitle(product.name) === canonicalCommerceTitle(comparedName) ||
      collectionSuffixAliasMatch(product.name, comparedName) ||
      (hintText && (
        canonicalCommerceTitle(product.name) === canonicalCommerceTitle(hintText) ||
        collectionSuffixAliasMatch(product.name, hintText)
      ));

    const suspicious = /(?:upgrade|soundtrack|commercial\s+license|season\s+pass)/i.test(
      `${name} ${hintText} ${optionDescription}`
    );

    candidates.push({
      type: 'package',
      steamId: String(ref.packageId),
      name: name || hintText || `Package ${ref.packageId}`,
      optionText: hintText,
      apps,
      coverAppId: bestPackageCoverAppId(product.name, apps, ref.anchorAppId),
      anchorAppId: String(ref.anchorAppId),
      anchorName: String(ref.anchorName || ''),
      exactTitle,
      // Reuse the existing admin-card recommendation styling.
      editionMatch: exactTitle,
      exactBase: exactTitle,
      suspicious,
      score: Math.round(score * 1000) / 1000,
      confidence: exactTitle && !suspicious ? 1 : Math.round(score * 1000) / 1000
    });
  }

  return candidates.sort((a, b) => {
    if (a.exactTitle !== b.exactTitle) return a.exactTitle ? -1 : 1;
    if (a.suspicious !== b.suspicious) return a.suspicious ? 1 : -1;
    return b.score - a.score;
  });
}

async function matchNamedPackageFromSteam(product, matches = null, { allowImplicitCollection = false } = {}) {
  const candidates = await discoverNamedPackageCandidates(product, matches, { allowImplicitCollection });
  const valid = candidates.filter(x => x.exactTitle && !x.suspicious);
  if (!valid.length) return null;

  // The same SubID can be discovered through several included apps. After
  // de-duplication there must still be one unambiguous exact package.
  const targets = [...new Set(valid.map(x => String(x.steamId)))];
  if (targets.length !== 1) return null;

  const top = valid.find(x => String(x.steamId) === targets[0]);
  if (!top) return null;

  return {
    type: 'package',
    steamId: String(top.steamId),
    title: String(product.name || top.name),
    region: 'ru',
    savedAt: new Date().toISOString(),
    coverMode: 'steam',
    ...(top.coverAppId ? { coverAppId: String(top.coverAppId) } : {}),
    autoMatched: true,
    matchSource: 'steam-package-named',
    steamSearchName: String(top.name),
    packageKind: namedPackageInfo(product.name).tag || (allowImplicitCollection ? 'collection' : null),
    matchConfidence: 1
  };
}

async function discoverEditionPackageCandidates(product, baseApp) {
  const wantedEdition = editionInfo(product?.name);
  if (!wantedEdition.tag || wantedEdition.tag === 'standard') return [];
  if (!baseApp?.appId) return [];

  let appDetails = await getSteamAppDetails(baseApp.appId, 'packages');
  if (!appDetails) return [];

  const filteredHasPackages =
    (Array.isArray(appDetails.packages) && appDetails.packages.length) ||
    (Array.isArray(appDetails.package_groups) && appDetails.package_groups.length);
  if (!filteredHasPackages) {
    appDetails = await getSteamAppDetails(baseApp.appId) || appDetails;
  }

  const hints = new Map();
  for (const group of Array.isArray(appDetails.package_groups) ? appDetails.package_groups : []) {
    for (const sub of Array.isArray(group?.subs) ? group.subs : []) {
      const id = String(sub?.packageid || '').trim();
      if (!/^\d+$/.test(id)) continue;
      hints.set(id, {
        optionText: String(sub?.option_text || '').trim(),
        optionDescription: String(sub?.option_description || '').trim()
      });
    }
  }

  const packageIds = [];
  const pushId = id => {
    id = String(id || '').trim();
    if (/^\d+$/.test(id) && !packageIds.includes(id)) packageIds.push(id);
  };
  for (const id of Array.isArray(appDetails.packages) ? appDetails.packages : []) pushId(id);
  for (const id of hints.keys()) pushId(id);

  // Keep requests bounded. Matching edition labels from package_groups are checked first.
  packageIds.sort((a, b) => {
    const aa = `${hints.get(a)?.optionText || ''} ${hints.get(a)?.optionDescription || ''}`;
    const bb = `${hints.get(b)?.optionText || ''} ${hints.get(b)?.optionDescription || ''}`;
    const am = editionInfo(aa).tag === wantedEdition.tag ? 1 : 0;
    const bm = editionInfo(bb).tag === wantedEdition.tag ? 1 : 0;
    return bm - am;
  });

  const candidates = [];
  for (const packageId of packageIds.slice(0, 18)) {
    const details = await getSteamPackageDetails(packageId);
    if (!details) continue;

    const apps = steamPackageApps(details);
    const containsBaseApp = apps.some(x => x.id === String(baseApp.appId));
    if (!containsBaseApp) continue;

    const hint = hints.get(packageId) || {};
    const name = String(details.name || '').trim();
    const label = `${name} ${hint.optionText || ''} ${hint.optionDescription || ''}`.trim();
    const packageEdition = editionInfo(label);
    const editionMatch = packageEdition.tag === wantedEdition.tag;
    const exactBase = baseTitlesEquivalent(product.name, name || hint.optionText || '');
    const score = exactBase ? 1 : titleSimilarity(product.name, name || hint.optionText || '');
    const suspicious = /(?:upgrade|soundtrack|commercial\s+license|season\s+pass)/i.test(label);
    const coverAppId = bestPackageCoverAppId(product.name, apps, baseApp.appId);

    candidates.push({
      type: 'package',
      steamId: packageId,
      name: name || hint.optionText || `Package ${packageId}`,
      optionText: hint.optionText || '',
      apps,
      containsBaseApp,
      coverAppId,
      edition: packageEdition,
      editionMatch,
      exactBase,
      suspicious,
      score: Math.round(score * 1000) / 1000,
      confidence: editionMatch && exactBase && !suspicious ? 1 : Math.round(score * 1000) / 1000
    });
  }

  return candidates.sort((a, b) => {
    if (a.editionMatch !== b.editionMatch) return a.editionMatch ? -1 : 1;
    if (a.suspicious !== b.suspicious) return a.suspicious ? 1 : -1;
    if (a.exactBase !== b.exactBase) return a.exactBase ? -1 : 1;
    return b.score - a.score;
  });
}

async function matchEditionPackageFromSteam(product, matches = null) {
  const edition = editionInfo(product?.name);
  if (!edition.tag || edition.tag === 'standard' || edition.flexible) return null;

  const baseApp = await findSteamBaseAppCandidate(product, matches);
  if (!baseApp?.clear) return null;

  const candidates = await discoverEditionPackageCandidates(product, baseApp);
  const valid = candidates.filter(x => x.editionMatch && x.exactBase && !x.suspicious);
  if (!valid.length) return null;

  // Automatic binding is allowed only when one clearly best package remains.
  const top = valid[0];
  const second = valid[1];
  if (second && second.confidence >= top.confidence - 0.02) return null;

  return {
    type: 'package',
    steamId: String(top.steamId),
    title: String(product.name || top.name),
    region: 'ru',
    savedAt: new Date().toISOString(),
    coverMode: 'steam',
    coverAppId: String(top.coverAppId || baseApp.appId),
    autoMatched: true,
    matchSource: 'steam-package-edition',
    steamSearchName: String(top.name),
    steamBaseAppId: String(baseApp.appId),
    steamBaseAppName: String(baseApp.name),
    packageEdition: edition.tag,
    matchConfidence: 1
  };
}


function extractSteamAppIdsFromSellerText(...values) {
  const ids = [];
  const seen = new Set();
  const re = /(?:https?:\/\/)?(?:store\.)?steampowered\.com\/app\/(\d+)(?:[\/?#]|$)/gi;

  for (const value of values) {
    const text = String(value || '');
    let match;
    while ((match = re.exec(text))) {
      const appId = String(match[1] || '').trim();
      if (!/^\d+$/.test(appId) || seen.has(appId)) continue;
      seen.add(appId);
      ids.push(appId);
    }
  }

  return ids;
}

async function sellerSteamAppCandidates(product) {
  const productId = String(product?.sourceProductId || product?.id || '').trim();
  if (!/^\d+$/.test(productId)) return [];

  let details;
  try {
    details = await getDigisellerProductDetails(productId);
  } catch (_) {
    return [];
  }

  const appIds = extractSteamAppIdsFromSellerText(
    details?.info,
    details?.addInfo,
    details?.collection
  );
  if (!appIds.length) return [];

  const dlcProduct = isDlcDigisellerProduct(product);
  const edition = editionInfo(product?.name);
  const paidEdition = !dlcProduct && edition.tag && edition.tag !== 'standard' && !edition.flexible;
  const candidates = [];

  for (const appId of appIds.slice(0, 5)) {
    const steam = await getSteamAppDetails(appId, 'basic');
    if (!steam?.name) continue;

    const storeType = String(steam.type || '').toLowerCase();
    const exactBase = baseTitlesEquivalent(product?.name, steam.name);
    const score = exactBase ? 1 : titleSimilarity(product?.name, steam.name);

    // A direct Steam URL is strong evidence, but paid editions often link to
    // the base game's app page. Use such a link as a base-game hint only; never
    // auto-bind Deluxe/Premium/etc. to the standard app.
    const typeCompatible = dlcProduct
      ? (!storeType || storeType === 'dlc')
      : (!storeType || storeType !== 'dlc');
    const autoSafe = !paidEdition && typeCompatible && (exactBase || score >= 0.97);

    candidates.push({
      type: 'app',
      steamId: appId,
      name: String(steam.name),
      storeType,
      score: Math.round(score * 1000) / 1000,
      confidence: autoSafe ? 1 : Math.round(score * 1000) / 1000,
      exactBase,
      autoSafe,
      source: 'seller-steam-url'
    });
  }

  return candidates.sort((a, b) => {
    if (a.autoSafe !== b.autoSafe) return a.autoSafe ? -1 : 1;
    if (a.exactBase !== b.exactBase) return a.exactBase ? -1 : 1;
    return b.score - a.score;
  });
}

async function matchFromSellerSteamUrl(product) {
  const candidates = await sellerSteamAppCandidates(product);
  const valid = candidates.filter(candidate => candidate.autoSafe);
  if (!valid.length) return null;

  const ids = [...new Set(valid.map(candidate => String(candidate.steamId)))];
  if (ids.length !== 1) return null;

  const best = valid.find(candidate => String(candidate.steamId) === ids[0]);
  if (!best) return null;

  return {
    type: 'app',
    steamId: String(best.steamId),
    title: String(product?.name || best.name),
    region: 'ru',
    savedAt: new Date().toISOString(),
    coverMode: 'steam',
    autoMatched: true,
    matchSource: 'seller-steam-url',
    steamSearchName: String(best.name),
    steamProductType: String(best.storeType || (isDlcDigisellerProduct(product) ? 'dlc' : 'app')),
    categoryName: String(product?.categoryName || ''),
    matchConfidence: 1
  };
}

async function adminSteamCandidates(product, matches = null) {
  const dlcProduct = isDlcDigisellerProduct(product);
  const edition = editionInfo(product?.name);

  if (!dlcProduct && isNamedCollectionPackage(product.name)) {
    const packages = await discoverNamedPackageCandidates(product, matches);
    return {
      mode: 'named-package',
      query: canonicalCommerceTitle(product.name),
      baseApp: null,
      candidates: packages.slice(0, 8)
    };
  }

  if (!dlcProduct && edition.tag && edition.tag !== 'standard' && !edition.flexible) {
    const baseApp = await findSteamBaseAppCandidate(product, matches);
    const packages = baseApp ? await discoverEditionPackageCandidates(product, baseApp) : [];
    return {
      mode: 'edition-package',
      query: baseApp?.query || baseGameTitle(product.name),
      baseApp,
      candidates: packages.slice(0, 8)
    };
  }

  const query = dlcProduct ? cleanSalesTitle(product.name) : canonicalBaseGameTitle(product.name);
  const directCandidates = await sellerSteamAppCandidates(product);
  const items = await steamStoreSearch(query);
  const candidates = items.slice(0, 8).map(item => {
    const score = dlcProduct
      ? (cleanSalesTitle(product.name) === cleanSalesTitle(item.name) ? 1 : titleSimilarity(product.name, item.name))
      : (baseTitlesEquivalent(product.name, item.name) ? 1 : titleSimilarity(product.name, item.name));
    return {
      type: 'app',
      steamId: String(item.id),
      name: String(item.name || ''),
      score: Math.round(score * 1000) / 1000,
      confidence: Math.round(score * 1000) / 1000
    };
  });

  const merged = [];
  const seen = new Set();
  for (const candidate of [...directCandidates, ...candidates]) {
    const key = `${candidate.type}:${candidate.steamId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(candidate);
  }

  let hasStrongApp = merged.some(candidate =>
    candidate.type === 'app' && Number(candidate.confidence ?? candidate.score ?? 0) >= 0.97
  );

  if (!dlcProduct && !hasStrongApp && isEnhancedVersionTitle(product.name)) {
    const enhanced = await discoverEnhancedSiblingApp(product, matches);
    if (enhanced) {
      const key = `app:${enhanced.appId}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.unshift({
          type: 'app',
          steamId: String(enhanced.appId),
          name: String(enhanced.name || product.name),
          score: 1,
          confidence: 1,
          matchSource: 'steam-enhanced-sibling'
        });
      }
      hasStrongApp = true;
    }
  }

  if (!dlcProduct && !edition.tag && !hasStrongApp) {
    const packages = await discoverNamedPackageCandidates(product, matches, { allowImplicitCollection: true });
    const implicit = packages.filter(candidate => candidate.exactTitle && !candidate.suspicious);
    if (implicit.length) {
      return {
        mode: 'named-package',
        query: canonicalCommerceTitle(product.name),
        baseApp: null,
        candidates: implicit.slice(0, 8)
      };
    }
  }

  return { mode: 'app', query, baseApp: null, candidates: merged.slice(0, 8) };
}

async function inspectSteamTarget(product, steamType, steamId, requestedCoverAppId = '') {
  steamType = steamType === 'package' ? 'package' : 'app';
  steamId = String(steamId || '').trim();
  if (!/^\d+$/.test(steamId)) throw new Error('Steam ID должен быть числом');

  if (steamType === 'app') {
    const details = await getSteamAppDetails(steamId);
    if (!details) throw new Error('Steam AppID не найден');
    return {
      type: 'app',
      steamId,
      name: String(details.name || `App ${steamId}`),
      storeType: String(details.type || ''),
      url: `https://store.steampowered.com/app/${steamId}/`,
      coverAppId: ''
    };
  }

  const details = await getSteamPackageDetails(steamId);
  if (!details) throw new Error('Steam Package/SubID не найден');
  const apps = steamPackageApps(details);
  const requested = String(requestedCoverAppId || '').trim();
  const coverAppId = /^\d+$/.test(requested)
    ? requested
    : bestPackageCoverAppId(product?.name || '', apps, '');

  return {
    type: 'package',
    steamId,
    name: String(details.name || `Package ${steamId}`),
    url: `https://store.steampowered.com/sub/${steamId}/`,
    apps,
    coverAppId
  };
}

async function getSteamAppStoreType(appId) {
  appId = String(appId || '').trim();
  if (!/^\d+$/.test(appId)) return null;

  for (const cc of ['us', 'kz', 'ru']) {
    try {
      const data = await fetchJson(
        `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${cc}&l=english&filters=basic`
      );
      const entry = data?.[appId];
      if (entry?.success && entry?.data) {
        return String(entry.data.type || '').toLowerCase() || null;
      }
    } catch (_) {}
  }

  return null;
}


function standardEditionStoreAliasMatch(productTitle, steamTitle) {
  const edition = editionInfo(productTitle);
  if (edition.tag !== 'standard') return false;

  return baseTitlesEquivalent(productTitle, steamTitle);
}

async function matchFromSteamSearch(product, matches = null) {
  const dlcProduct = isDlcDigisellerProduct(product);
  const currentEdition = editionInfo(product.name);

  // Explicit collection names such as "Remake Trilogy" are Steam packages,
  // not apps and not ordinary commercial editions.
  if (!dlcProduct && isNamedCollectionPackage(product.name)) {
    return matchNamedPackageFromSteam(product, matches);
  }

  // For ordinary full games, a paid edition/package still requires conservative
  // matching. For DLC this restriction would incorrectly block products such as
  // "Deluxe Pack", which are themselves separate Steam DLC apps.
  if (!dlcProduct && currentEdition.tag && currentEdition.tag !== 'standard') {
    return matchEditionPackageFromSteam(product, matches);
  }

  // DLC titles should keep words such as "Deluxe"/"Premium" because they may be
  // the actual DLC name. We only remove seller noise (DLC, Gift, regions, etc.).
  const query = dlcProduct
    ? cleanSalesTitle(product.name)
    : canonicalBaseGameTitle(product.name);

  if (!query || query.length < 3) return null;

  const items = await steamStoreSearch(query);
  const scored = [];

  for (const item of items.slice(0, 12)) {
    if (!item?.id || !item?.name) continue;

    const currentNormalized = dlcProduct
      ? cleanSalesTitle(product.name)
      : canonicalBaseGameTitle(product.name);
    const itemNormalized = dlcProduct
      ? cleanSalesTitle(item.name)
      : canonicalBaseGameTitle(item.name);

    const exactBase = currentNormalized === itemNormalized ||
      (!dlcProduct && baseTitlesEquivalent(product.name, item.name));
    const standardAlias =
      !dlcProduct &&
      standardEditionStoreAliasMatch(product.name, item.name);

    const score = (exactBase || standardAlias)
      ? 1
      : titleSimilarity(product.name, item.name);

    if (!exactBase && !standardAlias && score < 0.97) continue;

    // A product from the "Дополнения Steam" category must resolve to an actual
    // Steam DLC app, never silently to the parent/base game.
    if (dlcProduct) {
      const steamType = await getSteamAppStoreType(item.id);
      if (steamType && steamType !== 'dlc') continue;
      if (!steamType && !exactBase) continue;
    }

    scored.push({ item, score, exactBase, standardAlias });
  }

  scored.sort((a, b) => {
    const aExact = a.exactBase || a.standardAlias;
    const bExact = b.exactBase || b.standardAlias;
    if (aExact !== bExact) return aExact ? -1 : 1;
    return b.score - a.score;
  });

  const best = scored[0];
  const second = scored[1];
  if (!best) {
    if (!dlcProduct && isEnhancedVersionTitle(product.name)) {
      const enhanced = await matchEnhancedSiblingApp(product, matches);
      if (enhanced) return enhanced;
    }

    if (!dlcProduct && !currentEdition.tag) {
      const implicitCollection = await matchNamedPackageFromSteam(
        product,
        matches,
        { allowImplicitCollection: true }
      );
      if (implicitCollection) return implicitCollection;
    }
    return null;
  }

  if (!best.exactBase && !best.standardAlias) {
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
    matchSource: dlcProduct
      ? 'steam-search-dlc'
      : best.standardAlias
        ? 'steam-search-standard-alias'
        : 'steam-search',
    steamSearchName: String(best.item.name),
    steamProductType: dlcProduct ? 'dlc' : 'app',
    categoryName: String(product.categoryName || ''),
    matchConfidence: (best.exactBase || best.standardAlias)
      ? 1
      : Math.round(best.score * 1000) / 1000
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
        all.push({
          id,
          name: String(p?.name || ''),
          categoryId: String(category.id),
          categoryName: String(category.name || '')
        });
      }
    } catch (err) {
      console.warn('Digiseller category sync failed:', category.id, err.message);
    }
  }

  const expanded = [];
  for (const product of all) {
    if (!shouldInspectEditionVariants(product)) {
      expanded.push(product);
      continue;
    }

    try {
      const raw = await getDigisellerRawProductDetails(product.id, 1);
      const variants = availableEditionVirtualProducts(product, raw);
      if (variants.length) expanded.push(...variants);
      else expanded.push(product);
    } catch (err) {
      console.warn('Digiseller edition variant expansion failed:', product.id, err.message);
      expanded.push(product);
    }
  }

  return expanded;
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
      repaired: 0,
      steamSearchMatched: 0,
      steamPackageMatched: 0,
      sellerSteamUrlMatched: 0,
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

        // Repair stale mappings created before virtual edition tags were fully
        // understood. In particular, a Super/Deluxe virtual variant must not
        // keep the parent's base AppID, otherwise the storefront shows the base
        // Steam price for an expensive edition.
        if (shouldRematchVirtualPaidEdition(product, matches)) {
          delete matches[productId];
          changed = true;
          report.repaired = Number(report.repaired || 0) + 1;
        }

        if (matches[productId]?.steamId) {
          report.alreadyMatched++;
          continue;
        }

        // A virtual default/Standard edition may safely inherit the mapping of
        // its parent Digiseller product. The storefront already used this fallback;
        // persist it here as a real virtual-product match so Admin and storefront
        // agree and the item no longer remains in the unresolved list.
        const parentVariant = cloneDefaultVariantParentMatch(product, matches);
        if (parentVariant) {
          matches[productId] = parentVariant;
          changed = true;
          report.inherited++;
          continue;
        }

        const paidVirtualEdition = isVirtualPaidEdition(product);

        // Paid virtual editions are special: resolve their edition-specific
        // Steam Package/SubID BEFORE any historical inheritance. The base AppID
        // is useful only as an anchor for package discovery, never as the final
        // comparison target for Deluxe/Super Deluxe/etc.
        if (paidVirtualEdition && steamSearches < AUTO_MATCH_MAX_STEAM_SEARCHES) {
          steamSearches++;
          const steam = await matchFromSteamSearch(product, matches);
          if (steam) {
            matches[productId] = steam;
            changed = true;
            if (steam.type === 'package') report.steamPackageMatched++;
            else report.steamSearchMatched++;
            continue;
          }
        }

        // Safest historical case: same game/edition was previously sold under
        // another Digiseller Product ID. For paid virtual editions this helper
        // accepts only a package with the exact same edition tag.
        const inherited = cloneHistoricalMatch(product, matches);
        if (inherited) {
          matches[productId] = inherited;
          changed = true;
          report.inherited++;
          continue;
        }

        // Truly new ordinary title: ask Steam and auto-accept only
        // high-confidence app/package matches. Paid virtual editions already
        // tried the package-specific path above, so do not spend the same search
        // budget twice in one sync pass.
        if (!paidVirtualEdition && steamSearches < AUTO_MATCH_MAX_STEAM_SEARCHES) {
          steamSearches++;
          const steam = await matchFromSteamSearch(product, matches);
          if (steam) {
            matches[productId] = steam;
            changed = true;
            if (steam.type === 'package') report.steamPackageMatched++;
            else report.steamSearchMatched++;
            continue;
          }
        }

        // Last-resort high-confidence fallback: many sellers paste the exact
        // Steam app URL into the product description. Validate that AppID against
        // Steam and the normalized product title before accepting it.
        const sellerSteamUrl = await matchFromSellerSteamUrl(product);
        if (sellerSteamUrl) {
          matches[productId] = sellerSteamUrl;
          changed = true;
          report.sellerSteamUrlMatched++;
          continue;
        }

        report.unresolved.push({
          productId,
          name: product.name,
          categoryName: String(product.categoryName || ''),
          isDlc: isDlcDigisellerProduct(product),
          normalizedName: isDlcDigisellerProduct(product)
            ? cleanSalesTitle(product.name)
            : canonicalBaseGameTitle(product.name),
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
        repaired: report.repaired,
        steamSearchMatched: report.steamSearchMatched,
        steamPackageMatched: report.steamPackageMatched,
        sellerSteamUrlMatched: report.sellerSteamUrlMatched,
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



function asObjectArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  return [];
}

function digisellerOptionId(option) {
  return String(option?.id ?? option?.name ?? option?.value ?? '').trim();
}

function digisellerOptionLabel(option) {
  return String(option?.label ?? option?.text ?? option?.title ?? option?.name ?? '').trim();
}

function digisellerOptionVariants(option) {
  const raw = option?.variants;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.variant)) return raw.variant;
  if (raw.variant && typeof raw.variant === 'object') return [raw.variant];
  return [];
}

function flattenDigisellerOptions(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) flattenDigisellerOptions(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;

  if (value.variants && digisellerOptionVariants(value).length) out.push(value);
  for (const child of Object.values(value)) flattenDigisellerOptions(child, out);
  return out;
}

function editionTagFromVariantText(value) {
  const s = String(value || '').toLowerCase();
  const rules = [
    ['super_deluxe', /\bsuper\s+deluxe\b|супер\s+делюкс/iu],
    ['premium', /\bpremium\b|премиум/iu],
    ['deluxe', /\bdeluxe\b|делюкс/iu],
    ['ultimate', /\bultimate\b|ультимейт/iu],
    ['gold', /\bgold\b|золот/iu],
    ['definitive', /\bdefinitive\b|окончательн/iu],
    ['complete', /\bcomplete\b|полное\s+издани/iu],
    ['eclipse', /\beclipse\b/iu],
    ['collector', /\bcollector'?s?\b|коллекцион/iu],
    ['standard', /\bstandard\b|стандарт/iu]
  ];
  return rules.find(([, re]) => re.test(s))?.[0] || '';
}

function editionLabelForTag(tag, fallback = '') {
  const labels = {
    standard: 'Standard Edition',
    deluxe: 'Deluxe Edition',
    super_deluxe: 'Super Deluxe Edition',
    premium: 'Premium Edition',
    ultimate: 'Ultimate Edition',
    gold: 'Gold Edition',
    definitive: 'Definitive Edition',
    complete: 'Complete Edition',
    eclipse: 'Eclipse Edition',
    collector: "Collector's Edition"
  };
  return labels[tag] || String(fallback || '').trim() || 'Edition';
}

function looksLikeEditionOption(option, variants) {
  const optionText = `${digisellerOptionLabel(option)} ${String(option?.type || '')}`.toLowerCase();
  const variantsText = variants.map(v => String(v?.text || '')).join(' ').toLowerCase();
  return /издани|edition|deluxe|premium|ultimate|gold|standard|super\s+deluxe|definitive|complete|commander|collector|eclipse|goty|game\s+of\s+the\s+year/i
    .test(`${optionText} ${variantsText}`);
}

function extractEditionOptions(rawProduct) {
  return flattenDigisellerOptions(rawProduct?.options || []).map(option => {
    const variants = digisellerOptionVariants(option).map(variant => ({
      value: String(variant?.value ?? variant?.id ?? '').trim(),
      text: String(variant?.text || '').trim(),
      default: Number(variant?.default || 0),
      modify: String(variant?.modify || ''),
      modifyValue: Number(variant?.modify_value ?? 0),
      modifyType: String(variant?.modify_type || ''),
      visible: Number(variant?.visible ?? 1),
      isAvailable: Number(variant?.is_available ?? 1),
      numInStock: variant?.num_in_stock ?? null,
      editionTag: editionTagFromVariantText(variant?.text || '')
    })).filter(v => /^\d+$/.test(v.value));

    return {
      id: digisellerOptionId(option),
      label: digisellerOptionLabel(option),
      type: String(option?.type || ''),
      required: option?.required ?? null,
      editionLike: looksLikeEditionOption(option, variants),
      variants
    };
  }).filter(option => option.editionLike && /^\d+$/.test(option.id) && option.variants.length >= 2);
}


function extractSelectableDigisellerOptions(rawProduct) {
  return flattenDigisellerOptions(rawProduct?.options || []).map(option => {
    const variants = digisellerOptionVariants(option).map(variant => ({
      value: String(variant?.value ?? variant?.id ?? '').trim(),
      text: String(variant?.text || '').trim(),
      default: Number(variant?.default || 0),
      visible: Number(variant?.visible ?? 1),
      isAvailable: Number(variant?.is_available ?? 1)
    })).filter(v => /^\d+$/.test(v.value));

    return {
      id: digisellerOptionId(option),
      label: digisellerOptionLabel(option),
      type: String(option?.type || ''),
      required: Number(option?.required ?? 0),
      variants
    };
  }).filter(option => /^\d+$/.test(option.id) && option.variants.length);
}

function safeDefaultDigisellerVariant(option) {
  const available = (option?.variants || []).filter(v => v.visible !== 0 && v.isAvailable !== 0);
  if (!available.length) return null;
  const defaults = available.filter(v => v.default === 1);
  if (defaults.length === 1) return defaults[0];
  if (available.length === 1) return available[0];
  return null;
}

function buildDigisellerCheckoutSelections(rawProduct, optionId, variantId) {
  const allOptions = extractSelectableDigisellerOptions(rawProduct);
  const selectedOption = allOptions.find(item => String(item.id) === String(optionId));
  if (!selectedOption) throw new Error('Edition option not found for this product');

  const selectedVariant = selectedOption.variants.find(item => String(item.value) === String(variantId));
  if (!selectedVariant) throw new Error('Edition variant not found for this product');
  if (selectedVariant.visible === 0 || selectedVariant.isAvailable === 0) throw new Error('Selected edition is unavailable');

  const selections = [{ id: Number(selectedOption.id), value: { id: Number(selectedVariant.value) } }];
  for (const option of allOptions) {
    if (String(option.id) === String(selectedOption.id)) continue;
    const fallback = safeDefaultDigisellerVariant(option);
    if (!fallback) continue;
    selections.push({ id: Number(option.id), value: { id: Number(fallback.value) } });
  }
  return { allOptions, selectedOption, selectedVariant, selections };
}

function missingDigisellerParameterId(message) {
  const m = String(message || '').match(/(?:параметр(?:а|у)?|parameter)\s*(\d+)/iu);
  return m ? String(m[1]) : '';
}

function shouldInspectEditionVariants(product) {
  const title = String(product?.name || '');
  return /выбор\s+издани|(?:standard|deluxe|premium|ultimate|gold)\s*[\\/|+]\s*(?:standard|deluxe|premium|ultimate|gold)|издани.*(?:standard|deluxe|premium)|(?:standard|deluxe|premium).*издани/i.test(title);
}

function virtualVariantProductId(sourceProductId, optionId, variantId) {
  return `v_${String(sourceProductId)}_${String(optionId)}_${String(variantId)}`;
}

function buildVirtualVariantTitle(sourceTitle, variant) {
  const tag = variant?.editionTag || editionTagFromVariantText(variant?.text || '');
  const label = editionLabelForTag(tag, variant?.text || '');
  let title = String(sourceTitle || '').normalize('NFKC');
  let replaced = false;

  title = title.replace(/выбор\s+издания/ig, () => {
    replaced = true;
    return label;
  });

  title = title.replace(
    /\b(?:standard|deluxe|premium|ultimate|gold)(?:\s*\/\s*(?:standard|deluxe|premium|ultimate|gold)){1,}\b/ig,
    () => {
      replaced = true;
      return label;
    }
  );

  if (!replaced) title = `${title} — ${label}`;
  return title
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+\|/g, ' |')
    .replace(/\|\s+/g, '| ')
    .replace(/-\s*\|/g, '|')
    .trim();
}

function availableEditionVirtualProducts(product, rawProduct) {
  const editionOptions = extractEditionOptions(rawProduct);
  if (editionOptions.length !== 1) return [];

  const option = editionOptions[0];
  return option.variants
    .filter(variant => variant.visible !== 0 && variant.isAvailable !== 0)
    .map(variant => ({
      ...product,
      id: virtualVariantProductId(product.id, option.id, variant.value),
      name: buildVirtualVariantTitle(product.name, variant),
      sourceProductId: String(product.id),
      sourceProductName: String(product.name || ''),
      isEditionVariant: true,
      editionOptionId: String(option.id),
      editionOptionLabel: String(option.label || ''),
      editionVariantId: String(variant.value),
      editionVariantLabel: String(variant.text || ''),
      editionVariantTag: String(variant.editionTag || ''),
      editionVariantModifyValue: Number(variant.modifyValue || 0),
      editionVariantModifyType: String(variant.modifyType || ''),
      editionVariantDefault: Boolean(variant.default)
    }));
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

async function getDigisellerRawProductDetails(productId, cache = 1) {
  const id = String(productId || '').trim();
  if (!/^\d+$/.test(id)) throw new Error('Invalid productId');

  const url =
    `${DIGISELLER_API_BASE}/products/${encodeURIComponent(id)}/data` +
    `?currency=RUB&lang=ru-RU&format=json&cache=${cache ? 1 : 0}`;
  const data = await fetchJson(url);
  if (Number(data?.retval || 0) !== 0 || !data?.product) {
    throw new Error(data?.retdesc || 'Digiseller product details unavailable');
  }
  return data.product;
}

async function getDigisellerProductDetails(productId) {
  const id = String(productId || '').trim();
  const p = await getDigisellerRawProductDetails(id, 1);
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
    } : null,
    editionOptions: extractEditionOptions(p)
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
  const decoded = decodeHtmlAttr(cell);

  // Steam has used several representations over the years:
  // - &#10004; / ✔
  // - &#10003; / ✓
  // - <span>✔</span>
  // - <span class="checkmark"></span>
  // - <img ...ico_bluecheck.png>
  //
  // This function is called only for the three language "checkcol" cells,
  // so a span/img inside one of these cells is itself a strong checked signal.
  return (
    /[✓✔]/.test(decoded) ||
    /&#(?:10003|10004);?/i.test(cell) ||
    /&#x(?:2713|2714);?/i.test(cell) ||
    /\bico_bluecheck(?:\.png)?\b/i.test(cell) ||
    /\bbluecheck(?:\.png)?\b/i.test(cell) ||
    /\bcheckmark\b/i.test(cell) ||
    /(?:icon_check|ico_check)/i.test(cell) ||
    /<span\b[^>]*>/i.test(cell) ||
    /<img\b[^>]*>/i.test(cell)
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
  const raw = forwarded || String(req.socket?.remoteAddress || '').trim();
  const normalized = raw.replace(/^::ffff:/i, '');
  return net.isIP(normalized) ? normalized : '';
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


async function createDigisellerPurchaseOption({ productId, optionId, variantId, ip }) {
  const raw = await getDigisellerRawProductDetails(productId, 0);
  const editionOptions = extractEditionOptions(raw);
  const option = editionOptions.find(item => String(item.id) === String(optionId));
  if (!option) throw new Error('Edition option not found for this product');

  const variant = option.variants.find(item => String(item.value) === String(variantId));
  if (!variant) throw new Error('Edition variant not found for this product');
  if (variant.visible === 0 || variant.isAvailable === 0) throw new Error('Selected edition is unavailable');

  const checkout = buildDigisellerCheckoutSelections(raw, optionId, variantId);
  const selections = [...checkout.selections];

  const send = async () => {
    const response = await fetch(`${DIGISELLER_API_BASE}/purchases/options`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'ZibStore/1.0'
      },
      body: JSON.stringify({
        product_id: Number(productId),
        options: selections,
        unit_cnt: 0,
        lang: 'ru-RU',
        ip: String(ip || '')
      })
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (_) {
      throw new Error(`Digiseller returned invalid JSON (HTTP ${response.status})`);
    }
    return { response, data };
  };

  let attempt = await send();
  for (let retry = 0; retry < 3; retry++) {
    if (attempt.response.ok && Number(attempt.data?.retval ?? -1) === 0 && Number(attempt.data?.id_po)) break;

    const missingId = missingDigisellerParameterId(attempt.data?.retdesc);
    if (!missingId || selections.some(item => String(item.id) === missingId)) break;

    const missingOption = checkout.allOptions.find(item => String(item.id) === missingId);
    const fallback = safeDefaultDigisellerVariant(missingOption);
    if (!missingOption || !fallback) {
      const label = missingOption?.label ? ` «${missingOption.label}»` : '';
      throw new Error(`Для товара требуется дополнительный выбор${label}; автоматическое значение не определено`);
    }

    selections.push({ id: Number(missingOption.id), value: { id: Number(fallback.value) } });
    attempt = await send();
  }

  const { response, data } = attempt;
  if (!response.ok || Number(data?.retval ?? -1) !== 0 || !Number(data?.id_po)) {
    throw new Error(data?.retdesc || `Digiseller checkout option failed (HTTP ${response.status})`);
  }

  return {
    idPo: String(data.id_po),
    variant: {
      id: String(variant.value),
      text: String(variant.text || ''),
      modifyValue: Number(variant.modifyValue || 0),
      modifyType: String(variant.modifyType || '')
    }
  };
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

  if (url.pathname === '/api/create-variant-checkout' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req, 32 * 1024);
      const productId = String(body.productId || '').trim();
      const optionId = String(body.optionId || '').trim();
      const variantId = String(body.variantId || '').trim();
      if (!/^\d+$/.test(productId) || !/^\d+$/.test(optionId) || !/^\d+$/.test(variantId)) {
        return json(res, 400, { ok: false, error: 'Valid productId, optionId and variantId are required' });
      }

      const ip = getClientIp(req);
      if (!ip) return json(res, 400, { ok: false, error: 'Client IP is unavailable' });

      const result = await createDigisellerPurchaseOption({ productId, optionId, variantId, ip });
      return json(res, 200, {
        ok: true,
        productId,
        optionId,
        variantId,
        idPo: result.idPo,
        variant: result.variant
      });
    } catch (err) {
      return json(res, 502, { ok: false, error: err.message });
    }
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
        steamPackageMatched: Number(sync?.steamPackageMatched || 0),
        sellerSteamUrlMatched: Number(sync?.sellerSteamUrlMatched || 0),
        ignored: Array.isArray(sync?.ignored) ? sync.ignored.length : 0,
        unresolved: Array.isArray(sync?.unresolved) ? sync.unresolved.length : 0
      }
    });
  }




  if (url.pathname === '/api/admin/steam-match-candidates' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;

    try {
      const productId = String(url.searchParams.get('productId') || '').trim();
      if (!productId) return adminJson(res, 400, { ok: false, error: 'productId is required' });

      const catalog = await fetchDigisellerCatalog();
      const product = catalog.find(x => String(x.id) === productId);
      if (!product) return adminJson(res, 404, { ok: false, error: 'Digiseller product not found' });

      const found = await adminSteamCandidates(product, readSteamMatchesFile());
      return adminJson(res, 200, {
        ok: true,
        productId,
        productName: product.name,
        normalizedName: isDlcDigisellerProduct(product) ? cleanSalesTitle(product.name) : canonicalBaseGameTitle(product.name),
        edition: editionInfo(product.name),
        ...found
      });
    } catch (err) {
      return adminJson(res, 502, { ok: false, error: err.message });
    }
  }

  if (url.pathname === '/api/admin/inspect-steam-target' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;

    try {
      const productId = String(url.searchParams.get('productId') || '').trim();
      const steamType = String(url.searchParams.get('steamType') || '').trim();
      const steamId = String(url.searchParams.get('steamId') || '').trim();
      const coverAppId = String(url.searchParams.get('coverAppId') || '').trim();
      if (!productId) return adminJson(res, 400, { ok: false, error: 'productId is required' });
      if (!['app', 'package'].includes(steamType)) {
        return adminJson(res, 400, { ok: false, error: 'steamType must be app or package' });
      }

      const catalog = await fetchDigisellerCatalog();
      const product = catalog.find(x => String(x.id) === productId);
      if (!product) return adminJson(res, 404, { ok: false, error: 'Digiseller product not found' });

      const target = await inspectSteamTarget(product, steamType, steamId, coverAppId);
      return adminJson(res, 200, { ok: true, productId, target });
    } catch (err) {
      return adminJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (url.pathname === '/api/admin/set-steam-match' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;

    try {
      const body = await readJsonBody(req, 64 * 1024);
      const productId = String(body.productId || '').trim();
      const steamType = String(body.steamType || '').trim();
      const steamId = String(body.steamId || '').trim();
      const coverAppId = String(body.coverAppId || '').trim();

      if (!productId || !steamId || !['app', 'package'].includes(steamType)) {
        return adminJson(res, 400, { ok: false, error: 'productId, steamType=app|package and steamId are required' });
      }

      const catalog = await fetchDigisellerCatalog();
      const product = catalog.find(x => String(x.id) === productId);
      if (!product) return adminJson(res, 404, { ok: false, error: 'Digiseller product not found' });

      const target = await inspectSteamTarget(product, steamType, steamId, coverAppId);
      const matches = readSteamMatchesFile();
      matches[productId] = {
        type: target.type,
        steamId: String(target.steamId),
        title: String(product.name || target.name || ''),
        region: 'ru',
        savedAt: new Date().toISOString(),
        coverMode: 'steam',
        ...(target.type === 'package' && target.coverAppId ? { coverAppId: String(target.coverAppId) } : {}),
        autoMatched: false,
        matchSource: 'admin-manual-steam-id',
        steamSearchName: String(target.name || ''),
        matchConfidence: 1
      };

      writeSteamMatchesFile(matches);
      autoMatchLastSyncAt = 0;

      return adminJson(res, 200, { ok: true, productId, item: matches[productId], target });
    } catch (err) {
      return adminJson(res, 400, { ok: false, error: err.message });
    }
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
