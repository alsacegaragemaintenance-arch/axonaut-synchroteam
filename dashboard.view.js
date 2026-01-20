// dashboard.view.js
// ===================================================
// DASHBOARD HTML – EXTRAIT À L’IDENTIQUE DE index.js
// ⚠️ NE RIEN MODIFIER
// ===================================================

function renderDashboardHTML({
  quotaStatus,
  devisCount,
  errors,
  logs,
  renderBeforeRow,
  renderAfterRow
}) {
  return `
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
/* 🔴 CLIENT SUPPRIMÉ (VISUEL SEULEMENT) */
tr.after.deleted {
  background: #e53935;
  color: #fff;
}

/* === CADRE VISUEL CLIENT (ORIGINAL + UPDATED) === */
tr.client-block-start td {
  border-top: 3px solid #000;
}

tr.client-block-end td {
  border-bottom: 3px solid #000;
}

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
  DEVIS À FAIRE
  ${devisCount > 0 ? `<span class="badge-count">${devisCount}</span>` : ``}
</a>
<a href="/devis-signe" class="menu-tile">DEVIS SIGNÉ</a>
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

${logs.map(l => {
  // 🔴 DELETE : ni before ni after
  if (l.action === 'deleted') {
    const d = new Date(l.timestamp);
    return `
<tr class="after deleted client-block-start client-block-end">
  <td>${d.toLocaleDateString()}</td>
  <td>${d.toLocaleTimeString()}</td>
  <td></td>
  <td></td>
  <td>deleted</td>
  <td></td>
  <td></td>
  <td></td>
</tr>`;
  }

  // 🟢 CREATED / 🟠 UPDATED (logique existante)
  return renderBeforeRow(l) + renderAfterRow(l);
}).join('')}

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

const isCreated = !log.before;

const actionClass = isCreated
  ? 'created'
  : 'updated';

    let html = '';

if (log.before) {
  html += \`<tr class="before client-block-start">
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

html += \`<tr class="after \${actionClass} \${isCreated ? 'client-block-start client-block-end' : 'client-block-end'}">
  <td>\${d.toLocaleDateString()}</td>
  <td>\${d.toLocaleTimeString()}</td>
  <td>\${log.after?.contactEmail || ''}</td>
  <td>\${log.after?.name || ''}</td>
  <td>\${isCreated ? 'created' : 'updated'}</td>
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

<script>
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
`;
}

module.exports = { renderDashboardHTML };
