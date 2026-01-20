// produits.js
// ===============================
// Synchronisation PRODUITS Axonaut
// Version stable validée via curl
// ===============================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// -------------------------
// FICHIERS
// -------------------------
const PRODUCTS_CACHE_FILE = path.join(__dirname, 'products-cache.json');
const PRODUCTS_DIFF_LOG_FILE = path.join(__dirname, 'products-diff-log.json');

// -------------------------
// CONFIG AXONAUT
// -------------------------
const AXONAUT_API_KEY =
  process.env.AXONAUT_API_KEY ||
  process.env.AXO_API_KEY ||
  '';

const AXONAUT_BASE_URL = 'https://axonaut.com/api/v2';
const AXONAUT_PRODUCTS_ENDPOINT = '/products';

// -------------------------
// CACHE EN MÉMOIRE
// -------------------------
let productsCache = [];
if (fs.existsSync(PRODUCTS_CACHE_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(PRODUCTS_CACHE_FILE, 'utf8'));
    if (Array.isArray(raw)) productsCache = raw;
  } catch (_) {}
}


// -------------------------
// LOG DIFF PRODUITS (A1)
// -------------------------
function appendProductDiffLog(entry) {
  let logs = [];

  if (fs.existsSync(PRODUCTS_DIFF_LOG_FILE)) {
    try {
      logs = JSON.parse(fs.readFileSync(PRODUCTS_DIFF_LOG_FILE, 'utf8'));
      if (!Array.isArray(logs)) logs = [];
    } catch (_) {
      logs = [];
    }
  }

  logs.push(entry);

  fs.writeFileSync(
    PRODUCTS_DIFF_LOG_FILE,
    JSON.stringify(logs, null, 2)
  );
}


// -------------------------
// AXIOS CLIENT MINIMAL
// -------------------------
function axonautClient() {
  if (!AXONAUT_API_KEY) {
    throw new Error('AXONAUT_API_KEY manquant (.env).');
  }

  return axios.create({
    baseURL: AXONAUT_BASE_URL,
    timeout: 30000,
    headers: {
      userApiKey: AXONAUT_API_KEY
    }
  });
}

// -------------------------
// FETCH PRODUITS (PAGINATION AXONAUT STRICTE)
// -------------------------
async function fetchAllProductsFromAxonaut() {
  const client = axonautClient();

  const all = [];
  let page = 1;
  const maxPages = 100;

  while (page <= maxPages) {
    const res = await client.get(AXONAUT_PRODUCTS_ENDPOINT, {
      headers: {
        page: String(page)
      }
    });

    const data = res.data;

    if (!Array.isArray(data) || data.length === 0) {
      break;
    }

    for (const p of data) {
      all.push({
        id: p.id ?? null,
        name: p.name ?? '',
        reference: p.reference ?? '',
        price: p.price ?? null,
        raw: p
      });
    }

    page += 1;
  }

  return all;
}

// -------------------------
// SYNC PRINCIPALE
// -------------------------
async function syncProducts() {
  console.log('DEBUG → syncProducts appelée');

  // 🔹 SNAPSHOT AVANT
  const beforeProducts = Array.isArray(productsCache)
    ? JSON.parse(JSON.stringify(productsCache))
    : [];

  const products = await fetchAllProductsFromAxonaut();

  // 🔹 COMPARAISON PRODUITS
  const beforeMap = new Map(
    beforeProducts.map(p => [String(p.id), p])
  );

  for (const p of products) {
    const before = beforeMap.get(String(p.id));

    // 🆕 PRODUIT CRÉÉ
    if (!before) {
      appendProductDiffLog({
        timestamp: new Date().toISOString(),
        action: 'created',
        before: null,
        after: p
      });
      continue;
    }

    // ✏️ PRODUIT MODIFIÉ
    const changed =
      before.name !== p.name ||
      before.reference !== p.reference ||
      before.price !== p.price;

    if (changed) {
      appendProductDiffLog({
        timestamp: new Date().toISOString(),
        action: 'updated',
        before,
        after: p
      });
    }
  }

  // 🔹 CACHE & FICHIER (EXISTANT, INCHANGÉ)
  productsCache = products;
  fs.writeFileSync(PRODUCTS_CACHE_FILE, JSON.stringify(productsCache, null, 2));

  return {
    total: productsCache.length
  };
}

// -------------------------
// GETTERS
// -------------------------
function getProducts() {
  return productsCache;
}

module.exports = {
  syncProducts,
  getProducts
};
