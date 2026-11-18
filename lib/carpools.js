// Carpools: families who know each other share one KidRide ride. A parent sets
// up the trip and gets an invite code; other parents join with it and choose
// which of their children ride; the organiser then books one ride for everyone
// through the normal booking, so the driver is a verified KidRide driver.
//
// The rules live here; routes/carpoolRoutes.js serves them and the ride booking
// (routes/rideRoutes.js) asks `prepareBooking` which children a carpool brings.
// Nothing here loads the database: callers pass it in.

const { randomInt } = require('node:crypto');
const { MAX_CHILDREN_PER_RIDE } = require('./pricing');
const { parsePlaceCoords, isSamePlace, SAME_PLACE_MESSAGE } = require('./security');
const scheduling = require('./scheduling');

const MINUTE = 60 * 1000;
// Letters and digits that cannot be mistaken for each other when read out or typed (no 0/O, 1/I).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MIN_SEATS = 2;
const MAX_SEATS = MAX_CHILDREN_PER_RIDE;
// Carpools a parent can have waiting to be booked at one time.
const MAX_OPEN_PER_PARENT = 5;
// An unbooked carpool stays joinable and bookable until this long after its pickup time, then it is over.
const LATE_BOOKING_MS = 60 * MINUTE;
const NOT_READY = 'Carpools are not switched on yet. Please try again later.';

const fail = (status, message) => Object.assign(new Error(message), { status });
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const clean = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

const generateCode = () => Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
/** A code as typed or pasted ("abc-234", " ABC234 "), ready to look up; '' when it cannot be a code. */
const normalizeCode = (value) => {
  const code = String(value || '').toUpperCase().replace(/[\s-]/g, '');
  return /^[A-HJ-NP-Z2-9]{6}$/.test(code) ? code : '';
};

/** A new carpool as the organiser described it, checked; or why it cannot be saved. */
const parseCarpool = (body, now = Date.now()) => {
  const name = clean(body?.name);
  if (name.length < 2) return { error: 'Give the carpool a name, such as "Saturday football".' };
  if (name.length > 60) return { error: 'Keep the name under 60 characters.' };
  const pickupLocation = clean(body.pickupLocation ?? body.pickup);
  const dropoffLocation = clean(body.dropoffLocation ?? body.dropoff);
  if (pickupLocation.length < 3 || dropoffLocation.length < 3) return { error: 'Choose where the children meet and where they are going.' };
  if (pickupLocation.length > 300 || dropoffLocation.length > 300) return { error: 'That address is too long.' };
  const pickupCoords = parsePlaceCoords(body.pickupCoords);
  const dropoffCoords = parsePlaceCoords(body.dropoffCoords);
  // The exact points are needed to price the shared ride and to send the nearest driver.
  if (!pickupCoords || !dropoffCoords) return { error: 'Pick both addresses from the suggestions.' };
  if (isSamePlace(pickupLocation, dropoffLocation, pickupCoords, dropoffCoords)) return { error: SAME_PLACE_MESSAGE };
  const pickupTime = new Date(body.pickupTime);
  const timeError = scheduling.validateScheduledTime(pickupTime, now);
  if (timeError) return { error: timeError.replace('Scheduled rides', 'Carpools') };
  const seats = body.seats === undefined ? MAX_SEATS : body.seats;
  if (!Number.isInteger(seats) || seats < MIN_SEATS || seats > MAX_SEATS) return { error: `A carpool takes ${MIN_SEATS} to ${MAX_SEATS} children.` };
  return {
    carpool: {
      name,
      pickup_location: pickupLocation,
      pickup_coords: pickupCoords,
      dropoff_location: dropoffLocation,
      dropoff_coords: dropoffCoords,
      pickup_time: pickupTime.toISOString(),
      seats
    }
  };
};

/**
 * Which of their own children a parent is sending: distinct ids, all theirs.
 * An organiser may send none (they are arranging it for others); a family that joins sends at least one.
 */
const parseChildIds = (input, ownChildren, { allowNone = false } = {}) => {
  if (!Array.isArray(input) || input.some((id) => typeof id !== 'string' || !id)) return { error: 'Choose which children are riding.' };
  const ids = [...new Set(input)];
  if (ids.length !== input.length) return { error: 'Choose each child once.' };
  if (!ids.length && !allowNone) return { error: 'Choose at least one child.' };
  if (ids.length > MAX_SEATS) return { error: `A carpool takes up to ${MAX_SEATS} children.` };
  const own = new Set((ownChildren || []).map((child) => child.id));
  if (!ids.every((id) => own.has(id))) return { error: 'Select children from your account.', status: 403 };
  return { childIds: ids };
};

const seatsTaken = (members) => (members || []).reduce((sum, member) => sum + (member.child_ids || []).length, 0);

/**
 * Where a carpool stands for the people in it:
 * open (families can join, not booked) | booked (a ride is on its way or under way) |
 * completed | expired (never booked and its time has passed) | cancelled.
 */
