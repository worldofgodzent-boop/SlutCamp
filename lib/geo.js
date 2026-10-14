'use strict';
/*
 * lib/geo.js — visitor geolocation + region-block matching (SlutCamp).
 *
 * Models can block regions (country / state / county / city) so fans in
 * those places never see them. This module resolves a visitor's IP to a
 * region and decides whether a model's block list matches it.
 *
 * Data:
 *  - geoip-lite (bundled GeoLite data): country, US state, city, lat/lon.
 *  - data/us-geo.json (built from GeoNames): US county list + centroids,
 *    city -> county mapping, and city names per county for the UI.
 *
 * FAIL-OPEN by design: if a location cannot be resolved, nothing blocks.
 * A model would rather be seen by one extra person than vanish for everyone
 * because a lookup failed.
 */
const fs = require('fs');
const path = require('path');

let geoip = null;
try { geoip = require('geoip-lite'); } catch (e) { geoip = null; }

let US = { counties: {}, cityCounty: {}, countyCities: {} };
try {
  US = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'us-geo.json'), 'utf8'));
} catch (e) { /* county features degrade gracefully */ }
// District of Columbia is an ADM1 in GeoNames (no ADM2 row) — patch in.
if (!US.counties.DC) {
  US.counties.DC = { 'District of Columbia': [38.8951, -77.0363] };
  US.cityCounty.DC = { washington: 'District of Columbia' };
  US.countyCities.DC = { 'District of Columbia': ['Washington'] };
}

const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

/* ISO 3166-1 alpha-2 — the country list offered in the blocker UI. */
const COUNTRIES = [
  ['US', 'United States'], ['CA', 'Canada'], ['MX', 'Mexico'], ['GB', 'United Kingdom'],
  ['IE', 'Ireland'], ['AU', 'Australia'], ['NZ', 'New Zealand'], ['DE', 'Germany'],
  ['FR', 'France'], ['ES', 'Spain'], ['PT', 'Portugal'], ['IT', 'Italy'],
  ['NL', 'Netherlands'], ['BE', 'Belgium'], ['CH', 'Switzerland'], ['AT', 'Austria'],
  ['SE', 'Sweden'], ['NO', 'Norway'], ['DK', 'Denmark'], ['FI', 'Finland'],
  ['PL', 'Poland'], ['CZ', 'Czechia'], ['SK', 'Slovakia'], ['HU', 'Hungary'],
  ['RO', 'Romania'], ['BG', 'Bulgaria'], ['GR', 'Greece'], ['HR', 'Croatia'],
  ['RS', 'Serbia'], ['UA', 'Ukraine'], ['RU', 'Russia'], ['TR', 'Turkey'],
  ['IL', 'Israel'], ['AE', 'United Arab Emirates'], ['SA', 'Saudi Arabia'],
  ['QA', 'Qatar'], ['KW', 'Kuwait'], ['IN', 'India'], ['PK', 'Pakistan'],
  ['BD', 'Bangladesh'], ['LK', 'Sri Lanka'], ['NP', 'Nepal'], ['PH', 'Philippines'],
  ['ID', 'Indonesia'], ['MY', 'Malaysia'], ['SG', 'Singapore'], ['TH', 'Thailand'],
  ['VN', 'Vietnam'], ['JP', 'Japan'], ['KR', 'South Korea'], ['CN', 'China'],
  ['HK', 'Hong Kong'], ['TW', 'Taiwan'], ['BR', 'Brazil'], ['AR', 'Argentina'],
  ['CL', 'Chile'], ['CO', 'Colombia'], ['PE', 'Peru'], ['VE', 'Venezuela'],
  ['EC', 'Ecuador'], ['BO', 'Bolivia'], ['PY', 'Paraguay'], ['UY', 'Uruguay'],
  ['CR', 'Costa Rica'], ['PA', 'Panama'], ['GT', 'Guatemala'], ['DO', 'Dominican Republic'],
  ['CU', 'Cuba'], ['JM', 'Jamaica'], ['TT', 'Trinidad and Tobago'], ['BS', 'Bahamas'],
  ['ZA', 'South Africa'], ['NG', 'Nigeria'], ['KE', 'Kenya'], ['GH', 'Ghana'],
  ['EG', 'Egypt'], ['MA', 'Morocco'], ['DZ', 'Algeria'], ['ET', 'Ethiopia'],
  ['IS', 'Iceland'], ['EE', 'Estonia'], ['LV', 'Latvia'], ['LT', 'Lithuania'],
  ['SI', 'Slovenia'], ['BA', 'Bosnia and Herzegovina'], ['MK', 'North Macedonia'],
  ['AL', 'Albania'], ['ME', 'Montenegro'], ['MD', 'Moldova'], ['BY', 'Belarus'],
  ['GE', 'Georgia'], ['AM', 'Armenia'], ['AZ', 'Azerbaijan'], ['KZ', 'Kazakhstan'],
  ['UZ', 'Uzbekistan'], ['IQ', 'Iraq'], ['IR', 'Iran'], ['AF', 'Afghanistan'],
  ['MM', 'Myanmar'], ['KH', 'Cambodia'], ['LA', 'Laos'], ['BN', 'Brunei'],
  ['FJ', 'Fiji'], ['PG', 'Papua New Guinea'], ['PR', 'Puerto Rico'],
  ['VI', 'U.S. Virgin Islands'], ['GU', 'Guam'], ['LU', 'Luxembourg'],
  ['MT', 'Malta'], ['CY', 'Cyprus'], ['JO', 'Jordan'], ['LB', 'Lebanon'],
  ['OM', 'Oman'], ['BH', 'Bahrain'], ['YE', 'Yemen'], ['SY', 'Syria'],
  ['LK', 'Sri Lanka'], ['MV', 'Maldives'], ['BT', 'Bhutan'], ['MN', 'Mongolia'],
];
const COUNTRY_NAMES = Object.fromEntries(COUNTRIES);

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function countyForCoords(state, lat, lon) {
  const counties = US.counties[state];
  if (!counties || lat == null || lon == null) return null;
  let best = null, bestKm = Infinity;
  for (const [name, [clat, clon]] of Object.entries(counties)) {
    const km = haversineKm(lat, lon, clat, clon);
    if (km < bestKm) { bestKm = km; best = name; }
  }
  // County internal points can sit far from a big rural county's edge —
  // accept the nearest county within a generous radius, else unknown.
  return bestKm <= 160 ? best : null;
}

