// devis-signe.view.js
// ===================================================
// PAGE DEVIS SIGNÉ – AXONAUT (LECTURE SEULE)
// Étape 1 : page squelette
// ===================================================

function renderDevisSigneHTML(devis = []) {
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Devis signés - Axonaut</title>
<style>
body{font-family:Arial;padding:20px;}
table{border-collapse:collapse;width:100%;}
th,td{border:1px solid #ccc;padding:8px;text-align:left;}
th{background:#f4f4f4;}
</style>
</head>

<body>

<h1>📄 Devis signés (Axonaut)</h1>

<table>
<thead>
<tr>
  <th>Date</th>
  <th>Client</th>
  <th>Numéro devis</th>
  <th>Montant</th>
  <th>Statut</th>
  <th>Lien Axonaut</th>
</tr>
</thead>
<tbody>
${devis.map(d => `
<tr>
  <td>${d.date}</td>
  <td>${d.client}</td>
  <td>${d.number}</td>
  <td>${d.amount} €</td>
  <td>${d.status}</td>
  <td><a href="${d.url}" target="_blank">Ouvrir</a></td>
</tr>
`).join('')}
</tbody>
</table>

<br>
<a href="/">← Retour au dashboard</a>

</body>
</html>
`;
}

module.exports = { renderDevisSigneHTML };
