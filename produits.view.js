// produits.view.js
// ===================================================
// VUE HTML – PRODUITS
// ⚠️ HTML UNIQUEMENT – AUCUNE LOGIQUE
// ===================================================

function renderProduitsHTML({
  produitsRows
}) {
  return `
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

      <table>
        <thead>
          <tr>
            <th>Nom</th>
            <th>Référence</th>
            <th>Prix</th>
            <th>Dernière MAJ</th>
          </tr>
        </thead>
      </table>

      <br>
      <a href="/">⬅ Retour</a>

    </body>
    </html>
`;
}

module.exports = { renderProduitsHTML };
