// Reads the licence plate in a plate photo so it can be compared with the
// registered plate, using the Plate Recognizer Snapshot Cloud API
// (platerecognizer.com). Built for the free plan: 2,500 reads a month, at most
// one call per second, images up to 3 MB. When PLATE_RECOGNIZER_TOKEN is unset,
// the monthly reads are used up, or a call fails, the plate photo goes to an
// admin, who compares the plate by eye, as before.

const API = 'https://api.platerecognizer.com/v1';
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MIN_GAP_MS = 1100; // free plan: 1 call per second

const isReady = () => Boolean(process.env.PLATE_RECOGNIZER_TOKEN?.trim());
const headers = () => ({ Authorization: `Token ${process.env.PLATE_RECOGNIZER_TOKEN.trim()}` });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Calls from one server instance are spaced one second apart. Separate Vercel
// instances can still collide; a 429 then gets one retry after a pause.
let nextSlot = 0;
const waitTurn = async () => {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_GAP_MS;
  if (at > now) await sleep(at - now);
};

const unavailable = (message, code) => Object.assign(new Error(message), { code });

/**
 * Returns { plate, score } for the most confident plate in the image, or null if none was found.
 * Throws (code: too_large | quota_used | bad_token | provider_error) when the photo cannot be read automatically.
 */
const readPlate = async (imageBlob, region = process.env.PLATE_RECOGNIZER_REGION) => {
  if (imageBlob?.size > MAX_IMAGE_BYTES) throw unavailable('Plate photo is over 3 MB', 'too_large');
  for (let attempt = 0; attempt < 2; attempt++) {
    await waitTurn();
    const body = new FormData();
    body.append('upload', imageBlob, 'plate.jpg');
    // Region (for example "us" or "gb") helps the reader with local plate formats; optional.
    if (region?.trim()) body.append('regions', region.trim().toLowerCase());
    const response = await fetch(`${API}/plate-reader/`, { method: 'POST', headers: headers(), body, signal: AbortSignal.timeout(15000) });
    if (response.status === 429 && attempt === 0) { await sleep(1500); continue; }
    if (response.status === 403) throw unavailable('Plate Recognizer monthly reads used up or plan inactive', 'quota_used');
    if (response.status === 401) throw unavailable('Plate Recognizer token rejected', 'bad_token');
    if (response.status === 413) throw unavailable('Plate photo too large for the reader', 'too_large');
    if (!response.ok) throw unavailable(`Plate reader error ${response.status}`, 'provider_error');
    const best = ((await response.json()).results || []).sort((a, b) => (b.score || 0) - (a.score || 0))[0];
    return best ? { plate: String(best.plate || '').toUpperCase(), score: Math.round((best.score || 0) * 100) / 100 } : null;
  }
  throw unavailable('Plate reader busy', 'provider_error');
};

/** This month's usage, for the admin: { used, limit, resetsOn } or null when unavailable. */
const usage = async () => {
  if (!isReady()) return null;
  try {
    const response = await fetch(`${API}/statistics/`, { headers: headers(), signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const data = await response.json();
    return {
      used: Number(data.usage?.calls) || 0,
      limit: Number(data.total_calls) || null,
      resetsOn: data.usage?.resets_on ? String(data.usage.resets_on).slice(0, 10) : null
    };
  } catch { return null; }
};

module.exports = { isReady, readPlate, usage, MAX_IMAGE_BYTES };
