// axonaut-devis-signe.js
// ===================================================
// Récupération des devis SIGNÉS depuis Axonaut
// Lecture seule – Étape 2
// ===================================================

const axios = require('axios');

const AXONAUT_API_URL = 'https://api.axonaut.com/api/v2';


console.log('AXONAUT API KEY PRESENTE:', !!process.env.AXONAUT_API_KEY);

async function getDevisSignes() {
const res = await axios.get(
  `${AXONAUT_API_URL}/quotations`,
  {
headers: {
  'X-API-KEY': process.env.AXONAUT_API_KEY,
  'Content-Type': 'application/json',
  'Accept': 'application/json'
}
  }
);

// 🔎 DIAGNOSTIC TEMPORAIRE — À SUPPRIMER APRÈS
console.log(
  'AXONAUT QUOTATION SAMPLE:',
  JSON.stringify(res.data.data.slice(0, 2), null, 2)
);

const devisAcceptes = res.data.data;

  return devisAcceptes.map(d => ({
    date: d.date,
    client: d.company?.name || '',
    number: d.number,
    amount: d.total_with_taxes,
    status: d.status,
    url: `https://api.axonaut.com/quotations/${d.id}`
  }));
}

module.exports = { getDevisSignes };
