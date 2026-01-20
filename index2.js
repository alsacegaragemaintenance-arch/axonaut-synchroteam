require('dotenv').config();

// =====================================================
// IMPORTS & CONFIGURATION GLOBALE
// =====================================================
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { getDevisSignes } = require('./axonaut-devis-signe');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { listDevisAFaire } = require("./synchroteam-devis");
const { stGet, stPost, pickReportValue } = require("./synchroteam-devis");
const { STATUS_ROW_COLORS } = require('./constants');
const { renderDashboardHTML } = require('./dashboard.view');
const { renderStDevisHTML } = require('./st-devis.view');
const { renderProduitsHTML } = require('./produits.view');
const { renderDevisSigneHTML } = require('./devis-signe.view');
const {
  renderBeforeRow,
  renderAfterRow
} = require('./dashboard.render');


// -------------------------
// QUOTA AXONAUT – INITIALISATION SAFE
// -------------------------
// ⚠️ Objectif : éviter tout "quotaStatus is not defined" (cron / routes) sans refactor.
// On stocke aussi sur globalThis pour rester accessible même si le fichier est rechargé / importé différemment.
if (typeof globalThis.quotaStatus === 'undefined' || globalThis.quotaStatus === null) {
  globalThis.quotaStatus = {
    used: 0,
    max: 999999,
    secondsUntilReset: 0
  };
}
let quotaStatus = globalThis.quotaStatus;


// =====================================================
// MODULES MÉTIER (Axonaut / Synchroteam / Produits)
// =====================================================

// -------------------------
// MODULE PRODUITS
// ⚠️ IMPORTANT :
// - syncProducts NE DOIT JAMAIS être appelé automatiquement
// - Les PRODUITS fonctionneront UNIQUEMENT via webhook Axonaut
// -------------------------
const {
  getProducts,
  syncProducts
} = require('./produits');

// =====================================================
// INITIALISATION EXPRESS (AVANT TOUT app.get / app.post)
// =====================================================
const app = express();
app.use(bodyParser.json());


// =========================
// WEBHOOK AXONAUT – CLIENTS (SYNCHRO IMMÉDIATE)
// =========================
app.post('/webhook/axonaut/clients', async (req, res) => {
  try {
    const payload = req.body;

    console.log('📩 Webhook Axonaut CLIENT reçu:', payload.event);

    if (!['customer.created', 'customer.updated'].includes(payload.event)) {
      return res.sendStatus(200);
    }

    if (!payload.resource_id) {
      console.warn('⚠️ Webhook client sans resource_id – ignoré');
      return res.sendStatus(200);
    }

    // ⚠️ IMPORTANT : synchro d’UN SEUL client → quota safe
    await syncSingleClientFromAxonaut(payload.resource_id);

    console.log('✅ Client synchronisé depuis webhook:', payload.resource_id);
    res.sendStatus(200);

  } catch (err) {
    console.error('❌ Erreur webhook client Axonaut:', err.message);
    res.sendStatus(500);
  }
});


// =====================================================
// ROUTES API — SYNCHROTEAM / DEVIS
// =====================================================
// -------------------------
// API – VALIDER UN DEVIS (copie puis Devis = NON)
// -------------------------
app.post('/api/st-devis/valider', async (req, res) => {
  try {
const { jobId, equipement, numeroDevis } = req.body;

    if (!jobId || !equipement) {
      return res.status(400).json({ error: "Paramètres manquants" });
    }

    // 1️⃣ Charger le bon
    const detail = await stGet('/Api/v2/Jobs/Detail', { id: jobId });
    const report = Array.isArray(detail.Report) ? detail.Report : [];

    const refLabel = `Référence des Pièces et MO (Devis ${equipement})`;
    const obsLabel = `Observations (${equipement})`;
    const devisLabel = `Devis A Faire (${equipement})`;

    const refValue = pickReportValue(report, refLabel) || "";

    // 2️⃣ Copier vers Observations
    await stPost('/Api/v2/Jobs/Report/Save', {
      idJob: jobId,
      items: [
        { nmItem: obsLabel, value: refValue }
      ]
    });

    // 3️⃣ Passer Devis à NON
    await stPost('/Api/v2/Jobs/Report/Save', {
      idJob: jobId,
      items: [
        { nmItem: devisLabel, value: "Non" }
      ]
    });

// 4️⃣ Enregistrer le numéro de devis (si présent et si le champ existe)
if (numeroDevis && String(numeroDevis).trim() !== "") {
  try {
    console.log('➡️ ST CALL: Report/Save - Observations');
    await stPost('/Api/v2/Jobs/Report/Save', {
      idJob: jobId,
      items: [
        {
          nmItem: "Devis associé",
          value: String(numeroDevis).trim()
        }
      ]
    });
  } catch (err) {
    if (err.response && err.response.status === 404) {
      console.warn(
        `⚠️ Champ "Devis associé" absent pour job ${jobId} – ignoré`
      );
    } else {
      throw err; // toute autre erreur DOIT bloquer
    }
  }
}


    res.json({ ok: true });

  } catch (err) {
    console.error('❌ Erreur validation devis:', err.message);
    res.status(500).json({ error: 'Erreur Synchroteam' });
  }
});

