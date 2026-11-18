const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePlate, validPlate } = require('../lib/security');

test('licence plates: 2 to 8 letters and digits, spaces, dashes and dots aside', () => {
  for (const plate of ['ABC-1234', 'abc 1234', '7XYZ123', 'AB12 CDE', 'KIDRIDE1', 'AB.12']) assert.equal(validPlate(plate), true, plate);
  for (const plate of ['A', 'ABCDEFGHI', 'ABC@123', '', '   ', 'ÀBC123', null, undefined]) assert.equal(validPlate(plate), false, String(plate));
});

test('licence plates are stored upper case without spaces or dashes', () => {
  assert.equal(normalizePlate('abc-1 234'), 'ABC1234');
  assert.equal(normalizePlate(' ab12 cde '), 'AB12CDE');
});
