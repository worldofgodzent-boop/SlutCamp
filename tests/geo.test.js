'use strict';
/*
 * Unit tests for lib/geo.js — region-block matching.
 *
 * The block decision is pure logic over a resolved geo object, so these
 * tests fabricate geo objects and never touch the network. lookupIp()
 * itself is only exercised on private/loopback input, which must fail
 * open (return null) by design.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const geo = require('../lib/geo.js');

const GEO_TX = { country: 'US', countryName: 'United States', state: 'TX', stateName: 'Texas', city: 'San Antonio', county: 'Bexar', lat: 29.42, lon: -98.49 };
const GEO_CA = { country: 'CA', countryName: 'Canada', state: null, stateName: null, city: 'Toronto', county: null, lat: 43.65, lon: -79.38 };

test('normName lowercases, strips punctuation/accents and collapses spaces', () => {
  assert.equal(geo.normName('  San   Antonio! '), 'san antonio');
  assert.equal(geo.normName('Bexar County'), 'bexar county');
  assert.equal(geo.normName('Montréal'), 'montreal');
  assert.equal(geo.normName(''), '');
  assert.equal(geo.normName(null), '');
  assert.equal(geo.normName(undefined), '');
});

test('country-level block matches only that country', () => {
  const block = { level: 'country', country_code: 'US' };
  assert.equal(geo.blockMatches(block, GEO_TX), true);
  assert.equal(geo.blockMatches(block, GEO_CA), false);
});

test('state-level block matches only US visitors in that state', () => {
  const block = { level: 'state', country_code: 'US', state_code: 'TX' };
  assert.equal(geo.blockMatches(block, GEO_TX), true);
  assert.equal(geo.blockMatches(block, { ...GEO_TX, state: 'OK' }), false);
  assert.equal(geo.blockMatches(block, GEO_CA), false);
});

test('county-level block normalizes county names', () => {
  const block = { level: 'county', country_code: 'US', state_code: 'TX', county_name: 'Bexar' };
  assert.equal(geo.blockMatches(block, GEO_TX), true);
  assert.equal(geo.blockMatches(block, { ...GEO_TX, county: 'Travis' }), false);
  // A visitor whose county could not be resolved is never county-blocked.
  assert.equal(geo.blockMatches(block, { ...GEO_TX, county: null }), false);
});

test('city-level block checks country, US state, and normalized city', () => {
  const block = { level: 'city', country_code: 'US', state_code: 'TX', city_name: 'san antonio' };
  assert.equal(geo.blockMatches(block, GEO_TX), true);
  assert.equal(geo.blockMatches(block, { ...GEO_TX, city: 'Austin' }), false);
  assert.equal(geo.blockMatches(block, { ...GEO_TX, state: 'OK' }), false);
  const caBlock = { level: 'city', country_code: 'CA', city_name: 'Toronto' };
  assert.equal(geo.blockMatches(caBlock, GEO_CA), true);
  assert.equal(geo.blockMatches(caBlock, GEO_TX), false);
});

test('unknown block levels never match', () => {
  assert.equal(geo.blockMatches({ level: 'planet', country_code: 'US' }, GEO_TX), false);
  assert.equal(geo.blockMatches({}, GEO_TX), false);
});

test('fail-open: null block or null geo never matches', () => {
  assert.equal(geo.blockMatches(null, GEO_TX), false);
  assert.equal(geo.blockMatches({ level: 'country', country_code: 'US' }, null), false);
  assert.equal(geo.matchesAny([{ level: 'country', country_code: 'US' }], null), false);
  assert.equal(geo.matchesAny(null, GEO_TX), false);
  assert.equal(geo.matchesAny('not-an-array', GEO_TX), false);
  assert.equal(geo.matchesAny([], GEO_TX), false);
});

test('matchesAny is true when any block in the list matches', () => {
  const blocks = [
    { level: 'country', country_code: 'GB' },
    { level: 'state', country_code: 'US', state_code: 'TX' },
  ];
  assert.equal(geo.matchesAny(blocks, GEO_TX), true);
  assert.equal(geo.matchesAny(blocks, GEO_CA), false);
});

test('lookupIp fails open (null) for private, loopback and empty IPs', () => {
  assert.equal(geo.lookupIp('127.0.0.1'), null);
  assert.equal(geo.lookupIp('::1'), null);
  assert.equal(geo.lookupIp('10.0.0.5'), null);
  assert.equal(geo.lookupIp('192.168.1.10'), null);
  assert.equal(geo.lookupIp('172.16.0.9'), null);
  assert.equal(geo.lookupIp('::ffff:127.0.0.1'), null);
  assert.equal(geo.lookupIp(''), null);
  assert.equal(geo.lookupIp(null), null);
  assert.equal(geo.lookupIp(undefined), null);
});

test('reference data: US states and country names are populated', () => {
  assert.equal(geo.US_STATES.TX, 'Texas');
  assert.equal(geo.US_STATES.CA, 'California');
  assert.equal(geo.COUNTRY_NAMES.US, 'United States');
  assert.ok(Array.isArray(geo.COUNTRIES) && geo.COUNTRIES.length > 100);
});

test('county/city reference data loads from data/us-geo.json', () => {
  const txCounties = geo.countiesFor('TX');
  assert.ok(txCounties.includes('Bexar'), 'TX counties should include Bexar');
  assert.ok(txCounties.includes('Travis'), 'TX counties should include Travis');
  assert.deepEqual(geo.countiesFor('XX'), []);
  const bexarCities = geo.citiesFor('TX', 'Bexar');
  assert.ok(bexarCities.includes('San Antonio'), 'Bexar cities should include San Antonio');
});
