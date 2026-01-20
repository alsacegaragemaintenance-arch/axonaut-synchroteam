// st-devis.view.js
// ===================================================
// VUE HTML – SYNCHROTEAM / DEVIS À FAIRE
// ===================================================

function renderStDevisHTML({
  dateFrom,
  dateTo,
  rowsCount,
  tableRows
}) {
  return `
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
  <div>Total : <b>${rowsCount}</b></div>
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
    ${tableRows || '<tr><td colspan="8">Aucun bon trouvé</td></tr>'}
  </tbody>
</table>

<script>
document.querySelectorAll(".validate-devis").forEach(cb => {
  cb.addEventListener("change", async () => {

    if (!cb.checked) return;

    const jobId = cb.dataset.jobId;
    const equipement = cb.dataset.equipement;

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
`;
}

module.exports = { renderStDevisHTML };
