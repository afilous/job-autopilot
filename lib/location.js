/**
 * lib/location.js -- NEW FILE
 *
 * Every ATS source returns location differently:
 *   - Greenhouse/Lever/Ashby: single string, e.g. "San Francisco, CA"
 *   - Workday (via Tsenta data): array of strings, e.g. ["Pleasanton, CA", "Santa Clara, CA"]
 *   - SmartRecruiters: structured { city, region, country }
 *   - Workable: structured { city, state, country, telecommuting: bool }
 *   - Recruitee: string + separate remote: bool flag
 *
 * Consolidating this in one place means scoring logic doesn't need to know
 * about source-specific shapes -- it just calls normalizeLocation() and
 * gets back a consistent { text, isRemote, isBayArea, country } shape.
 */

const EXCLUDE_COUNTRY_SIGNALS = [
  'united kingdom', ' uk,', ' uk ', 'emea', 'germany', 'france', 'canada',
  'toronto', 'vancouver', 'montreal', 'ontario', 'british columbia',
  'australia', 'singapore', 'india', 'apac', 'japan', 'mexico', 'brazil',
  'argentina', 'chile', 'bangalore', 'chennai', 'gurugram', 'poland',
  ', pl', 'spain', 'catalonia', 'dubai', 'morocco', 'casablanca',
];

const REMOTE_SIGNALS = [
  'remote', 'anywhere', 'distributed', 'work from home', 'wfh',
  'us remote', 'usa remote', 'united states remote', 'north america remote',
  'nationwide', 'remote-usa', 'remote - usa',
];

const BAY_AREA_SIGNALS = [
  'san francisco', 'sf,', ' sf ', 'bay area', 'palo alto', 'mountain view',
  'menlo park', 'san mateo', 'foster city', 'redwood city', 'redwood shores',
  'sunnyvale', 'santa clara', 'cupertino', 'campbell', 'san jose', 'oakland',
  'berkeley', 'burlingame', 'south san francisco', 'milpitas', 'fremont',
  'pleasanton', 'walnut creek', 'silicon valley', 'peninsula', 'emeryville',
  'san carlos',
];

// Accepts: a string, an array of strings, or a structured object with any
// combination of { city, state, region, country, remote, telecommuting }.
function normalizeLocation(raw) {
  let text = '';
  let structuredRemote = false;

  if (Array.isArray(raw)) {
    text = raw.filter(Boolean).join(' | ');
  } else if (raw && typeof raw === 'object') {
    const parts = [raw.city, raw.state, raw.region, raw.country].filter(Boolean);
    text = parts.join(', ');
    structuredRemote = !!(raw.remote || raw.telecommuting);
  } else {
    text = raw || '';
  }

  const lower = text.toLowerCase();
  const noLocation = !lower || lower.length < 2;
  const isExcludedCountry = EXCLUDE_COUNTRY_SIGNALS.some(k => lower.includes(k));
  const isRemote = structuredRemote || REMOTE_SIGNALS.some(k => lower.includes(k));
  const isBayArea = BAY_AREA_SIGNALS.some(k => lower.includes(k));

  return {
    text,
    isRemote,
    isBayArea,
    noLocation,
    isExcludedCountry,
    // Convenience: does this location pass Aaron's Bay-Area-or-remote filter?
    passesLocationFilter: !isExcludedCountry && (isRemote || isBayArea || noLocation),
  };
}

module.exports = { normalizeLocation, EXCLUDE_COUNTRY_SIGNALS, REMOTE_SIGNALS, BAY_AREA_SIGNALS };
