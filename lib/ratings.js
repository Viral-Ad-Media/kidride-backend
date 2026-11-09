const { supabaseAdmin } = require('../config/supabase');
const { MAX_COMMENT_LENGTH, DRIVER_TAGS, FAMILY_TAGS, ROLLING_WINDOW, summarizeRatings } = require('./ratingRules');

// Rolling average, count and top compliments per person, for any number of people in
// one query. `table` is ride_ratings (driver's score) or family_ratings (parent's score).
const fetchSummaries = async (table, column, set, ids) => {
  const unique = [...new Set((ids || []).filter(Boolean))];
  const summaries = new Map(unique.map((id) => [id, summarizeRatings([], set)]));
  if (!unique.length) return summaries;
  const { data, error } = await supabaseAdmin.from(table).select(`${column}, stars, tags, created_at`).in(column, unique)
    .order('created_at', { ascending: false }).limit(Math.max(1000, unique.length * ROLLING_WINDOW));
  if (error) throw error;
  const byPerson = new Map();
  for (const row of data || []) byPerson.set(row[column], [...(byPerson.get(row[column]) || []), row]);
  for (const [id, rows] of byPerson) summaries.set(id, summarizeRatings(rows, set));
  return summaries;
};

const fetchRatingSummaries = (driverIds) => fetchSummaries('ride_ratings', 'driver_id', DRIVER_TAGS, driverIds);
const fetchFamilyRatingSummaries = (parentIds) => fetchSummaries('family_ratings', 'parent_id', FAMILY_TAGS, parentIds);


module.exports = { MAX_COMMENT_LENGTH, fetchRatingSummaries, fetchFamilyRatingSummaries };