function countyFor(state, city, lat, lon) {
  if (!state) return null;
  const byCity = US.cityCounty[state];
  if (byCity && city) {
    const hit = byCity[normName(city)];
    if (hit) return hit;
  }
  return countyForCoords(state, lat, lon);
}

const _cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 10000;

function isPrivateIp(ip) {
  return !ip || ip === '::1' || ip === '127.0.0.1' ||
    ip.startsWith('10.') || ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || ip.startsWith('fc') || ip.startsWith('fe80');
}

/**
 * Resolve an IP to { country, countryName, state, stateName, city, county, lat, lon }.
 * Returns null when the location can't be determined (callers fail open).
 */
function lookupIp(rawIp) {
  if (!geoip) return null;
  const ip = String(rawIp || '').replace(/^::ffff:/, '').trim();
  if (isPrivateIp(ip)) return null;
  const now = Date.now();
  const cached = _cache.get(ip);
  if (cached && cached.exp > now) return cached.geo;
  let geo = null;
  try {
    const r = geoip.lookup(ip);
    if (r && r.country) {
      const state = r.country === 'US' ? (r.region || null) : null;
      const lat = r.ll && r.ll.length === 2 ? r.ll[0] : null;
      const lon = r.ll && r.ll.length === 2 ? r.ll[1] : null;
      geo = {
        country: r.country,
        countryName: COUNTRY_NAMES[r.country] || r.country,
        state,
        stateName: state ? (US_STATES[state] || state) : null,
        city: r.city || null,
        county: state ? countyFor(state, r.city, lat, lon) : null,
        lat, lon,
      };
    }
  } catch (e) { geo = null; }
  if (_cache.size >= CACHE_MAX) _cache.clear();
  _cache.set(ip, { geo, exp: now + CACHE_TTL_MS });
  return geo;
}

/** Does one block row match this geo? */
function blockMatches(block, geo) {
  if (!block || !geo) return false;
  switch (block.level) {
    case 'country':
      return geo.country === block.country_code;
    case 'state':
      return geo.country === 'US' && geo.state === block.state_code;
    case 'county':
      return geo.country === 'US' && geo.state === block.state_code &&
        !!geo.county && normName(geo.county) === normName(block.county_name);
    case 'city':
      if (geo.country !== block.country_code) return false;
      if (block.country_code === 'US' && geo.state !== block.state_code) return false;
      return !!geo.city && normName(geo.city) === normName(block.city_name);
    default:
      return false;
  }
}

function matchesAny(blocks, geo) {
  if (!geo || !Array.isArray(blocks)) return false;
  return blocks.some((b) => blockMatches(b, geo));
}

module.exports = {
  lookupIp,
  matchesAny,
  blockMatches,
  normName,
  US_STATES,
  COUNTRIES,
  COUNTRY_NAMES,
  countiesFor: (state) => Object.keys(US.counties[state] || {}).sort(),
  citiesFor: (state, county) =>
    ((US.countyCities[state] || {})[county] || []).slice(),
  citiesForState: (state) => {
    const seen = new Set();
    for (const list of Object.values(US.countyCities[state] || {})) {
      for (const name of list) seen.add(name);
    }
    return [...seen].sort().slice(0, 800);
  },
};
