// Saved places: a parent names an address once (Home, School, Piano lesson)
// and picks it as pickup or drop-off when booking. Coordinates are stored with
// each place, so a ride booked from a saved place is priced by the fare engine
// rather than the minimum-fare fallback.

const MAX_PLACES = 20;
const KINDS = ['home', 'school', 'activity', 'other'];

const text = (value) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '');
const coord = (value, limit) => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
};

// Guess an icon from the name when the parent did not choose one.
const guessKind = (label) => {
  const name = label.toLowerCase();
  if (/\b(home|house|mum|mom|dad|grandma|granny|nan|grandpa)\b/.test(name)) return 'home';
  if (/\b(school|academy|college|nursery|daycare|kindergarten|preschool)\b/.test(name)) return 'school';
  if (/\b(lesson|class|club|practice|training|piano|swim|football|soccer|dance|music|gym|tutor|ballet|karate)\b/.test(name)) return 'activity';
  return 'other';
};

// Returns { place } with clean values, or { error } with a message for the parent.
const parsePlace = (body = {}) => {
  const label = text(body.label);
  const address = text(body.address);
  const lat = coord(body.lat ?? body.coords?.lat, 90);
  const lng = coord(body.lng ?? body.coords?.lng, 180);
  if (!label || label.length > 40) return { error: 'Give the place a short name, up to 40 characters, like Home or School.' };
  if (address.length < 3 || address.length > 300) return { error: 'Enter the address for this place.' };
  if (lat === null || lng === null || (lat === 0 && lng === 0)) return { error: 'Pick the address from the suggestions so we know exactly where it is.' };
  const kind = KINDS.includes(body.kind) ? body.kind : guessKind(label);
  return { place: { label, address, lat, lng, kind } };
};

const sameLabel = (a, b) => text(a).toLowerCase() === text(b).toLowerCase();

const formatPlace = (row) => ({
  id: row.id,
  label: row.label,
  address: row.address,
  kind: KINDS.includes(row.kind) ? row.kind : 'other',
  coords: { lat: Number(row.lat), lng: Number(row.lng) },
  createdAt: row.created_at,
  updatedAt: row.updated_at || row.created_at
});

// Home first, then school, then the rest by name.
const KIND_ORDER = { home: 0, school: 1, activity: 2, other: 3 };
const sortPlaces = (places) => [...places].sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || a.label.localeCompare(b.label));

module.exports = { MAX_PLACES, KINDS, parsePlace, guessKind, sameLabel, formatPlace, sortPlaces };
