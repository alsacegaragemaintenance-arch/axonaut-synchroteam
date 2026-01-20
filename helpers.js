// helpers.js
// ===================================================
// HELPERS PURS – EXTRAITS À L’IDENTIQUE DE index.js
// ⚠️ NE RIEN MODIFIER / NE RIEN SIMPLIFIER
// ===================================================



// ---- Timing helper ----
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

// ---- Comparaison client ----
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

// ---- Dashboard helpers ----
function highlightChanges(prevVal,currVal){
  if(!prevVal) return currVal||'';
  let res='';
  for(let i=0;i<currVal.length;i++){
    if(currVal[i]!==prevVal[i]) res+='<span style="color:red;font-weight:bold">'+currVal[i]+'</span>';
    else res+=currVal[i];
  }
  return res;
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

module.exports = {
  sleep,
  hasChanged,
  highlightChanges,
  renderBeforeRow,
  renderAfterRow
};