// =====================================================
// SERVEUR HTTP & SOCKET.IO
// =====================================================
const http = require('http').createServer(app);
const { Server } = require('socket.io');
const io = new Server(http);

// -------------------------
// CONFIG
// -------------------------
const ST_CUSTOM_FIELD_ID = "1234";
const LOG_FILE = path.join(__dirname, 'sync-log.json');
const CACHE_FILE = path.join(__dirname, 'sync-cache.json');

if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, JSON.stringify([], null, 2), 'utf8');
if (!fs.existsSync(CACHE_FILE)) fs.writeFileSync(CACHE_FILE, JSON.stringify({}, null, 2), 'utf8');

// ✅ AJOUT (logs global pour /logs + webhook delete + dashboard)
let logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));

let clientCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
let syncInProgress = false;
let errorQueue = [];
let nodeLogBuffer = [];
const NODE_LOG_LIMIT = 20;


// -------------------------
// QUOTA AXONAUT
// -------------------------
const quotaMax = 600;
let quotaUsedToday = 0; // 🔹 initialisation propre au démarrage
let lastReset = new Date();

function resetQuotaIfNeeded() {

  const now = new Date();
  if (now.toDateString() !== lastReset.toDateString()) {
    quotaUsedToday = 0;
    lastReset = now;
  }
}

function getQuotaStatus() {
  resetQuotaIfNeeded();
  const remaining = quotaMax - quotaUsedToday;
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setHours(24,0,0,0);
  const secondsUntilReset = Math.floor((tomorrow - now)/1000);
  return { used: quotaUsedToday, max: quotaMax, remaining, secondsUntilReset };
}

// -------------------------
// UTILITIES
// -------------------------
const {
  sleep,
  hasChanged,
  highlightChanges,
} = require('./helpers');


// -------------------------
// LOGGING
// -------------------------
function logSync(entry){

  try{
    const fileLogs = fs.existsSync(LOG_FILE)
      ? JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'))
      : [];

    fileLogs.push(entry);
    fs.writeFileSync(LOG_FILE, JSON.stringify(fileLogs, null, 2), 'utf8');

    // ✅ garde "logs" (global) à jour pour /logs + dashboard
    logs = fileLogs;

  }catch(err){
    console.error('❌ Erreur écriture journal:',err.message);
    console.error(err.stack);
  }
}


// -------------------------
// CREATE/UPDATE CLIENT SYNCHROTEAM
// -------------------------
async function createOrUpdateCustomer(customer){
  if(quotaUsedToday >= quotaMax){
    console.warn(`⚠️ Quota Axonaut atteint, arrêt création/update pour ${customer.name}`);
    io.emit('notification',{type:'error',message:`⚠️ Quota Axonaut atteint, client ${customer.name} non synchronisé`});
    return {...customer,action:'quota_exceeded',error:'Quota Axonaut atteint'};
  }

  const url=`https://ws.synchroteam.com/api/v3/customer/send`;
  const auth=Buffer.from(`${process.env.ST_DOMAIN}:${process.env.ST_API_KEY}`).toString('base64');
  const headers={ 'Authorization':`Basic ${auth}`, 'Content-Type':'application/json', 'Accept':'application/json' };

  try{
    const response=await axios.post(url,customer,{headers});
    let action='updated';
    if(response.data?.customer?.created) action='created';
    quotaUsedToday+=1;
    io.emit('quotaUpdate',getQuotaStatus());
    console.log(`✅ Client ${action}: ${customer.name}`);
    return {...customer,action,error:null};
  }catch(err){
    quotaUsedToday+=1;
    io.emit('quotaUpdate',getQuotaStatus());
    console.error('❌ Erreur Synchroteam:',err.response?.data||err.message);
    return {...customer,action:'error',error:err.response?.data||err.message};
  }
}

