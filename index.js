require('dotenv').config();

// =====================================================
// IMPORTS & CONFIGURATION GLOBALE
// =====================================================
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { listDevisAFaire } = require("./synchroteam-devis");
const { stGet, stPost, pickReportValue } = require("./synchroteam-devis");
const STATUS_ROW_COLORS = {
  1: "#FEF3C7", // Brouillon
  2: "#F3F4F6", // Planifié
  3: "#D1FAE5", // Démarré (vert)  ← (on met le vert ici)
  4: "#f7bf7eff", // Suspendu (orange) ← (orange sur 4)
  5: "rgba(76, 152, 252, 1)", // Terminé (bleu)    ← (bleu sur 5)
  6: "#CBD5E1", // Validé / autre (gris bleuté)
  7: "#9CA3AF", // fallback si tu l’utilises
};



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
  getProductsMeta,
  syncProducts // import conservé pour usage FUTUR (webhook produits)
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
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

function hasChanged(oldClient,newClient){
  if(!oldClient) return true;
  return (
    oldClient.name!==newClient.name ||
    oldClient.address!==newClient.address ||
    oldClient.address2!==newClient.address2 ||
    oldClient.addressZIP!==newClient.addressZIP ||
    oldClient.addressCity!==newClient.addressCity ||
    oldClient.contactPhone!==newClient.contactPhone ||
    oldClient.contactMobile!==newClient.contactMobile ||
    oldClient.contactEmail!==newClient.contactEmail
  );
}

function highlightChanges(prevVal,currVal){
  if(!prevVal) return currVal||'';
  let res='';
  for(let i=0;i<currVal.length;i++){
    if(currVal[i]!==prevVal[i]) res+='<span style="color:red;font-weight:bold">'+currVal[i]+'</span>';
    else res+=currVal[i];
  }
  return res;
}

