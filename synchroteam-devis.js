const axios = require("axios");

// =========================
// AUTH & HTTP
// =========================
function stAuthHeader() {
  const domain = process.env.ST_DOMAIN;
  const apiKey = process.env.ST_API_KEY;

  if (!domain || !apiKey) {
    throw new Error("ST_DOMAIN ou ST_API_KEY manquant dans .env");
  }

  return "Basic " + Buffer.from(`${domain}:${apiKey}`).toString("base64");
}

async function stGet(path, params = {}) {
  const res = await axios.get(`https://ws.synchroteam.com${path}`, {
    params,
    headers: {
      Authorization: stAuthHeader(),
      Accept: "application/json",
    },
    timeout: 20000,
  });
  return res.data;
}

async function stPost(path, body = {}) {
  const res = await axios.post(`https://ws.synchroteam.com${path}`, body, {
    headers: {
      Authorization: stAuthHeader(),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });
  return res.data;
}

// =========================
// HELPERS
// =========================
function normalizeOuiNon(v) {
  return String(v || "").trim().toLowerCase();
}

function pickReportValue(reportArray, wantedLabel) {
  if (!Array.isArray(reportArray)) return null;

  const wanted = wantedLabel.trim().toLowerCase();

  const item = reportArray.find(r =>
    String(r?.nmItem || "").trim().toLowerCase() === wanted
  );

  return item ? item.value : null;
}

// =========================
// MAIN
// =========================
async function listDevisAFaire({ dateFrom, dateTo, max = 50, debug = false } = {}) {

const jobsTermines = (await stPost("/Api/v2/Jobs/Search", { status: 5 }) || [])
  .map(j => ({ ...j, __status: 5 }));

const jobsSuspendus = (await stPost("/Api/v2/Jobs/Search", { status: 4 }) || [])
  .map(j => ({ ...j, __status: 4 }));

const jobs = [
  ...jobsTermines,
  ...jobsSuspendus
];

  const arr = Array.isArray(jobs) ? jobs : [];
  console.log(
  "🧪 RAW JOB SEARCH SAMPLE:",
  JSON.stringify(arr[0], null, 2)
);

  const sliced = arr.slice(0, max);
  const results = [];

console.log(
  "🧪 JOBS SEARCH COUNT:",
  arr.length,
  "IDS:",
  arr.map(j => j.id || j.idJob || j.ID)
);

  for (const j of sliced) {
    const jobStatus = j.__status;
    const id = j?.id || j?.idJob || j?.ID;
    if (!id) continue;

    const detail = await stGet("/Api/v2/Jobs/Detail", { id });
    if (!detail) continue;

    // 🔹 REPORT (clé exacte confirmée)
    const report = Array.isArray(detail.Report) ? detail.Report : [];

    if (debug) {
      console.log("🧪 JOB", detail.num, "REPORT ITEMS =", report.length);
    }

// 🔹 chercher TOUS les équipements avec Devis = Oui
const devisEquipements = report.filter(r => {

  console.log(
    "🧪 DEVIS DEBUG:",
    detail.num,
    r.nmItem,
    JSON.stringify(r.value),
    typeof r.value,
    "→ normalized:",
    normalizeOuiNon(r.value)
  );

  return (
    r.nmItem?.startsWith("Devis A Faire (Équipement") &&
    normalizeOuiNon(r.value) === "oui"
  );
});

    if (devisEquipements.length === 0) continue;

    for (const devisItem of devisEquipements) {
      const equipement = devisItem.nmItem
        .replace("Devis A Faire (", "")
        .replace(")", "");

      const refPiecesMO =
        pickReportValue(
          report,
          `Référence des Pièces et MO (Devis ${equipement})`
        ) || "";

      const commentaire =
        pickReportValue(report, "Commentaire") || "";

        console.log("debug");
      results.push({
        id,
        num: detail.num || "",
        client: detail.CustomerName || "",
        axonautClientId: detail.CustomerCode || "",
        equipement,
        commentaire,
        refPiecesMO,
        realEndDate: detail.RealEndDate || "",
        status: jobStatus,
      });
    }
  }

  return results;
}

module.exports = {
  listDevisAFaire,
  stGet,
  stPost,
  pickReportValue
};