// -------------------------
// HANDLE ERRORS & RETRY
// -------------------------
async function handleError(entry,customerData){
  let existing=errorQueue.find(e=>e.myId===entry.myId);
  if(existing) existing.retryCount++;
  else { existing={...entry,customerData,retryCount:1,stopped:false}; errorQueue.push(existing);}
  if(existing.retryCount<=3 && !existing.stopped){
    console.log(`🔁 Tentative ${existing.retryCount} pour ${entry.name}`);
    await retryCustomer(existing.customerData);
  } else {
    existing.stopped=true;
    console.log(`⚠️ Client ${entry.name} ignoré après 3 tentatives`);
    io.emit('errorQueueUpdate',errorQueue);
  }
}

async function retryCustomer(customerData){
  const result=await createOrUpdateCustomer(customerData);
  logSync({before:clientCache[customerData.myId]||null,after:customerData,action:result.action,timestamp:new Date().toISOString(),error:result.error});
  if(result.action==='error') await handleError(result,customerData);
  else{
    errorQueue=errorQueue.filter(e=>e.myId!==customerData.myId);
    clientCache[customerData.myId]={...customerData};
    fs.writeFileSync(CACHE_FILE,JSON.stringify(clientCache,null,2),'utf8');
    io.emit('errorQueueUpdate',errorQueue);
    io.emit('newSync',result);
  }
}



// -------------------------
// PROCESS CUSTOMER
// -------------------------

// 🔹 Axonaut — récupération client complet
async function getCustomerFromAxonaut(customerId) {
  try {
    const res = await axios.get(
      `https://app.axonaut.com/api/v2/companies/${customerId}`,
      {
        headers: {
          userApiKey: process.env.AXO_API_KEY,
          Accept: 'application/json'
        }
      }
    );

    return res.data?.company || null;

  } catch (err) {
    console.error(
      '❌ Erreur getCustomerFromAxonaut:',
      err.response?.status,
      err.response?.data || err.message
    );
    return null;
  }
}

async function processCustomer(customer, options = {}) {
  if(!customer.myId) return;  // 🔹 ignorer clients sans ID


// 🔹 RECHARGE CLIENT COMPLET POUR UNE CRÉATION
if (options.forceCreated === true) {
  try {
    // On tente plusieurs fois car Axonaut peut créer la société avant de créer le contact (employees)
    for (let attempt = 1; attempt <= 3; attempt++) {

      const fullCompany = await getCustomerFromAxonaut(customer.axoId);

      if (fullCompany) {
        // Adresse (company)
        customer.address = fullCompany.address_street || customer.address || '';
        customer.address2 = fullCompany.address_complement || customer.address2 || '';
        customer.addressZIP = fullCompany.address_zip_code || customer.addressZIP || '';
        customer.addressCity = fullCompany.address_city || customer.addressCity || '';

        // Contact (souvent dans employees[0])
        const fullContact = (fullCompany.employees && fullCompany.employees[0]) || null;

        customer.contactEmail = fullContact?.email || customer.contactEmail || '';
        customer.contactPhone = fullContact?.phone_number || customer.contactPhone || '';
        customer.contactMobile = fullContact?.cellphone_number || customer.contactMobile || '';
      }

      // Si on a récupéré au moins une info utile, on sort
      const hasUseful =
        (customer.address && customer.address.trim() !== '') ||
        (customer.addressZIP && customer.addressZIP.trim() !== '') ||
        (customer.addressCity && customer.addressCity.trim() !== '') ||
        (customer.contactEmail && customer.contactEmail.trim() !== '') ||
        (customer.contactPhone && customer.contactPhone.trim() !== '') ||
        (customer.contactMobile && customer.contactMobile.trim() !== '');

      if (hasUseful) break;

      // sinon on attend un peu et on retente
      await new Promise(r => setTimeout(r, 1500));
    }

    console.log(
      '🧪 CREATED après enrich Axonaut:',
      customer.name,
      '| addr:',
      customer.address,
      customer.addressZIP,
      customer.addressCity,
      '| mail:',
      customer.contactEmail,
      '| tel:',
      customer.contactPhone,
      '| mob:',
      customer.contactMobile
    );

  } catch (e) {
    console.error('❌ Erreur récupération client Axonaut complet:', e.message);
  }
}

  const oldClient=clientCache[customer.myId]||null;
  const errorEntry=errorQueue.find(e=>e.myId===customer.myId && e.stopped);
  if(errorEntry){ console.log(`⚠️ Client ${customer.name} ignoré car erreur après 3 tentatives`); return; }

  if (options.forceCreated === true || hasChanged(oldClient, customer)) {
    const result=await createOrUpdateCustomer(customer);
    const dashboardEntry={
      before:oldClient?{...oldClient}:null,
      after:{...customer},
      action:result.action,
      timestamp:new Date().toISOString(),
      error:result.error
    };

    // 🔹 Forcer une vraie création visuelle (company.created)
    if (options.forceCreated === true) {
      dashboardEntry.before = null;
      dashboardEntry.action = 'created';
    }

    logSync(dashboardEntry);

    if(result.action==='error') await handleError(result,customer);
    else{
      clientCache[customer.myId]={...customer};
      fs.writeFileSync(CACHE_FILE,JSON.stringify(clientCache,null,2),'utf8');
      io.emit('newSync',dashboardEntry);
    }
  }
}

