const { supabaseAdmin } = require('../config/supabase');

const MAX_COMMENT_LENGTH = 500;

const summarize = (stars) => ({
  count: stars.length,
  average: stars.length ? Math.round((stars.reduce((sum, value) => sum + value, 0) / stars.length) * 10) / 10 : null
});

// Average stars and count per driver, for any number of drivers in one query.
const fetchRatingSummaries = async (driverIds) => {
  const ids = [...new Set(driverIds.filter(Boolean))];
  const summaries = new Map(ids.map((id) => [id, summarize([])]));
  if (!ids.length) return summaries;
  const { data, error } = await supabaseAdmin.from('ride_ratings').select('driver_id, stars').in('driver_id', ids);
  if (error) throw error;
  const byDriver = new Map();
  for (const row of data || []) byDriver.set(row.driver_id, [...(byDriver.get(row.driver_id) || []), row.stars]);
  for (const [id, stars] of byDriver) summaries.set(id, summarize(stars));
  return summaries;
};

module.exports = { MAX_COMMENT_LENGTH, summarize, fetchRatingSummaries };
