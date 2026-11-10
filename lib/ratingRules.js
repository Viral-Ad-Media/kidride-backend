// Rating rules shared by the routes and the summaries. No database access here,
// so the rules are easy to test.

const MAX_COMMENT_LENGTH = 500;
// Ratings can be left (or changed by nobody) for this long after drop-off, like Uber's window.
const RATING_WINDOW_DAYS = 14;
// The headline average uses the most recent ratings only, so a driver can recover
// from an old bad trip (Uber uses the last 500 trips; we are smaller).
const ROLLING_WINDOW = 100;
// When a driver's average falls below this after enough rides, admins are told to review.
const REVIEW_AVERAGE = 4.5;
const REVIEW_MIN_COUNT = 10;

// Parent rates the driver. Compliments for 4-5 stars, issues for 1-3 stars.
const DRIVER_TAGS = {
  compliment: { safe_driving: 'Safe driving', on_time: 'On time', friendly: 'Friendly', clean_car: 'Clean car', great_with_kids: 'Great with kids', smooth_handoff: 'Smooth handoff' },
  issue: { late: 'Late', unsafe_driving: 'Unsafe driving', route_issue: 'Odd route', unfriendly: 'Unfriendly', car_condition: 'Car condition', handoff_problem: 'Handoff problem' }
};
// Driver rates the family (the pickup and drop-off experience).
const FAMILY_TAGS = {
  compliment: { ready_on_time: 'Ready on time', clear_pickup: 'Clear pickup spot', respectful: 'Respectful', lovely_kids: 'Lovely kids' },
  issue: { kept_waiting: 'Kept me waiting', wrong_pickup_spot: 'Wrong pickup spot', rude: 'Rude', unsafe_behaviour: 'Unsafe behaviour' }
};

const tagLabel = (set, tag) => set.compliment[tag] || set.issue[tag] || tag;

/**
 * Checks a rating body. Returns { stars, tags, comment } or { error }.
 * Tags must belong to the star level: compliments for 4-5, issues for 1-3.
 */
const parseRating = (body, set) => {
  const stars = Number(body?.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return { error: 'Choose between 1 and 5 stars' };
  const comment = typeof body?.comment === 'string' ? body.comment.trim() : '';
  if (comment.length > MAX_COMMENT_LENGTH) return { error: `Keep the review under ${MAX_COMMENT_LENGTH} characters` };
  const raw = body?.tags === undefined ? [] : body.tags;
  if (!Array.isArray(raw) || raw.length > 6) return { error: 'Choose up to 6 tags' };
  const allowed = stars >= 4 ? set.compliment : set.issue;
  const tags = [...new Set(raw)];
  if (tags.some((tag) => typeof tag !== 'string' || !Object.hasOwn(allowed, tag))) return { error: 'One of the tags does not fit this rating' };
  return { stars, tags, comment: comment || null };
};

const ratingWindowOpen = (ride, now = Date.now()) => {
  const finished = Date.parse(ride?.completed_at || ride?.updated_at || '');
  return !Number.isFinite(finished) || now - finished <= RATING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
};

/** rows: newest first, each { stars, tags }. */
const summarizeRatings = (rows, set = DRIVER_TAGS) => {
  const recent = (rows || []).slice(0, ROLLING_WINDOW);
  const average = recent.length ? Math.round((recent.reduce((sum, row) => sum + row.stars, 0) / recent.length) * 100) / 100 : null;
  const counts = new Map();
  for (const row of recent) for (const tag of row.tags || []) if (set.compliment[tag]) counts.set(tag, (counts.get(tag) || 0) + 1);
  const compliments = [...counts].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, label: set.compliment[tag], count }));
  return { count: (rows || []).length, average: average === null ? null : Math.round(average * 10) / 10, preciseAverage: average, compliments };
};

const needsReview = (summary) => summary.count >= REVIEW_MIN_COUNT && summary.preciseAverage !== null && summary.preciseAverage < REVIEW_AVERAGE;

// True when the database has not had 20261109_web_push_and_ratings.sql yet
// (missing tags column or family_ratings table), so callers can fall back.
const schemaMissing = (error) => ['42703', '42P01', 'PGRST204', 'PGRST205'].includes(error?.code);

module.exports = { schemaMissing, MAX_COMMENT_LENGTH, RATING_WINDOW_DAYS, ROLLING_WINDOW, REVIEW_AVERAGE, REVIEW_MIN_COUNT, DRIVER_TAGS, FAMILY_TAGS, tagLabel, parseRating, ratingWindowOpen, summarizeRatings, needsReview };