// -------------------------
// SYNCHRO COMPLÈTE PAR BATCH (NON BLOQUANTE)
// -------------------------
async function syncAllClientsOptimized(){
  if(syncInProgress) return;
  syncInProgress = true;
  const now = new Date();
  const hour = now.getHours();
  if(hour<7 || hour>=20){ console.log('⏱ Hors tranche horaire, synchro suspendue'); syncInProgress=false; return; }

  try{
const axoUrl='https://app.axonaut.com/api/v2/companies';
    const axoHeaders={ 'userApiKey':process.env.AXO_API_KEY,'Accept':'application/json' };
    let page=1;
    while(true){
      if(quotaUsedToday>=quotaMax){ console.warn('⚠️ Quota quotidien atteint, arrêt synchro'); break; }
      let response;
      try{
        response=await axios.get(axoUrl,{headers:axoHeaders,params:{limit:100,page}});
        quotaUsedToday++;
        io.emit('quotaUpdate',getQuotaStatus());
      }catch(err){
        if(err.response?.status===429){ console.warn('⏳ Trop de requêtes, attente 60s'); await sleep(60000); continue; }
        else throw err;
      }

      const companies=response.data?.data||response.data||[];
      if(!companies.length) break;
      console.log(`🔹 Page ${page} récupérée: ${companies.length} sociétés`);

      const batch = [];
      for(const company of companies){
        if(!company.internal_id) continue;
        const contact=(company.employees && company.employees[0])||{};
        const customer={
          axoId: company.id,                 // ✅ ID Axonaut numérique (pour appeler l’API)
          myId:company.internal_id.toString(),
          name:company.name,
          address:company.address_street||'',
          address2:company.address_complement||'',
          addressZIP:company.address_zip_code||'',
          addressCity:company.address_city||'',
          contactEmail:contact?.email||'',
          contactPhone:contact?.phone_number||'',
          contactMobile:contact?.cellphone_number||'',
          update:true
        };
        batch.push(processCustomer(customer));
        if(batch.length>=5){
          await Promise.all(batch);
          batch.length=0;
          await sleep(1100);
        }
      }
      if(batch.length) await Promise.all(batch);

      page++;
      await sleep(5000);
    }
    console.log('✅ Synchronisation complète');
  }catch(err){ console.error('❌ Erreur sync:',err.response?.data||err.message);}
  finally{ syncInProgress=false; }
}

// -------------------------
// QUOTA
// -------------------------
function isQuotaSafe(quotaStatus, minRemaining = 50) {
  // Si on n’a pas encore d’info quota, on ne bloque pas
  if (!quotaStatus || typeof quotaStatus !== 'object') return true;

  const used = Number(quotaStatus.used ?? 0);
  const max = Number(quotaStatus.max ?? 0);

  // Si Axonaut ne renvoie pas de quota exploitable
  if (!max || max <= 0) return true;

  const remaining = max - used;

  return remaining >= minRemaining;
}


