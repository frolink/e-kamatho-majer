/**
 * backend/utils/nameMatch.js
 * AML name-matching utility (mirror dari transfiClient.namesMatch).
 */
function normalize(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function namesMatch(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb)  return true;
  const short = (na.length <= nb.length ? na : nb).split(' ');
  const long  =  na.length <= nb.length ? nb : na;
  return short.every(w => w.length > 1 && long.includes(w));
}

module.exports = { normalize, namesMatch };
