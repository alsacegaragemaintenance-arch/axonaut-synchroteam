// dashboard.render.js
// ===================
// Rendu des lignes dashboard (logs)
// ===================

function renderBeforeRow(log) {
  if (!log || !log.before) return '';

  const d = new Date(log.timestamp);

  return `
<tr class="before client-block-start">
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

  const isDeleted = !!log.before && !log.after;
  const isCreated = !log.before && !!log.after;

  let action = 'updated';
  if (isCreated) action = 'created';
  if (isDeleted) action = 'deleted';

  const blockClass = isCreated || isDeleted
    ? 'client-block-start client-block-end'
    : 'client-block-end';

  return `
<tr class="after ${action} ${blockClass}">
  <td>${d.toLocaleDateString()}</td>
  <td>${d.toLocaleTimeString()}</td>
  <td>${log.after?.contactEmail || log.before?.contactEmail || ''}</td>
  <td>${log.after?.name || log.before?.name || ''}</td>
  <td>${action}</td>
  <td>${log.after?.contactPhone || log.before?.contactPhone || ''}</td>
  <td>${log.after?.contactMobile || log.before?.contactMobile || ''}</td>
  <td>${[
    log.after?.address || log.before?.address,
    log.after?.address2 || log.before?.address2,
    log.after?.addressZIP || log.before?.addressZIP,
    log.after?.addressCity || log.before?.addressCity
  ].filter(Boolean).join(', ')}</td>
</tr>`;
}

module.exports = {
  renderBeforeRow,
  renderAfterRow
};