// -------------------------
// CRON
// -------------------------
cron.schedule('*/20 * * * *', async () => {
    console.log('⏱️ Cron Axonaut déclenché (toutes les 20 minutes)');

  // ⛔ Hors plage horaire
  if (!isBusinessHours()) {
    console.log('⏱️ Hors plage horaire → cron ignoré');
    return;
  }

// ✅ Initialisation safe quotaStatus (si jamais le scope ne l’a pas encore)
if (typeof quotaStatus === 'undefined' || quotaStatus === null) {
  quotaStatus = (typeof getQuotaStatus === 'function') ? getQuotaStatus() : {
    used: 0,
    max: 999999,
    secondsUntilReset: 0
  };
}

// ⛔ quotaStatus non initialisé
if (typeof quotaStatus === 'undefined') {
  console.log('⛔ quotaStatus non défini → cron ignoré');
  return;
}

  // ⛔ Quota trop bas
  if (!isQuotaSafe(quotaStatus, 150)) {
    console.log('⛔ Quota Axonaut trop bas → synchro CLIENTS annulée');
    return;
  }

  try {
  await syncAllClientsOptimized();
} catch (err) {
  console.error('❌ Erreur synchro cron CLIENTS:', err.message);
}

});

// -------------------------
// UTILS – HORAIRES OUVRÉS
// -------------------------
function isBusinessHours() {
  const now = new Date();
  const hour = now.getHours();

  // Plage autorisée : 07h → 20h
  return hour >= 7 && hour < 20;
}

// -------------------------
// WEBHOOK AXONAUT pour synchro instantanée
// -------------------------
app.post('/webhook/axonaut', async (req, res) => {
  console.log('📩 Webhook Axonaut reçu');
  console.log('Headers:', req.headers);
  console.log('Body brut:', JSON.stringify(req.body, null, 2));
  
  const topic = req.body?.topic;

  // -------------------------
  // AXONAUT — CLIENT SUPPRIMÉ (company.deleted)
  // -------------------------
  const eventType = req.body?.topic;

  if (eventType === 'company.deleted') {
    console.log('🗑️ Webhook Axonaut : client supprimé');

    const company = req.body?.data;

    if (!company || !company.internal_id) {
      console.log('⚠️ Webhook delete ignoré : internal_id manquant');
      return res.status(200).send('Ignored: no internal_id');
    }

    const contact = (company.employees && company.employees[0]) || {};

    const before = {
      myId: company.internal_id.toString(),
      name: company.name,
      address: company.address_street || '',
      address2: company.address_complement || '',
      addressZIP: company.address_zip_code || '',
      addressCity: company.address_city || '',
      contactEmail: contact?.email || '',
      contactPhone: contact?.phone_number || '',
      contactMobile: contact?.cellphone_number || ''
    };

const logEntry = {
  timestamp: new Date().toISOString(),
  action: 'deleted',
  before: null,   // ⬅️ IMPORTANT : empêche la ligne "original"
  after: null
};

    // 🔹 Log dashboard (mémoire)
    logs.unshift(logEntry);

    // 🔹 Live dashboard
    io.emit('newSync', logEntry);

    // ⚠️ VISUEL UNIQUEMENT — aucun impact Synchroteam
    return res.status(200).send('OK');
  }

  // -------------------------
  // AXONAUT — CREATE / UPDATE (logique existante)
  // -------------------------
  const company = req.body?.data;

  if (!company || !company.internal_id) {
    console.log('⚠️ Webhook ignoré : internal_id manquant');
    return res.status(200).send('Ignored: no internal_id');
  }

  const contact = (company.employees && company.employees[0]) || {};
  const customer = {
    axoId: company.id,                 // ✅ ID Axonaut numérique (pour appeler l’API)
    myId: company.internal_id.toString(),
    name: company.name,
    address: company.address_street || '',
    address2: company.address_complement || '',
    addressZIP: company.address_zip_code || '',
    addressCity: company.address_city || '',
    contactEmail: contact?.email || '',
    contactPhone: contact?.phone_number || '',
    contactMobile: contact?.cellphone_number || '',
    update: true
  };

  // -------------------------
  // AXONAUT — DÉTECTION CRÉATION RÉELLE
  // -------------------------
  const isCreatedEvent = eventType === 'company.created';

  console.log(
    '➡️ Client extrait depuis webhook:',
    customer.name,
    `(ID ${customer.myId})`,
    isCreatedEvent ? '[CREATED]' : '[UPDATED]'
  );

console.log('🚨 AVANT processCustomer → Synchroteam', customer.myId);

await processCustomer(customer, { forceCreated: isCreatedEvent });

console.log('✅ APRÈS processCustomer → Synchroteam', customer.myId);

  return res.status(200).send('OK');
});
  