// -------------------------
// LOGGING
// -------------------------
function logSync(entry){
  try{
    const logs=JSON.parse(fs.readFileSync(LOG_FILE,'utf8'));
    logs.push(entry);
    fs.writeFileSync(LOG_FILE,JSON.stringify(logs,null,2),'utf8');
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
async function processCustomer(customer){
  if(!customer.myId) return; // 🔹 ignorer clients sans ID
  const oldClient=clientCache[customer.myId]||null;
  const errorEntry=errorQueue.find(e=>e.myId===customer.myId && e.stopped);
  if(errorEntry){ console.log(`⚠️ Client ${customer.name} ignoré car erreur après 3 tentatives`); return; }

  if(hasChanged(oldClient,customer)){
    const result=await createOrUpdateCustomer(customer);
    const dashboardEntry={
      before:oldClient?{...oldClient}:null,
      after:{...customer},
      action:result.action,
      timestamp:new Date().toISOString(),
      error:result.error
    };
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
    const axoUrl='https://axonaut.com/api/v2/companies';
    const axoHeaders={ 'userApiKey':process.env.AXO_API_KEY,'Accept':'application/json' };
    let page=1;
    while(true){
      if(quotaUsedToday>=quotaMax){ console.warn('⚠️ Quota quotidien atteint, arrêt synchro'); break; }
      let response;
      try{
        response=await axios.get(axoUrl,{headers:{...axoHeaders,page},params:{limit:100}});
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
cron.schedule('0 */4 * * *', async () => {
  console.log('⏱️ Cron Axonaut déclenché (toutes les 4h)');

  // ⛔ Hors plage horaire
  if (!isBusinessHours()) {
    console.log('🌙 Hors horaires (07h–20h) → cron annulé');
    return;
  }

  // ⛔ Quota trop bas
  if (!isQuotaSafe(quotaStatus, 300)) {
    console.log('⛔ Quota Axonaut trop bas → synchro CLIENTS annulée');
    return;
  }

  try {
    await syncClientsOptimized();
  } catch (err) {
    console.error('❌ Erreur synchro cron CLIENTS:', err.message);
  }
});

// -------------------------
// WEBHOOK AXONAUT pour synchro instantanée
// -------------------------
app.post('/webhook/axonaut', async (req, res) => {
  console.log('📩 Webhook Axonaut reçu');
  console.log('Headers:', req.headers);
  console.log('Body brut:', JSON.stringify(req.body, null, 2));

  // 🔑 Axonaut envoie toujours les données dans body.data
  const company = req.body?.data;

  if (!company || !company.internal_id) {
    console.log('⚠️ Webhook ignoré : internal_id manquant');
    return res.status(200).send('Ignored: no internal_id');
  }

  const contact = (company.employees && company.employees[0]) || {};
  const customer = {
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

  console.log('➡️ Client extrait depuis webhook:', customer.name, `(ID ${customer.myId})`);

  await processCustomer(customer);

  res.status(200).send('OK');
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
     
res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Synchroteam – Devis à faire</title>
<style>
body{font-family:Arial;padding:20px;}
table{border-collapse:collapse;width:100%;margin-top:15px;}
th,td{border:1px solid #ccc;padding:8px;text-align:left;vertical-align:top;}
th{background:#f4f4f4;}
.header{
  display:flex;
  gap:15px;
  align-items:center;
  flex-wrap:wrap;
}
.badge{
  background:#2c3e50;
  color:#fff;
  padding:6px 10px;
  border-radius:6px;
  font-weight:bold;
}
</style>

</head>
<body>

<div class="header">
  <div class="badge">Synchroteam</div>
  <div>Bons terminés avec <b>Devis à faire = OUI</b></div>
  <div>Période : <code>${dateFrom}</code> → <code>${dateTo}</code></div>
  <div>Total : <b>${rows.length}</b></div>
  <div><a href="/logs">⬅ Retour dashboard</a></div>
</div>

<table>
  <thead>
    <tr>
      <th>N°</th>
      <th>Client</th>
      <th>Équipement</th>
      <th>Commentaire</th>
      <th>Références pièces & MO</th>
      <th>Date fin</th>
      <th style="text-align:center;white-space:nowrap;">
        Validation Synchroteam
      </th>
      <th style="text-align:center;white-space:nowrap;">
        Devis Axonaut
      </th>
    </tr>
  </thead>
  <tbody>
    ${tableRows || '<tr><td colspan="6">Aucun bon trouvé</td></tr>'}
  </tbody>
</table>


<!-- ----------------- -->
<!-- COLONNE “COCHE” -->
<!-- ----------------- -->
<script>
document.querySelectorAll(".validate-devis").forEach(cb => {
  cb.addEventListener("change", async () => {

    if (!cb.checked) return;

    const jobId = cb.dataset.jobId;
    const equipement = cb.dataset.equipement;
    const num = cb.dataset.num;

    const confirmRemove = confirm(
      "Voulez-vous vraiment retirer cette fiche de la liste des devis ?"
    );

    if (!confirmRemove) {
      cb.checked = false;
      return;
    }

    const numeroDevis = prompt(
      "Veuillez saisir le numéro de devis pour confirmer :"
    );

    if (!numeroDevis || numeroDevis.trim() === "") {
      alert("Numéro de devis obligatoire. Action annulée.");
      cb.checked = false;
      return;
    }

    try {
      const res = await fetch("/api/st-devis/valider", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          equipement,
          numeroDevis
        })
      });

      if (!res.ok) throw new Error();

      location.reload();

    } catch (e) {
      alert("Erreur lors de la validation du devis.");
      cb.checked = false;
    }
  });
});
</script>

</body>
</html>
    `);

  } catch (err) {
    console.error('❌ Erreur /st-devis:', err?.response?.data || err.message);
    res.status(500).send('Erreur Synchroteam (voir console)');
  }
});

// -------------------------
// DASHBOARD LIVE
// -------------------------
app.get('/logs', async (req, res) => {
  const logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

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

  function renderBeforeRow(log) {
    if (!log.before) return '';
    const d = new Date(log.timestamp);
    return `<tr class="before">
      <td>${d.toLocaleDateString()}</td>
      <td>${d.toLocaleTimeString()}</td>
      <td>${log.before.contactEmail || ''}</td>
      <td>${log.before.name || ''}</td>
      <td>original</td>
      <td>${log.before.contactPhone || ''}</td>
      <td>${log.before.contactMobile || ''}</td>
      <td>${[
        log.before.address,
        log.before.address2,
        log.before.addressZIP,
        log.before.addressCity
      ].filter(Boolean).join(', ')}</td>
    </tr>`;
  }

  function renderAfterRow(log) {
    const d = new Date(log.timestamp);
    const actionClass =
      log.action === 'created' ? 'created' :
      log.action === 'updated' ? 'updated' : '';

    return `<tr class="after ${actionClass}">
      <td>${d.toLocaleDateString()}</td>
      <td>${d.toLocaleTimeString()}</td>
      <td>${highlightChanges(log.before?.contactEmail || '', log.after?.contactEmail || '')}</td>
      <td>${highlightChanges(log.before?.name || '', log.after?.name || '')}</td>
      <td>${log.action}</td>
      <td>${highlightChanges(log.before?.contactPhone || '', log.after?.contactPhone || '')}</td>
      <td>${highlightChanges(log.before?.contactMobile || '', log.after?.contactMobile || '')}</td>
      <td>${highlightChanges(
        [log.before?.address, log.before?.address2, log.before?.addressZIP, log.before?.addressCity].filter(Boolean).join(', '),
        [log.after?.address, log.after?.address2, log.after?.addressZIP, log.after?.addressCity].filter(Boolean).join(', ')
      )}</td>
    </tr>`;
  }

  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Sync Logs AGM - Live</title>
<style>
body{font-family:Arial;padding:20px;}
table{border-collapse:collapse;width:100%;margin-top:10px;}
th,td{border:1px solid #ccc;padding:8px;text-align:left;}
th{background:#f4f4f4;}
tr.before{border-top:2px solid #333;}
tr.after.created{background:#4caf50;color:#fff;}
tr.after.updated{background:#ff9800;color:#fff;}
.error-btn{background:#ff9933;color:#fff;border:none;padding:4px 8px;cursor:pointer;}
#quotaStatus{position:fixed;top:10px;right:10px;background:#2196f3;color:#fff;padding:10px;border-radius:5px;}
#liveConsoleContainer{position:absolute;top:85px;right:10px;width:400px;height:320px;background:#222;color:#0f0;font-family:monospace;font-size:12px;overflow-y:auto;padding:10px;border-radius:5px;}
#mainMenu{
  display:flex;
  gap:15px;
  margin-top:15px;
  margin-bottom:20px;
}

.menu-tile{
  display:flex;
  align-items:center;
  justify-content:center;
  width:160px;
  height:65px;
  background:#2c3e50;
  color:#ffffff;
  font-weight:bold;
  text-decoration:none;
  border-radius:8px;
  letter-spacing:1px;
  transition:all 0.2s ease;
}

.menu-tile:hover{
  background:#1abc9c;
  transform:translateY(-2px);
}

#clientsView{
  display:none;
}

#clientsView.active{
  display:block;
}

/* 🔹 BADGE DEVIS */
.devis-tile{
  position:relative;
}

.badge-count{
  position:absolute;
  top:-8px;
  right:-8px;
  background:#e74c3c;
  color:#fff;
  font-size:12px;
  font-weight:bold;
  padding:4px 7px;
  border-radius:12px;
  min-width:22px;
  text-align:center;
  box-shadow:0 2px 5px rgba(0,0,0,0.3);
}
</style></head>

<body>

<div id="quotaStatus">
Quota Axonaut: ${quotaStatus.used}/${quotaStatus.max}
<br>
Reset dans ${Math.floor(quotaStatus.secondsUntilReset / 3600)}h
${Math.floor((quotaStatus.secondsUntilReset % 3600) / 60)}m
</div>

<div id="mainMenu">
<a href="#" class="menu-tile" onclick="showClients()">CLIENTS</a>
<a href="/st-devis" class="menu-tile devis-tile">
  DEVIS
  ${devisCount > 0 ? `<span class="badge-count">${devisCount}</span>` : ``}
</a>
<a href="/produits" class="menu-tile">PRODUITS</a>
<a href="/archives" class="menu-tile">ARCHIVES</a>
</div>

<div id="liveConsoleContainer">
  <div id="liveConsole">🟢 JS dashboard OK</div>
</div>

<h1 style="margin-top:400px;">📊 Synchronisations Axonaut → Synchroteam</h1>

<div id="clientsView">

<h2>❌ Erreurs</h2>
<table id="errorTable">
<thead>
<tr><th>Nom</th><th>Erreur</th><th>Tentatives</th><th>Action</th></tr>
</thead>
<tbody>
${errors.map(e => `
<tr>
  <td>${e.name}</td>
  <td>${JSON.stringify(e.error)}</td>
  <td>${e.retryCount}</td>
  <td><button class="error-btn" onclick="relaunch('${e.myId}')">Relancer</button></td>
</tr>`).join('')}
</tbody>
</table>

</div>

<h2>🔹 Toutes les synchronisations</h2>
<table id="logTable">
<thead>
<tr>
<th>Date</th><th>Heure</th><th>Mail</th><th>Nom</th>
<th>Action</th><th>Téléphone</th><th>Mobile</th><th>Adresse</th>
</tr>
</thead>
<tbody>
${logs.map(l => renderBeforeRow(l) + renderAfterRow(l)).join('')}
</tbody>
</table>

<script src="/socket.io/socket.io.js"></script>
<script>
document.addEventListener('DOMContentLoaded', () => {

  const socket = io();

  // LOGS NODE
  socket.on('nodeLog', line => {
    const c = document.getElementById('liveConsole');
    if (!c) return;
    const d = document.createElement('div');
    d.textContent = line;
    c.prepend(d);
    if (c.children.length > 15) c.removeChild(c.lastChild);
  });

  // QUOTA
  socket.on('quotaUpdate', q => {
    socket.on('initQuota', q => {
  document.getElementById('quotaStatus').innerHTML =
    'Quota Axonaut: ' + q.used + '/' + q.max +
    '<br>Reset dans ' +
    Math.floor(q.secondsUntilReset / 3600) + 'h ' +
    Math.floor((q.secondsUntilReset % 3600) / 60) + 'm';
});
    const el = document.getElementById('quotaStatus');
    if (el) el.innerText = 'Quota Axonaut: ' + q.used + '/' + q.max;
  });

  // ERREURS LIVE
  socket.on('errorQueueUpdate', errors => {
    const tbody = document.querySelector('#errorTable tbody');
    if (!tbody) return;

    tbody.innerHTML = '';
    errors.forEach(e => {
      tbody.insertAdjacentHTML(
        'beforeend',
        \`<tr>
          <td>\${e.name}</td>
          <td>\${JSON.stringify(e.error)}</td>
          <td>\${e.retryCount}</td>
          <td><button class="error-btn" onclick="relaunch('\${e.myId}')">Relancer</button></td>
        </tr>\`
      );
    });
  });

  // SYNCHROS LIVE
  socket.on('newSync', log => {
    const tbody = document.querySelector('#logTable tbody');
    if (!tbody) return;

    const d = new Date(log.timestamp);
    const actionClass =
      log.action === 'created' ? 'created' :
      log.action === 'updated' ? 'updated' : '';

    let html = '';

    if (log.before) {
      html += \`<tr class="before">
        <td>\${d.toLocaleDateString()}</td>
        <td>\${d.toLocaleTimeString()}</td>
        <td>\${log.before.contactEmail || ''}</td>
        <td>\${log.before.name || ''}</td>
        <td>original</td>
        <td>\${log.before.contactPhone || ''}</td>
        <td>\${log.before.contactMobile || ''}</td>
        <td>\${[
          log.before.address,
          log.before.address2,
          log.before.addressZIP,
          log.before.addressCity
        ].filter(Boolean).join(', ')}</td>
      </tr>\`;
    }

    html += \`<tr class="after \${actionClass}">
      <td>\${d.toLocaleDateString()}</td>
      <td>\${d.toLocaleTimeString()}</td>
      <td>\${log.after?.contactEmail || ''}</td>
      <td>\${log.after?.name || ''}</td>
      <td>\${log.action}</td>
      <td>\${log.after?.contactPhone || ''}</td>
      <td>\${log.after?.contactMobile || ''}</td>
      <td>\${[
        log.after?.address,
        log.after?.address2,
        log.after?.addressZIP,
        log.after?.addressCity
      ].filter(Boolean).join(', ')}</td>
    </tr>\`;

    tbody.insertAdjacentHTML('afterbegin', html);
  });

  window.relaunch = id => socket.emit('manualRetry', id);

});
</script>

<script>
function showClients(){
  document.getElementById('clientsView')?.classList.add('active');
}
</script>

</script>

function confirmerRetraitDevis(checkbox, jobId, equipement) {

  const ok = confirm(
    "Souhaitez-vous vraiment retirer ce devis de la liste ?\o\n" +
    "Cette action est définitive."
  );

  // ❌ NON → on annule
  if (!ok) {
    checkbox.checked = false;
    return;
  }

  // ✅ OUI → on lance le traitement
  checkbox.disabled = true;

  const row = checkbox.closest("tr");
  if (row) {
    row.style.opacity = "0.5";
    row.style.pointerEvents = "none";
  }

  validerDevis(jobId, equipement, row);
}

</script>

<script>
/**
 * Appel API serveur pour :
 * 1) Copier Référence → Observations
 * 2) Passer Devis A Faire = Non
 */
function validerDevis(jobId, equipement, row) {

  fetch('/api/st-devis/valider', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      jobId: jobId,
      equipement: equipement
    })
  })
  .then(function (res) {
    if (!res.ok) {
      throw new Error('Erreur serveur');
    }

    // Suppression visuelle de la ligne
    setTimeout(function () {
      if (row) {
        row.remove();
      }
    }, 400);
  })
  .catch(function (err) {
    alert('❌ Erreur lors du retrait du devis');

    // Restauration visuelle en cas d’erreur
    if (row) {
      row.style.opacity = '1';
      row.style.pointerEvents = 'auto';
    }
  });
}
</script>

</body>
</html>
`);
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
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
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
// ROUTE PRODUITS
// -------------------------

app.get('/produits', (req, res) => {
  const products = getProducts();
  const meta = getProductsMeta();

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Produits</title>
      <style>
        body { font-family: Arial; padding: 20px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border: 1px solid #ccc; padding: 6px; }
        th { background: #f2f2f2; }
      </style>
    </head>
    <body>

      <h1>📦 PRODUITS</h1>
      <p>Total : <strong>${meta.total}</strong></p>

      <table>
        <thead>
          <tr>
            <th>Nom</th>
            <th>Référence</th>
            <th>Prix</th>
            <th>Dernière MAJ</th>
          </tr>
        </thead>
        <tbody>
let products = getProducts();

if (!Array.isArray(products)) {
  products = [];
}

${products.map(p => `
  <tr>
              <td>${p.name}</td>
              <td>${p.reference || ''}</td>
              <td>${p.price != null ? p.price + ' €' : ''}</td>
              <td>${p.updated_at || ''}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <br>
      <a href="/">⬅ Retour</a>

    </body>
    </html>
  `);
});

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

// -------------------------
// LANCEMENT SERVEUR
// -------------------------
http.listen(process.env.PORT,()=>{
  console.log(`🚀 API AGM lancée sur http://localhost:${process.env.PORT}`);
  console.log(`🌍 Dashboard live: http://localhost:${process.env.PORT}/logs`);
  console.log(`🌍 Webhook URL Axonaut: https://ton-domaine-ngrok/webhook/axonaut`);
});
