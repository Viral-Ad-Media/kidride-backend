const { test } = require('node:test');
const assert = require('node:assert/strict');
const carpools = require('../lib/carpools');

const NOW = Date.parse('2026-11-18T10:00:00Z');
const at = (minutes) => new Date(NOW + minutes * 60000).toISOString();
const home = { lat: 6.5, lng: 3.3 };
const school = { lat: 6.52, lng: 3.35 };
const base = { name: ' Saturday   football ', pickup: '12 Oak Street', pickupCoords: home, dropoff: 'City Stadium', dropoffCoords: school, pickupTime: at(120), seats: 4 };

// A stand-in for the database over in-memory tables: just the filters the carpool code uses.
const fakeDb = (tables) => ({
  from: (table) => {
    let rows = [...(tables[table] || [])];
    const query = {
      select: () => query,
      eq: (column, value) => { rows = rows.filter((row) => row[column] === value); return query; },
      in: (column, values) => { rows = rows.filter((row) => values.includes(row[column])); return query; },
      maybeSingle: async () => ({ data: rows[0] || null, error: null }),
      then: (resolve) => resolve({ data: rows, error: null })
    };
    return query;
  }
});

test('a carpool needs a name, two picked addresses, a bookable time and 2 to 4 seats', () => {
  const { carpool, error } = carpools.parseCarpool(base, NOW);
  assert.equal(error, undefined);
  assert.deepEqual(carpool, { name: 'Saturday football', pickup_location: '12 Oak Street', pickup_coords: home, dropoff_location: 'City Stadium', dropoff_coords: school, pickup_time: at(120), seats: 4 });
  assert.match(carpools.parseCarpool({ ...base, name: 'x' }, NOW).error, /name/);
  assert.match(carpools.parseCarpool({ ...base, name: 'x'.repeat(61) }, NOW).error, /60/);
  assert.match(carpools.parseCarpool({ ...base, pickupCoords: null }, NOW).error, /suggestions/);
  assert.match(carpools.parseCarpool({ ...base, dropoff: '12 Oak Street', dropoffCoords: home }, NOW).error, /./);
  assert.match(carpools.parseCarpool({ ...base, pickupTime: at(10) }, NOW).error, /Carpools must be at least 30 minutes/);
  assert.match(carpools.parseCarpool({ ...base, pickupTime: 'soon' }, NOW).error, /valid/);
  assert.match(carpools.parseCarpool({ ...base, seats: 5 }, NOW).error, /2 to 4/);
  assert.match(carpools.parseCarpool({ ...base, seats: 1 }, NOW).error, /2 to 4/);
  assert.equal(carpools.parseCarpool({ ...base, seats: undefined }, NOW).carpool.seats, 4);
});

test('a family can only send its own children, each once', () => {
  const own = [{ id: 'c1' }, { id: 'c2' }];
  assert.deepEqual(carpools.parseChildIds(['c1', 'c2'], own), { childIds: ['c1', 'c2'] });
  assert.equal(carpools.parseChildIds(['c1', 'someone-elses'], own).status, 403);
  assert.match(carpools.parseChildIds(['c1', 'c1'], own).error, /once/);
  assert.match(carpools.parseChildIds([], own).error, /at least one/);
  assert.deepEqual(carpools.parseChildIds([], own, { allowNone: true }), { childIds: [] });
  assert.match(carpools.parseChildIds('c1', own).error, /Choose/);
  assert.match(carpools.parseChildIds([42], own).error, /Choose/);
});