// -------------------------
// SYNCHROTEAM – DEVIS À FAIRE (LECTURE SEULE)
// -------------------------
app.get('/st-devis', async (req, res) => {
  try {
    // Fenêtre par défaut : 30 derniers jours
    const now = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 30);

    const pad = n => String(n).padStart(2, '0');
    const fmt = d =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

    const dateFrom = req.query.dateFrom || fmt(from);
    const dateTo   = req.query.dateTo   || fmt(now);

    const debugMode = req.query.debug === '1';
    console.log('🧪 MODE DEBUG ST-DEVIS =', debugMode);

    const rows = await listDevisAFaire({
      dateFrom,
      dateTo,
      max: debugMode ? 5 : 50,
      debug: debugMode
    });

    // CONSOLE LOG
rows.forEach(r => {
  console.log(
    "🧪 DASHBOARD STATUS:",
    r.num,
    "status =",
    r.status,
    "type =",
    typeof r.status
  );
});

const tableRows = rows.map(r => {

  // 🔹 Nettoyage / découpe des équipements
  const equipements = (r.equipement || "")
    .split(/[\/,;\n]/)      // accepte / , ; ou retour ligne
    .map(e => e.trim())
    .filter(e => e.length > 0);

  // 🔹 Construction du titre devis
  const devisTitle = [
    r.client,
    ...equipements
  ].filter(Boolean).join(" / ");

  return `
<tr style="background-color:${STATUS_ROW_COLORS[r.status] || '#FFFFFF'}">
  <td>


    <a
      href="https://agm.synchroteam.com/app/Job/Details/${r.id}"
      target="_blank"
      style="color:#0066cc;text-decoration:underline;font-weight:bold;"
      title="Ouvrir le bon Synchroteam"
    >
      ${r.num || ''}
    </a>
  </td>
  <td>${r.client || ''}</td>
  <td>${r.equipement || ''}</td>
  <td style="white-space:pre-wrap;max-width:420px;">${r.commentaire || ''}</td>
  <td style="white-space:pre-wrap;max-width:380px;">${r.refPiecesMO || ''}</td>
  <td>${r.realEndDate || ''}</td>
  <td style="text-align:center;">
  <input
    type="checkbox"
    class="validate-devis"
    data-job-id="${r.id}"
    data-equipement="${r.equipement}"
    data-num="${r.num}"
  />
</td>


<!-- ------------------------- -->
<!-- COLONNE AXONAUT -->
<!-- ------------------------- -->

<td style="text-align:center;">
  <a
href="https://app.axonaut.com/quotes/new${r.axonautClientId ? `?client_id=${r.axonautClientId}&title=${encodeURIComponent(devisTitle)}` : `?title=${encodeURIComponent(devisTitle)}`}"
    target="_blank"
    title="Créer un devis dans Axonaut"
    style="
      display:inline-block;
      padding:6px 10px;
      background:#2ecc71;
      color:#fff;
      border-radius:6px;
      text-decoration:none;
      font-weight:bold;
      font-size:12px;
    "
  >
    + Devis
  </a>
</td>


</tr>

`;
}).join('');
     
res.send(renderStDevisHTML({
  dateFrom,
  dateTo,
  rowsCount: rows.length,
  tableRows
}));

  } catch (err) {
    console.error('❌ Erreur /st-devis:', err?.response?.data || err.message);
    res.status(500).send('Erreur Synchroteam (voir console)');
  }
});

// -------------------------
// DASHBOARD LIVE
// -------------------------
// -------------------------
// ROUTE RACINE
// -------------------------
app.get('/', (req, res) => {
  res.redirect('/logs');
});

