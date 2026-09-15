#!/usr/bin/env node

const fs = require('fs');

const SELLER_ID = String(process.env.DIGISELLER_SELLER_ID || '810015');
const API = 'https://api.digiseller.com/api';
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.SCAN_CONCURRENCY || 4)));
const OUT = process.env.SCAN_OUT || '/tmp/zibstore-variant-scan.json';

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'ZibStore-Variant-Scanner/1.0'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const text = await res.text();
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return [v];
  return [];
}

function optionId(o) {
  return String(o?.id ?? o?.name ?? o?.value ?? '').trim();
}

function optionLabel(o) {
  return String(o?.label ?? o?.text ?? o?.title ?? o?.name ?? '').trim();
}

function extractVariants(o) {
  const raw = o?.variants;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.variant)) return raw.variant;
  if (raw.variant && typeof raw.variant === 'object') return [raw.variant];
  return [];
}

function flattenOptions(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) flattenOptions(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;

  if (value.variants && extractVariants(value).length) out.push(value);
  for (const v of Object.values(value)) flattenOptions(v, out);
  return out;
}

function looksLikeEdition(option, variants) {
  const optionText = `${optionLabel(option)} ${String(option?.type || '')}`.toLowerCase();
  const variantsText = variants.map(v => String(v?.text || '')).join(' ').toLowerCase();
  const hay = `${optionText} ${variantsText}`;
  return /издани|edition|deluxe|premium|ultimate|gold|standard|super\s+deluxe|definitive|complete|commander|collector|goty|game\s+of\s+the\s+year/.test(hay);
}

async function fetchCatalog() {
  const catData = await fetchJson(`${API}/categories?seller_id=${SELLER_ID}&format=json`);
  const categories = asArray(catData?.category);
  const all = [];
  const seen = new Set();

  for (const category of categories) {
    if (!category?.id) continue;
    const url = `${API}/shop/products?seller_id=${SELLER_ID}` +
      `&category_id=${encodeURIComponent(category.id)}&rows=100&currency=RUR&format=json`;
    try {
      const data = await fetchJson(url);
      for (const p of asArray(data?.product)) {
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
      console.error(`Категория ${category.id}: ${err.message}`);
    }
  }
  return all;
}

async function inspectProduct(product) {
  const url = `${API}/products/${encodeURIComponent(product.id)}/data` +
    `?currency=RUB&lang=ru-RU&format=json&cache=0`;
  try {
    const data = await fetchJson(url);
    if (Number(data?.retval || 0) !== 0 || !data?.product) {
      return { ...product, error: data?.retdesc || 'product details unavailable' };
    }

    const p = data.product;
    const options = flattenOptions(p.options || []).map(o => {
      const variants = extractVariants(o).map(v => ({
        value: v?.value ?? v?.id ?? null,
        text: String(v?.text || ''),
        default: Number(v?.default || 0),
        modify: String(v?.modify || ''),
        modifyValue: Number(v?.modify_value ?? 0),
        modifyType: String(v?.modify_type || ''),
        visible: Number(v?.visible ?? 1),
        isAvailable: Number(v?.is_available ?? 1),
        numInStock: v?.num_in_stock ?? null
      }));
      return {
        id: optionId(o),
        label: optionLabel(o),
        type: String(o?.type || ''),
        required: o?.required ?? null,
        editionLike: looksLikeEdition(o, variants),
        variants
      };
    });

    return {
      ...product,
      seller: p?.seller ? { id: p.seller.id ?? null, name: String(p.seller.name || '') } : null,
      optionCount: options.length,
      options
    };
  } catch (err) {
    return { ...product, error: err.message };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
      if ((i + 1) % 10 === 0 || i + 1 === items.length) {
        process.stderr.write(`\rПроверено ${i + 1}/${items.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  process.stderr.write('\n');
  return out;
}

(async () => {
  console.log(`Сканирую внутренний каталог Digiseller seller_id=${SELLER_ID}...`);
  const catalog = await fetchCatalog();
  console.log(`Найдено товаров: ${catalog.length}`);

  const inspected = await mapLimit(catalog, CONCURRENCY, inspectProduct);
  const withAnyOptions = inspected.filter(x => Array.isArray(x.options) && x.options.length > 0);
  const withEditionOptions = withAnyOptions.filter(x => x.options.some(o => o.editionLike));
  const errors = inspected.filter(x => x.error);

  const report = {
    scannedAt: new Date().toISOString(),
    sellerId: SELLER_ID,
    totalProducts: catalog.length,
    productsWithAnyOptions: withAnyOptions.length,
    productsWithEditionOptions: withEditionOptions.length,
    errors: errors.length,
    editionProducts: withEditionOptions,
    allOptionProducts: withAnyOptions
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n=== ИТОГ ===');
  console.log(`Всего товаров: ${report.totalProducts}`);
  console.log(`С любыми внутренними параметрами: ${report.productsWithAnyOptions}`);
  console.log(`Похожи на выбор издания: ${report.productsWithEditionOptions}`);
  console.log(`Ошибок запроса: ${report.errors}`);
  console.log(`Полный отчёт: ${OUT}`);

  if (!withEditionOptions.length) {
    console.log('\nТоваров с выбором издания не найдено.');
    return;
  }

  console.log('\n=== ТОВАРЫ С ВНУТРЕННИМ ВЫБОРОМ ИЗДАНИЯ ===');
  for (const p of withEditionOptions) {
    console.log(`\n[${p.id}] ${p.name}`);
    console.log(`Категория: ${p.categoryName || p.categoryId || '—'}`);
    for (const o of p.options.filter(x => x.editionLike)) {
      console.log(`  option ${o.id || '—'} | ${o.label || 'без названия'} | type=${o.type || '—'}`);
      for (const v of o.variants) {
        const availability = v.isAvailable === 0 ? 'НЕТ В НАЛИЧИИ' : 'доступно';
        const def = v.default ? ' | default' : '';
        console.log(`    - ${v.value}: ${v.text || 'без названия'} | ${v.modify || v.modifyValue || '0'} | ${availability}${def}`);
      }
    }
  }
})().catch(err => {
  console.error('\nОшибка сканирования:', err);
  process.exitCode = 1;
});
