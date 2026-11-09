const { test } = require('node:test');
const assert = require('node:assert/strict');
const series = require('../lib/series');

// Thursday 2026-11-05 12:00 UTC (07:20 in New York, EST).
const now = new Date('2026-11-05T12:20:00Z');
const plan = (over = {}) => ({ weekdays: [1, 2, 3, 4, 5], pickupLocalTime: '07:45', timeZone: 'America/New_York', startDate: '2026-11-05', endDate: '2026-11-20', skippedDates: [], ...over });

test('local pickup time converts to UTC across daylight saving', () => {
  assert.equal(series.zonedTime('2026-10-30', '07:45', 'America/New_York').toISOString(), '2026-10-30T11:45:00.000Z');
  assert.equal(series.zonedTime('2026-11-02', '07:45', 'America/New_York').toISOString(), '2026-11-02T12:45:00.000Z');
  assert.equal(series.zonedTime('2026-11-02', '07:45', 'Europe/London').toISOString(), '2026-11-02T07:45:00.000Z');
});

test('a week of school days, weekends and too-soon pickups left out', () => {
  const days = series.occurrences(plan(), now).map((d) => d.date);
  // Today 07:45 is under 30 minutes away (now is 07:20): skipped. Sat/Sun skipped.
  assert.deepEqual(days, ['2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']);
});

test('skipped days and the end date are respected', () => {
  const days = series.upcomingDays(plan({ skippedDates: ['2026-11-10'], weekdays: [2, 4] }), now).map((d) => d.date);
  assert.deepEqual(days, ['2026-11-12', '2026-11-17', '2026-11-19']);
});

test('plan validation', () => {
  const ok = series.normalizePlan({ ...plan(), weekdays: [5, 1, 1] }, now);
  assert.deepEqual(ok.weekdays, [1, 5]);
  assert.match(series.normalizePlan({ ...plan(), timeZone: 'Mars/Base' }, now).error, /time zone/);
  assert.match(series.normalizePlan({ ...plan(), pickupLocalTime: '07:47' }, now).error, /5-minute/);
  assert.match(series.normalizePlan({ ...plan(), startDate: '2026-11-01' }, now).error, /passed/);
  assert.match(series.normalizePlan({ ...plan(), endDate: '2027-12-01' }, now).error, /up to/);
  assert.match(series.normalizePlan({ ...plan(), weekdays: [0], startDate: '2026-11-06', endDate: '2026-11-07' }, now).error, /No ride days/);
});
