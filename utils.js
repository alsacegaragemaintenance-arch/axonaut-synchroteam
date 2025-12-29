const fs = require('fs');
const path = require('path');

// -------------------------
// Utils génériques
// -------------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadJSON(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), 'utf8');
    return defaultValue;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function highlightChanges(oldStr = '', newStr = '') {
  if (oldStr === newStr) return newStr;
  const maxLen = Math.max(oldStr.length, newStr.length);
  let result = '';
  for (let i = 0; i < maxLen; i++) {
    const o = oldStr[i] || '';
    const n = newStr[i] || '';
    result += o !== n
      ? `<span style="background-color:yellow;">${n}</span>`
      : n;
  }
  return result;
}

function isInBusinessHours() {
  const hour = new Date().getHours();
  return hour >= 7 && hour < 21;
}

module.exports = {
  sleep,
  loadJSON,
  saveJSON,
  highlightChanges,
  isInBusinessHours
};