app.get('/logs', async (req, res) => {
logs = logs.sort((a, b) =>
  new Date(b.timestamp) - new Date(a.timestamp)
);


  const errors = errorQueue.map(e => ({
    myId: e.myId,
    name: e.name,
    error: e.error,
    retryCount: e.retryCount
  }));

const quotaStatus = getQuotaStatus();

// 🔹 COMPTE DES DEVIS À FAIRE (pour la tuile)
let devisCount = 0;
try {
  const now = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);

  const pad = n => String(n).padStart(2, '0');
  const fmt = d =>
    `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const devisRows = await listDevisAFaire({
  dateFrom: fmt(from),
  dateTo: fmt(now),
  max: 50, // ⚠️ EXACTEMENT comme /st-devis
  debug: false
});

devisCount = devisRows.length;

// 🔹 ON UTILISE EXACTEMENT LA MÊME LOGIQUE QUE /st-devis
devisCount = devisRows.length;
} catch (e) {
  console.error('⚠️ Erreur calcul devisCount:', e.message);
}

res.send(renderDashboardHTML({
  quotaStatus,
  devisCount,
  errors,
  logs,
  renderBeforeRow,
  renderAfterRow
}));
});

// -------------------------
// SOCKET.IO relance manuelle
// -------------------------
io.on('connection', socket => {

  // -------------------------
  // AJOUT : INITIALISATION ÉTAT DASHBOARD (OPTION B)
  // -------------------------
  try {
    const initLogs = JSON.parse(
      fs.readFileSync(LOG_FILE, 'utf8')
    )
.sort((a, b) =>
  new Date(b.timestamp) - new Date(a.timestamp)
)
      .slice(0, 50);

    socket.emit('initQuota', getQuotaStatus());
    socket.emit('initErrors', errorQueue);
    socket.emit('initLogs', initLogs);

  } catch (err) {
    console.error('❌ Erreur init dashboard:', err.message);
  }

  // -------------------------
  // AJOUT : INIT LOGS NODE
  // -------------------------
  setTimeout(() => {
    nodeLogBuffer.forEach(line => {
      socket.emit('nodeLog', line);
    });
  }, 300);

  // -------------------------
  // TEST CONNEXION SOCKET (déplacé ici, PAS supprimé)
  // -------------------------
  setTimeout(() => {
    socket.emit('nodeLog', '🧪 Test connexion Socket.IO OK');
  }, 300);

  socket.on('manualRetry', async myId => {
    const errorItem = errorQueue.find(e => e.myId === myId);
    if (errorItem) {
      console.log(`🔄 Relance manuelle pour ${errorItem.name}`);
      errorItem.stopped = false;
      await retryCustomer(errorItem.customerData);
    }
  });

});

// -------------------------
// SURVEILLANCE LOG NODE
// -------------------------
const origLog = console.log;
console.log = function(...args){
  origLog.apply(console,args);
  const line = args.join(' ');

  nodeLogBuffer.unshift(line);
  if(nodeLogBuffer.length > NODE_LOG_LIMIT){
    nodeLogBuffer.pop();
  }

  io.emit('nodeLog', line);
};

// -------------------------
// CAPTURE console.error POUR LE DASHBOARD
// -------------------------
const origError = console.error;
console.error = function (...args) {
  origError.apply(console, args);
  io.emit(
    'nodeLog',
    '❌ ' +
      args
        .map(a => (typeof a === 'object' ? JSON.stringify(a) : a))
        .join(' ')
  );
};


// -------------------------
// SYNCHRONISATION PRODUITS
// -------------------------
// 🚫 Sync PRODUITS volontairement désactivée (quota Axonaut)
//console.log('🚀 Lancement sync produits...');
//syncProducts()
//  .then(r => console.log('✅ Sync produits terminée', r))
//  .catch(e => {
//    console.error('❌ Sync produits erreur', e.message);
//    console.error(e.stack);
//  });

// -------------------------
// API PRODUITS
// -------------------------

app.get('/api/products', (req, res) => {
  res.json(getProducts());
});

// =========================
// SYNCHRO IMMÉDIATE – CLIENT UNIQUE AXONAUT → SYNCHROTEAM
// =========================
console.log('🧪 TEST APPEL syncSingleClientFromAxonaut');

async function syncSingleClientFromAxonaut(axonautClientId) {
  console.log(`🔄 Synchro immédiate client Axonaut ID=${axonautClientId}`);

  try {
    // -------------------------
    // 1. Récupération client Axonaut (UN SEUL APPEL → quota safe)
    // -------------------------
    const axoRes = await axios.get(
      `https://app.axonaut.com/api/v2/customers/${axonautClientId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.AXONAUT_API_KEY}`
        }
      }
    );

    const axoClient = axoRes.data.data;

    if (!axoClient || !axoClient.id) {
      console.warn(`⚠️ Client Axonaut introuvable ID=${axonautClientId}`);
      return;
    }

    // -------------------------
    // 2. Mapping Axonaut → Synchroteam
    // ⚠️ On reprend EXACTEMENT la logique métier existante
    // -------------------------
    const synchroPayload = {
      name: axoClient.company_name || `${axoClient.firstname || ''} ${axoClient.lastname || ''}`.trim(),
      address: axoClient.address || '',
      zip: axoClient.zip || '',
      city: axoClient.city || '',
      phone: axoClient.phone || '',
      mobile: axoClient.mobile || '',
      email: axoClient.email || '',
      custom_fields: {
        AXONAUT_ID: String(axoClient.id)
      }
    };

    // -------------------------
    // 3. Recherche client Synchroteam par AXONAUT_ID
    // -------------------------
    const stSearch = await axios.get(
      `https://${process.env.ST_DOMAIN}.synchroteam.com/api/v3/customers`,
      {
        headers: {
          Authorization: `Bearer ${process.env.ST_API_KEY}`
        },
        params: {
          search: axoClient.id
        }
      }
    );

    const existingClient = (stSearch.data.data || []).find(c =>
      c.custom_fields &&
      String(c.custom_fields.AXONAUT_ID) === String(axoClient.id)
    );

    // -------------------------
    // 4. CREATE ou UPDATE
    // -------------------------
    if (existingClient) {
      await axios.put(
        `https://${process.env.ST_DOMAIN}.synchroteam.com/api/v3/customers/${existingClient.id}`,
        synchroPayload,
        {
          headers: {
            Authorization: `Bearer ${process.env.ST_API_KEY}`
          }
        }
      );

      console.log(`✏️ Client Synchroteam mis à jour (AXONAUT_ID=${axoClient.id})`);
    } else {
      await axios.post(
        `https://${process.env.ST_DOMAIN}.synchroteam.com/api/v3/customers`,
        synchroPayload,
        {
          headers: {
            Authorization: `Bearer ${process.env.ST_API_KEY}`
          }
        }
      );

      console.log(`✅ Client Synchroteam créé (AXONAUT_ID=${axoClient.id})`);
    }

  } catch (err) {
    console.error(
      `❌ Erreur synchro immédiate client AXONAUT_ID=${axonautClientId}`,
      err.response?.data || err.message
    );
  }
}


