const { test } = require('node:test');
const assert = require('node:assert/strict');
const { anonymisedProfile, anonymisedChild, blockingRide, deletedEmail } = require('../lib/account');

const now = new Date(Date.UTC(2026, 10, 6, 18));

test('a deleted profile keeps no personal details and cannot sign in', () => {
  const profile = anonymisedProfile('abc', now);
  assert.equal(profile.name, 'Deleted user');
  assert.equal(profile.email, deletedEmail('abc'));
  assert.match(profile.email, /\.invalid$/);
  assert.equal(profile.phone, null);
  assert.equal(profile.photo_url, null);
  assert.deepEqual(profile.vehicle, {});
  assert.equal(profile.is_blocked, true);
  assert.equal(profile.deleted_at, now.toISOString());
});

test('children are archived without name, notes or photo', () => {
  const child = anonymisedChild(now);
  assert.equal(child.name, 'Deleted child');
  assert.equal(child.notes, null);
  assert.equal(child.photo_url, null);
  assert.equal(child.archived_at, now.toISOString());
});

test('a ride under way blocks deletion; unstarted scheduled rides do not', () => {
  assert.equal(blockingRide([]), null);
  assert.equal(blockingRide([{ status: 'driver_assigned', is_scheduled: true }]), null);
  assert.equal(blockingRide([{ status: 'searching_driver', is_scheduled: true }]), null);
  assert.ok(blockingRide([{ status: 'searching_driver', is_scheduled: false }]));
  assert.ok(blockingRide([{ status: 'child_picked_up', is_scheduled: true }]));
  assert.ok(blockingRide([{ status: 'driver_arrived_at_pickup', is_scheduled: true }]));
  assert.equal(blockingRide([{ status: 'completed' }, { status: 'cancelled' }]), null);
});
