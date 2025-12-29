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

  const products = await fetchAllProductsFromAxonaut();

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