// -------------------------
// PAGE PRODUITS – HISTORIQUE
// -------------------------
app.get('/produits', (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');

    const DIFF_FILE = path.join(__dirname, 'products-diff-log.json');

    let logs = [];
    if (fs.existsSync(DIFF_FILE)) {
      logs = JSON.parse(fs.readFileSync(DIFF_FILE, 'utf8'));
    }

    // Limite affichage (sécurité)
    logs = logs.slice(-100).reverse();

    const logsHtml = logs.map(log => {
      const d = new Date(log.timestamp);
      const actionClass = log.action === 'created' ? 'created' : 'updated';

      const before = log.before || {};
      const after = log.after || {};

      function cell(beforeVal, afterVal) {
        if (beforeVal !== afterVal) {
          return `<span class="changed">${afterVal ?? ''}</span>`;
        }
        return afterVal ?? '';
      }

      let html = '';

      // 🔹 AVANT
      if (log.action === 'updated') {
        html += `
<tr class="before">
  <td>${d.toLocaleDateString()} ${d.toLocaleTimeString()}</td>
  <td>AVANT</td>
  <td>${before.id ?? ''}</td>
  <td>${before.name ?? ''}</td>
  <td>${before.reference ?? ''}</td>
  <td>${before.price ?? ''}</td>
</tr>`;
      }

      // 🔹 APRÈS
      html += `
<tr class="after ${actionClass}">
  <td>${d.toLocaleDateString()} ${d.toLocaleTimeString()}</td>
  <td>${log.action}</td>
  <td>${after.id ?? ''}</td>
  <td>${cell(before.name, after.name)}</td>
  <td>${cell(before.reference, after.reference)}</td>
  <td>${cell(before.price, after.price)}</td>
</tr>`;

      return html;
    }).join('');

    const { renderProduitsHTML } = require('./produits.view');

    res.send(renderProduitsHTML({
      logsHtml
    }));

  } catch (err) {
    console.error('❌ Erreur /produits:', err.message);
    res.status(500).send('Erreur page produits (voir console)');
  }
});

// -------------------------
// ROUTE - DEVIS SIGNE
// -------------------------
app.get('/devis-signe', async (req, res) => {
  try {
    const devis = await getDevisSignes();
    res.send(renderDevisSigneHTML(devis));
  } catch (err) {
    console.error('❌ Erreur devis signés Axonaut', err.message);
    res.status(500).send('Erreur récupération devis signés');
  }
});


// -------------------------
// LANCEMENT SERVEUR
// -------------------------
http.listen(process.env.PORT,()=>{
  console.log(`🚀 API AGM lancée sur http://localhost:${process.env.PORT}`);
  console.log(`🌍 Dashboard live: http://localhost:${process.env.PORT}/logs`);
  console.log(`🌍 Webhook URL Axonaut: https://ton-domaine-ngrok/webhook/axonaut`);
});
