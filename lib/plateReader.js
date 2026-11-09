// Reads the licence plate in a plate photo so it can be compared with the
// registered plate. Plate Recognizer (platerecognizer.com; free tier 2,500
// reads a month) when PLATE_RECOGNIZER_TOKEN is set; otherwise isReady() is
// false and an admin compares the plate by eye.

const isReady = () => Boolean(process.env.PLATE_RECOGNIZER_TOKEN);

/** Returns { plate, score } for the most confident plate in the image, or null if none was found. */
const readPlate = async (imageBlob, region = process.env.PLATE_RECOGNIZER_REGION) => {
  const body = new FormData();
  body.append('upload', imageBlob, 'plate.jpg');
  if (region) body.append('regions', region);
  const response = await fetch('https://api.platerecognizer.com/v1/plate-reader/', {
    method: 'POST',
    headers: { Authorization: `Token ${process.env.PLATE_RECOGNIZER_TOKEN}` },
    body,
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Plate reader error ${response.status}`);
  const best = ((await response.json()).results || []).sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  return best ? { plate: String(best.plate || '').toUpperCase(), score: Math.round((best.score || 0) * 100) / 100 } : null;
};

module.exports = { isReady, readPlate };
