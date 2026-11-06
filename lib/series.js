// Recurring school-week rides. A series holds the plan (children, route,
// service, weekdays, local pickup time, date range). Individual scheduled rides
// are created from it GENERATE_DAYS ahead, so each one is priced, dispatched
// and cancelled exactly like any other ride booked for later.

const scheduling = require('./scheduling');

const DAY_MS = 24 * 60 * 60 * 1000;
// A week ahead plus a day of slack for a once-a-day cron.
const GENERATE_DAYS = 8;
const MAX_START_AHEAD_DAYS = 30;
const MAX_SERIES_DAYS = 200; // about a school year's term or two
const MAX_ACTIVE_SERIES = 4;
const TIME = /^([01]\d|2[0-3]):([0-5][05])$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const validTimeZone = (tz) => {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};

/** The calendar date (YYYY-MM-DD) of `date` in `tz`. */
const localDate = (date, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

// Offset of `tz` from UTC at `date`, in minutes.
const offsetMinutes = (date, tz) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return Math.round((asUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000);
};

/** The instant a local date + HH:MM happens in `tz` (daylight saving aware). */
const zonedTime = (ymd, hhmm, tz) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)));
  let guess = wall - offsetMinutes(new Date(wall), tz) * 60000;
  guess = wall - offsetMinutes(new Date(guess), tz) * 60000;
  return new Date(guess);
};

const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const weekdayOf = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/** Validates the plan part of a new series. Returns { error } or the normalized fields. */
const normalizePlan = (body, now = new Date()) => {
  const timeZone = body.timeZone;
  if (!validTimeZone(timeZone)) return { error: 'Your time zone could not be read. Refresh and try again.' };
  const raw = Array.isArray(body.weekdays) ? body.weekdays : [];
  const weekdays = [...new Set(raw)].sort();
  if (!weekdays.length || weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return { error: 'Choose at least one weekday' };
  if (typeof body.pickupLocalTime !== 'string' || !TIME.test(body.pickupLocalTime)) return { error: 'Choose a pickup time in 5-minute steps' };
  const { startDate, endDate } = body;
  if (!DATE.test(startDate || '') || !DATE.test(endDate || '') || Number.isNaN(Date.parse(startDate)) || Number.isNaN(Date.parse(endDate))) return { error: 'Choose a start and end date' };
  const today = localDate(now, timeZone);
  if (startDate < today) return { error: 'The start date has passed' };
  if (daysBetween(today, startDate) > MAX_START_AHEAD_DAYS) return { error: `Start within the next ${MAX_START_AHEAD_DAYS} days` };
  if (endDate < startDate) return { error: 'The end date must be on or after the start date' };
  if (daysBetween(startDate, endDate) > MAX_SERIES_DAYS) return { error: `A repeating booking can last up to ${MAX_SERIES_DAYS} days. Book the next term separately.` };
  const plan = { weekdays, pickupLocalTime: body.pickupLocalTime, timeZone, startDate, endDate, skippedDates: [] };
  if (!occurrences(plan, now, Date.parse(`${endDate}T23:59:59Z`) + 2 * DAY_MS).length) return { error: 'No ride days fall in those dates. Check the weekdays and dates.' };
  return plan;
};

const planOf = (row) => ({
  weekdays: row.weekdays, pickupLocalTime: row.pickup_local_time, timeZone: row.time_zone,
  startDate: row.start_date, endDate: row.end_date, skippedDates: row.skipped_dates || []
});

/**
 * Ride days of a plan whose pickup is bookable now (at least the scheduling
 * minimum lead away) and not later than `untilMs`: [{ date, pickupTime }].
 */
const occurrences = (plan, now = new Date(), untilMs = now.getTime() + GENERATE_DAYS * DAY_MS) => {
  const out = [];
  const skipped = new Set(plan.skippedDates || []);
  let day = plan.startDate > localDate(now, plan.timeZone) ? plan.startDate : localDate(now, plan.timeZone);
  for (; day <= plan.endDate; day = addDays(day, 1)) {
    const pickupTime = zonedTime(day, plan.pickupLocalTime, plan.timeZone);
    if (pickupTime.getTime() > untilMs) break;
    if (!plan.weekdays.includes(weekdayOf(day)) || skipped.has(day)) continue;
    if (pickupTime.getTime() < now.getTime() + scheduling.MIN_LEAD_MS) continue;
    out.push({ date: day, pickupTime });
  }
  return out;
};

/** The next `limit` ride days (for previews and the series card). */
const upcomingDays = (plan, now = new Date(), limit = 10) => occurrences(plan, now, Date.parse(`${plan.endDate}T23:59:59Z`) + 2 * DAY_MS).slice(0, limit);

const formatSeries = (row, rides = []) => ({
  id: row.id,
  childIds: row.child_ids,
  pickupLocation: row.pickup_location,
  dropoffLocation: row.dropoff_location,
  serviceType: row.service_type,
  stayMinutes: row.stay_minutes,
  weekdays: row.weekdays,
  pickupLocalTime: row.pickup_local_time,
  timeZone: row.time_zone,
  startDate: row.start_date,
  endDate: row.end_date,
  skippedDates: row.skipped_dates || [],
  status: row.status,
  createdAt: row.created_at,
  nextDays: row.status === 'active' ? upcomingDays(planOf(row), new Date(), 10).map((d) => d.date) : [],
  rides
});

module.exports = {
  GENERATE_DAYS,
  MAX_ACTIVE_SERIES,
  MAX_SERIES_DAYS,
  normalizePlan,
  planOf,
  occurrences,
  upcomingDays,
  zonedTime,
  localDate,
  formatSeries,
  DATE
};
