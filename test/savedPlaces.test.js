const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePlace, guessKind, sameLabel, sortPlaces, formatPlace } = require('../lib/savedPlaces');

const base = { label: ' Home ', address: '12 Oak Street,  London', coords: { lat: 51.5, lng: -0.12 } };

test('a valid place is cleaned and keeps its coordinates', () => {
  const { place, error } = parsePlace(base);
  assert.equal(error, undefined);
  assert.deepEqual(place, { label: 'Home', address: '12 Oak Street, London', lat: 51.5, lng: -0.12, kind: 'home' });
});

test('coordinates are required so the trip can be priced', () => {
  assert.match(parsePlace({ ...base, coords: null }).error, /suggestions/);
  assert.match(parsePlace({ ...base, coords: { lat: 0, lng: 0 } }).error, /suggestions/);
  assert.match(parsePlace({ ...base, coords: { lat: 95, lng: 0 } }).error, /suggestions/);
  assert.equal(parsePlace({ label: 'X', address: 'Some road', lat: '51.2', lng: '-1' }).place.lat, 51.2);
});

test('names and addresses are checked', () => {
  assert.match(parsePlace({ ...base, label: '' }).error, /name/);
  assert.match(parsePlace({ ...base, label: 'x'.repeat(41) }).error, /40/);
  assert.match(parsePlace({ ...base, address: 'ab' }).error, /address/);
});

test('the icon is guessed from the name unless chosen', () => {
  assert.equal(guessKind('Grandma\'s house'), 'home');
  assert.equal(guessKind('St Mary School'), 'school');
  assert.equal(guessKind('Piano lesson'), 'activity');
  assert.equal(guessKind('Aunt Joy'), 'other');
  assert.equal(parsePlace({ ...base, label: 'Piano', kind: 'school' }).place.kind, 'school');
  assert.equal(parsePlace({ ...base, label: 'Piano', kind: 'spaceship' }).place.kind, 'activity');
});

test('labels compare without case or spacing; home and school come first', () => {
  assert.ok(sameLabel('  school', 'SCHOOL'));
  const rows = [
    { id: '1', label: 'Piano', kind: 'activity', lat: 1, lng: 1 },
    { id: '2', label: 'School', kind: 'school', lat: 1, lng: 1 },
    { id: '3', label: 'Home', kind: 'home', lat: 1, lng: 1 },
    { id: '4', label: 'Aunt', kind: 'other', lat: 1, lng: 1 }
  ].map(formatPlace);
  assert.deepEqual(sortPlaces(rows).map((p) => p.label), ['Home', 'School', 'Piano', 'Aunt']);
});