test('invite codes avoid look-alike characters and tolerate how people type them', () => {
  for (let i = 0; i < 200; i += 1) assert.match(carpools.generateCode(), /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(carpools.normalizeCode(' abc-234 '), 'ABC234');
  assert.equal(carpools.normalizeCode('ABC23'), '');
  assert.equal(carpools.normalizeCode('ABC10O'), '');
  assert.equal(carpools.normalizeCode(undefined), '');
});

test('a carpool is open until booked or an hour past its time; a cancelled ride reopens it', () => {
  const carpool = { status: 'open', pickup_time: at(120) };
  assert.equal(carpools.carpoolState(carpool, null, NOW), 'open');
  assert.equal(carpools.carpoolState({ ...carpool, pickup_time: at(-30) }, null, NOW), 'open');
  assert.equal(carpools.carpoolState({ ...carpool, pickup_time: at(-61) }, null, NOW), 'expired');
  assert.equal(carpools.carpoolState(carpool, { status: 'searching_driver' }, NOW), 'booked');
  assert.equal(carpools.carpoolState({ ...carpool, pickup_time: at(-300) }, { status: 'child_picked_up' }, NOW), 'booked');
  assert.equal(carpools.carpoolState(carpool, { status: 'completed' }, NOW), 'completed');
  assert.equal(carpools.carpoolState(carpool, { status: 'cancelled' }, NOW), 'open');
  assert.equal(carpools.carpoolState({ ...carpool, status: 'cancelled' }, { status: 'completed' }, NOW), 'cancelled');
});

const carpool = { id: 'pool-1', organiser_id: 'p1', name: 'Saturday football', pickup_location: '12 Oak Street', pickup_coords: home, dropoff_location: 'City Stadium', dropoff_coords: school, pickup_time: at(120), seats: 4, invite_code: 'ABC234', status: 'open', ride_id: null };
const members = [
  { carpool_id: 'pool-1', parent_id: 'p2', child_ids: ['c3'], joined_at: at(-50) },
  { carpool_id: 'pool-1', parent_id: 'p1', child_ids: ['c1', 'c2'], joined_at: at(-60) }
];
const people = new Map([['p1', { id: 'p1', name: 'Grace Lee' }], ['p2', { id: 'p2', name: 'Tunde Ade' }]]);
const children = new Map([['c1', { id: 'c1', name: 'Ava Lee', age: 8 }], ['c2', { id: 'c2', name: 'Leo Lee', age: 6 }], ['c3', { id: 'c3', name: 'Mia Ade', age: 7 }]]);

test('families see first names, seats and the code; the organiser\'s children come first', () => {
  const view = carpools.formatCarpoolFor('p2', carpool, members, people, children, null, { now: NOW });
  assert.equal(view.state, 'open');
  assert.equal(view.isOrganiser, false);
  assert.equal(view.isMember, true);
  assert.equal(view.organiserName, 'Grace');
  assert.equal(view.inviteCode, 'ABC234');
  assert.deepEqual([view.seats, view.seatsTaken, view.seatsLeft], [4, 3, 1]);
  assert.deepEqual(view.myChildIds, ['c3']);
  assert.deepEqual(view.families, [
    { name: 'Grace', isYou: false, isOrganiser: true, children: [{ name: 'Ava', age: 8 }, { name: 'Leo', age: 6 }] },
    { name: 'Tunde', isYou: true, isOrganiser: false, children: [{ name: 'Mia', age: 7 }] }
  ]);
  assert.equal(view.ride, null);
  assert.deepEqual(carpools.allChildIds(carpool, members), ['c1', 'c2', 'c3']);
  // No surnames, account ids or child ids of other families leave the server.
  assert.doesNotMatch(JSON.stringify(view.families), /Lee|Ade|p1|p2|c1|c2/);
});

test('someone holding only the code sees the trip but not who is in it', () => {
  const view = carpools.formatCarpoolFor('stranger', carpool, members, people, children, null, { now: NOW });
  assert.equal(view.isMember, false);
  assert.equal(view.inviteCode, null);
  assert.deepEqual(view.families, []);
  assert.deepEqual(view.myChildIds, []);
  assert.equal(view.seatsLeft, 1);
  assert.equal(view.organiserName, 'Grace');
});

test('once booked, families see the driver, the hand-over words and their share of the fare', () => {
  const ride = {
    id: 'ride-1', status: 'driver_assigned', price: 24, currency: 'USD', trip_code: '4821', safe_word: 'maple', pickup_time: at(120), driver_id: 'd1',
    driver: { id: 'd1', name: 'Ada Obi', phone: '+15550100', is_verified_driver: true, vehicle: { make: 'Toyota', plate: 'ABC123' } },
    driver_location: { latitude: 6.51, longitude: 3.31, heading: 90 }
  };
  const booked = { ...carpool, status: 'booked', ride_id: 'ride-1' };
  const view = carpools.formatCarpoolFor('p2', booked, members, people, children, ride, { now: NOW, photoUrl: 'https://signed.example/photo' });
  assert.equal(view.state, 'booked');
  assert.equal(view.inviteCode, null);
  assert.equal(view.ride.perChild, 8);
  assert.equal(view.ride.myShare, 8);
  assert.equal(view.ride.tripCode, '4821');
  assert.equal(view.ride.safeWord, 'maple');
  assert.deepEqual(view.ride.driver, { name: 'Ada Obi', photoUrl: 'https://signed.example/photo', phone: '+15550100', isVerifiedDriver: true, vehicle: { make: 'Toyota', plate: 'ABC123' } });
  assert.equal(carpools.formatCarpoolFor('p1', booked, members, people, children, ride, { now: NOW }).ride.myShare, 16);
  // Nobody outside the carpool sees the ride, even with the code.
  assert.equal(carpools.formatCarpoolFor('stranger', booked, members, people, children, ride, { now: NOW }).ride, null);
  // A cancelled ride no longer shows; the carpool is open again.
  const reopened = carpools.formatCarpoolFor('p1', booked, members, people, children, { ...ride, status: 'cancelled' }, { now: NOW });
  assert.equal(reopened.state, 'open');
  assert.equal(reopened.ride, null);
});

test('only the organiser can book, with every family\'s children and the carpool\'s own trip', async () => {
  const db = fakeDb({ carpools: [carpool], carpool_members: members, rides: [] });
  const booking = await carpools.prepareBooking(db, { id: 'p1' }, 'pool-1', { scheduled: true, now: NOW });
  assert.deepEqual(booking.childIds, ['c1', 'c2', 'c3']);
  assert.deepEqual(booking.trip, { pickupLocation: '12 Oak Street', dropoffLocation: 'City Stadium', pickupCoords: home, dropoffCoords: school, pickupTime: at(120), scheduled: true });
  await assert.rejects(carpools.prepareBooking(db, { id: 'p2' }, 'pool-1', { scheduled: true, now: NOW }), { status: 403 });
  await assert.rejects(carpools.prepareBooking(db, { id: 'p1' }, 'missing', { scheduled: true, now: NOW }), { status: 404 });
  await assert.rejects(carpools.prepareBooking(db, { id: 'p1' }, '', { scheduled: true, now: NOW }), { status: 400 });
  // Two hours ahead it is booked for its time, not as a ride for now.
  await assert.rejects(carpools.prepareBooking(db, { id: 'p1' }, 'pool-1', { scheduled: false, now: NOW }), { status: 409 });
});

test('a carpool cannot be booked twice, empty, cancelled or long after its time', async () => {
  const booked = { ...carpool, status: 'booked', ride_id: 'ride-1' };
  await assert.rejects(carpools.prepareBooking(fakeDb({ carpools: [booked], carpool_members: members, rides: [{ id: 'ride-1', status: 'driver_assigned' }] }), { id: 'p1' }, 'pool-1', { scheduled: true, now: NOW }), { status: 409, message: /already has a ride/ });
  // Its ride was cancelled: it can be booked again.
  const again = await carpools.prepareBooking(fakeDb({ carpools: [booked], carpool_members: members, rides: [{ id: 'ride-1', status: 'cancelled' }] }), { id: 'p1' }, 'pool-1', { scheduled: true, now: NOW });
  assert.equal(again.childIds.length, 3);
  await assert.rejects(carpools.prepareBooking(fakeDb({ carpools: [carpool], carpool_members: [{ ...members[1], child_ids: [] }] }), { id: 'p1' }, 'pool-1', { scheduled: true, now: NOW }), { status: 409, message: /No children/ });
  await assert.rejects(carpools.prepareBooking(fakeDb({ carpools: [{ ...carpool, status: 'cancelled' }], carpool_members: members }), { id: 'p1' }, 'pool-1', { scheduled: true, now: NOW }), { status: 409, message: /cancelled/ });
  await assert.rejects(carpools.prepareBooking(fakeDb({ carpools: [{ ...carpool, pickup_time: at(-90) }], carpool_members: members }), { id: 'p1' }, 'pool-1', { scheduled: false, now: NOW }), { status: 409, message: /passed/ });
  // Twenty minutes before the time it is too late to book ahead, but it can go out as a ride for now.
  const soon = fakeDb({ carpools: [{ ...carpool, pickup_time: at(20) }], carpool_members: members });
  await assert.rejects(carpools.prepareBooking(soon, { id: 'p1' }, 'pool-1', { scheduled: true, now: NOW }), { status: 409, message: /too close/ });
  const now = await carpools.prepareBooking(soon, { id: 'p1' }, 'pool-1', { scheduled: false, now: NOW });
  assert.equal(now.trip.scheduled, false);
  assert.equal(now.trip.pickupTime, undefined);
});

test('the other families of a carpool ride are found for trip news; ordinary rides have none', async () => {
  const db = fakeDb({ carpools: [{ ...carpool, ride_id: 'ride-1' }], carpool_members: members });
  assert.deepEqual(await carpools.memberIdsForRide(db, { id: 'ride-1', parent_id: 'p1' }), ['p2']);
  assert.deepEqual(await carpools.memberIdsForRide(db, { id: 'ride-9', parent_id: 'p1' }), []);
  assert.deepEqual(await carpools.memberIdsForRide(db, null), []);
  // A database without the carpool tables (or any failure) must never stop a ride's notifications.
  assert.deepEqual(await carpools.memberIdsForRide({ from: () => { throw new Error('no table'); } }, { id: 'ride-1', parent_id: 'p1' }), []);
});