const carpoolState = (carpool, ride, now = Date.now()) => {
  if (carpool.status === 'cancelled') return 'cancelled';
  if (ride && ride.status === 'completed') return 'completed';
  if (ride && ride.status !== 'cancelled') return 'booked';
  return Date.parse(carpool.pickup_time) + LATE_BOOKING_MS < now ? 'expired' : 'open';
};

/** Every child in the car, the organiser's first, then families in the order they joined. */
const allChildIds = (carpool, members) => [...(members || [])]
  .sort((a, b) => (a.parent_id === carpool.organiser_id ? -1 : b.parent_id === carpool.organiser_id ? 1 : String(a.joined_at).localeCompare(String(b.joined_at))))
  .flatMap((member) => member.child_ids || []);

const money = (value) => Math.round(Number(value) * 100) / 100;

/**
 * A carpool as one of its families sees it. `people` maps account id to
 * { name }, `children` child id to { name, age }. Names are first names only.
 * `ride` is the linked ride row (with its driver) once booked; `photoUrl` the driver's face photo link.
 */
const formatCarpoolFor = (userId, carpool, members, people, children, ride = null, { now = Date.now(), photoUrl = null } = {}) => {
  const state = carpoolState(carpool, ride, now);
  const taken = seatsTaken(members);
  const mine = (members || []).find((member) => member.parent_id === userId) || null;
  const ordered = [...(members || [])].sort((a, b) => (a.parent_id === carpool.organiser_id ? -1 : b.parent_id === carpool.organiser_id ? 1 : String(a.joined_at).localeCompare(String(b.joined_at))));
  const liveRide = ride && ride.status !== 'cancelled' ? ride : null;
  const driver = liveRide?.driver && typeof liveRide.driver === 'object' ? liveRide.driver : null;
  const perChild = liveRide && taken > 0 ? money(Number(liveRide.price) / taken) : null;
  return {
    id: carpool.id,
    name: carpool.name,
    pickupLocation: carpool.pickup_location,
    dropoffLocation: carpool.dropoff_location,
    pickupCoords: carpool.pickup_coords || null,
    dropoffCoords: carpool.dropoff_coords || null,
    pickupTime: carpool.pickup_time,
    seats: carpool.seats,
    seatsTaken: taken,
    seatsLeft: Math.max(0, carpool.seats - taken),
    state,
    isOrganiser: carpool.organiser_id === userId,
    isMember: !!mine,
    organiserName: firstName(people.get(carpool.organiser_id)?.name) || 'A parent',
    // The code lets more families in, so it is shown only while that is possible, and only to families already in.
    inviteCode: mine && state === 'open' ? carpool.invite_code : null,
    myChildIds: mine ? mine.child_ids || [] : [],
    families: mine ? ordered.map((member) => ({
      name: firstName(people.get(member.parent_id)?.name) || 'A parent',
      isYou: member.parent_id === userId,
      isOrganiser: member.parent_id === carpool.organiser_id,
      children: (member.child_ids || []).map((id) => children.get(id)).filter(Boolean)
        .map((child) => ({ name: firstName(child.name), age: Number(child.age) || null }))
    })) : [],
    ride: mine && liveRide ? {
      id: liveRide.id,
      status: liveRide.status,
      pickupTime: liveRide.pickup_time || carpool.pickup_time,
      price: Number(liveRide.price) || 0,
      currency: liveRide.currency || 'USD',
      // The fare is paid by the organiser; this is what each child's place comes to, for settling up between families.
      perChild,
      myShare: perChild === null ? null : money(perChild * (mine.child_ids || []).length),
      // Whoever hands the children over needs these: the driver says the safe word, the family gives the code.
      tripCode: liveRide.trip_code || '',
      safeWord: liveRide.safe_word || '',
      tripCodeVerified: !!liveRide.trip_code_verified_at,
      safetyAlert: liveRide.safety_alert || null,
      driver: driver ? {
        name: driver.name,
        photoUrl: photoUrl || driver.photo_url || null,
        phone: driver.phone || null,
        isVerifiedDriver: !!driver.is_verified_driver,
        vehicle: driver.vehicle && typeof driver.vehicle === 'object' ? driver.vehicle : {}
      } : null,
      driverLocation: liveRide.driver_location || null
    } : null
  };
};

const schemaMissing = (error) => ['42703', '42P01', 'PGRST204', 'PGRST205'].includes(error?.code);

const loadMembers = async (db, carpoolIds) => {
  if (!carpoolIds.length) return [];
  const { data, error } = await db.from('carpool_members').select('carpool_id, parent_id, child_ids, joined_at').in('carpool_id', carpoolIds);
  if (error) throw error;
  return data || [];
};

/** First names of the parents and children of these members, keyed by id. */
const loadPeople = async (db, carpools, members) => {
  const parentIds = [...new Set([...carpools.map((carpool) => carpool.organiser_id), ...members.map((member) => member.parent_id)])];
  const childIds = [...new Set(members.flatMap((member) => member.child_ids || []))];
  const [parents, kids] = await Promise.all([
    parentIds.length ? db.from('profiles').select('id, name').in('id', parentIds) : { data: [] },
    childIds.length ? db.from('children').select('id, name, age').in('id', childIds) : { data: [] }
  ]);
  if (parents.error) throw parents.error;
  if (kids.error) throw kids.error;
  return {
    people: new Map((parents.data || []).map((row) => [row.id, row])),
    children: new Map((kids.data || []).map((row) => [row.id, row]))
  };
};

/**
 * The other families sharing a ride through a carpool (not the booking parent):
 * they hear the same trip news. Empty for an ordinary ride, and on any failure.
 */
const memberIdsForRide = async (db, ride) => {
  try {
    if (!ride?.id) return [];
    const { data: carpool, error } = await db.from('carpools').select('id').eq('ride_id', ride.id).maybeSingle();
    if (error || !carpool) return [];
    const { data, error: memberError } = await db.from('carpool_members').select('parent_id').eq('carpool_id', carpool.id);
    if (memberError) return [];
    return [...new Set((data || []).map((row) => row.parent_id))].filter((id) => id && id !== ride.parent_id);
  } catch {
    return [];
  }
};

/**
 * The organiser is booking the ride for a carpool. Checks that they may, and
 * returns the children it brings (every family's) and the trip details the
 * ride must be booked with, taken from the carpool itself.
 * Throws with `status` when the carpool cannot be booked.
 */
const prepareBooking = async (db, user, carpoolId, { scheduled, now = Date.now() } = {}) => {
  if (typeof carpoolId !== 'string' || !carpoolId) throw fail(400, 'Choose the carpool to book.');
  const { data: carpool, error } = await db.from('carpools').select('*').eq('id', carpoolId).maybeSingle();
  if (error) throw schemaMissing(error) ? fail(503, NOT_READY) : error;
  if (!carpool) throw fail(404, 'Carpool not found');
  if (carpool.organiser_id !== user.id) throw fail(403, 'Only the parent who set up this carpool can book its ride.');
  if (carpool.status === 'cancelled') throw fail(409, 'This carpool was cancelled.');
  if (carpool.ride_id) {
    const { data: ride, error: rideError } = await db.from('rides').select('id, status').eq('id', carpool.ride_id).maybeSingle();
    if (rideError) throw rideError;
    if (ride && ride.status !== 'cancelled') throw fail(409, 'This carpool already has a ride booked.');
  }
  const pickupMs = Date.parse(carpool.pickup_time);
  if (pickupMs + LATE_BOOKING_MS < now) throw fail(409, 'This carpool\'s time has passed. Set up a new one.');
  // Booked ahead when there is still time for that; otherwise as a ride for now, close to the planned time.
  const canSchedule = !scheduling.validateScheduledTime(new Date(carpool.pickup_time), now);
  if (scheduled && !canSchedule) throw fail(409, 'It is too close to the pickup time to book ahead. Book the ride for now instead.');
  if (!scheduled && pickupMs - now > 45 * MINUTE) throw fail(409, 'Book this carpool for its planned time.');
  const members = await loadMembers(db, [carpool.id]);
  const childIds = allChildIds(carpool, members);
  if (!childIds.length) throw fail(409, 'No children are in this carpool yet.');
  if (childIds.length > MAX_SEATS) throw fail(409, `A ride takes up to ${MAX_SEATS} children. Ask a family to change who is riding.`);
  return {
    carpool,
    childIds,
    trip: {
      pickupLocation: carpool.pickup_location,
      dropoffLocation: carpool.dropoff_location,
      pickupCoords: carpool.pickup_coords,
      dropoffCoords: carpool.dropoff_coords,
      pickupTime: scheduled ? carpool.pickup_time : undefined,
      scheduled: !!scheduled
    }
  };
};

/** The ride was created: the carpool now points at it and is closed to changes. */
const markBooked = async (db, carpoolId, rideId) => {
  const { error } = await db.from('carpools').update({ ride_id: rideId, status: 'booked', updated_at: new Date().toISOString() }).eq('id', carpoolId);
  if (error) throw error;
};

module.exports = {
  CODE_ALPHABET,
  MIN_SEATS,
  MAX_SEATS,
  MAX_OPEN_PER_PARENT,
  LATE_BOOKING_MS,
  NOT_READY,
  generateCode,
  normalizeCode,
  parseCarpool,
  parseChildIds,
  seatsTaken,
  carpoolState,
  allChildIds,
  formatCarpoolFor,
  schemaMissing,
  loadMembers,
  loadPeople,
  memberIdsForRide,
  prepareBooking,
  markBooked
};
