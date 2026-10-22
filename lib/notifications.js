const { supabaseAdmin } = require('../config/supabase');
const { notifyRide } = require('./push');

// Ride notifications: one row per recipient in public.notifications (the bell
// in the app) and, when RESEND_API_KEY is set and the user has not switched
// email off, an email through Resend. Everything is awaited and never throws,
// so a notification problem cannot fail the ride update that caused it.

const FRONTEND_URL = (process.env.FRONTEND_URLS || '').split(',').map((s) => s.trim()).filter(Boolean)[0] || 'http://localhost:3001';
const EMAIL_FROM = process.env.EMAIL_FROM || 'KidRide <onboarding@resend.dev>';

const firstName = (name) => (name || '').trim().split(/\s+/)[0] || '';
const money = (amount, currency = 'USD') => (Number(amount) > 0 ? new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(amount)) : '');
const earnings = (ride) => money(ride.driver_earnings ?? ride.price, ride.currency || 'USD');

// What each ride event says to the parent and to the driver. `child` is the
// child's first name, `driver` the driver's first name.
const MESSAGES = {
  booked: ({ child, ride }) => ({
    parent: ride.is_scheduled
      ? { title: `Ride booked for ${child}`, body: `Pickup at ${ride.pickup_location}. We will find a driver closer to the time.` }
      : { title: `Finding a driver for ${child}`, body: `Pickup at ${ride.pickup_location}. We will let you know as soon as a driver accepts.` }
  }),
  driver_assigned: ({ child, driver, ride }) => ({
    parent: { title: `${driver} is on the way`, body: `${driver} accepted ${child}'s ride and is heading to ${ride.pickup_location}. Trip code ${ride.trip_code}.` },
    driver: { title: `Trip confirmed: ${child}`, body: `Pickup at ${ride.pickup_location}, drop-off at ${ride.dropoff_location}. Check the trip code before the child gets in.` }
  }),
  driver_arrived_at_pickup: ({ child, driver, ride }) => ({
    parent: { title: `${driver} has arrived`, body: `${driver} is at ${ride.pickup_location} for ${child}. Trip code ${ride.trip_code}.` }
  }),
  child_picked_up: ({ child, driver, ride }) => ({
    parent: { title: `${child} is in the car`, body: `${driver} has picked up ${child} and is heading to ${ride.dropoff_location}.` }
  }),
  completed: ({ child, ride }) => ({
    parent: { title: `${child} has arrived`, body: `${child} was dropped off at ${ride.dropoff_location}. Open the ride to rate the driver.` },
    driver: { title: 'Trip complete', body: `${child}'s ride is done${earnings(ride) ? `. ${earnings(ride)} added to your earnings` : ''}.` }
  }),
  cancelled: ({ child, ride }) => ({
    parent: { title: `${child}'s ride was cancelled`, body: `The ride from ${ride.pickup_location} is cancelled.${Number(ride.cancellation_fee) > 0 ? ` A ${money(ride.cancellation_fee, ride.currency || 'USD')} cancellation fee applies.` : ''} You can book again any time.` },
    driver: { title: 'Ride cancelled', body: `The ride from ${ride.pickup_location} was cancelled.` }
  })
};

const loadContext = async (ride) => {
  const ids = [ride.parent_id, ride.driver_id].filter(Boolean);
  const [{ data: profiles }, { data: child }] = await Promise.all([
    supabaseAdmin.from('profiles').select('id, name, email, notify_email').in('id', ids),
    ride.child_id ? supabaseAdmin.from('children').select('name').eq('id', ride.child_id).maybeSingle() : Promise.resolve({ data: null })
  ]);
  const byId = new Map((profiles || []).map((p) => [p.id, p]));
  return {
    parent: byId.get(ride.parent_id) || null,
    driver: ride.driver_id ? byId.get(ride.driver_id) || null : null,
    child: firstName(child?.name) || 'your child'
  };
};

const emailHtml = (title, body, rideId) => `
  <div style="font-family:'Plus Jakarta Sans',Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#14213D">
    <p style="font-size:20px;font-weight:800;margin:0 0 8px">${title}</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 20px;color:#5B6478">${body}</p>
    <a href="${FRONTEND_URL}/#/tracking/${rideId}" style="display:inline-block;background:#38BDF8;color:#14213D;font-weight:600;text-decoration:none;padding:14px 24px;border-radius:9999px">Open in KidRide</a>
    <p style="font-size:12px;color:#5B6478;margin-top:24px">You get these emails for your rides. Turn them off under Profile, Notification settings.</p>
  </div>`;

const sendEmail = async (to, title, body, rideId) => {
  if (!process.env.RESEND_API_KEY || !to) return false;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject: `KidRide: ${title}`, html: emailHtml(title, body, rideId), text: `${title}\n\n${body}\n\n${FRONTEND_URL}/#/tracking/${rideId}` }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) { console.warn('Email not sent', response.status); return false; }
    return true;
  } catch (error) {
    console.warn('Email not sent', error?.message || error);
    return false;
  }
};

// Emails go out after the in-app rows and push, all at once, so a slow mail
// provider never holds up the ride response. Vercel freezes a function once it
// answers, so there the emails are still awaited (in parallel, time-limited).
const EMAIL_STAYS_IN_REQUEST = !!process.env.VERCEL;

/** Record (and email) what just happened on a ride. `event` defaults to the ride's status. */
const notifyRideEvent = async (ride, event = ride?.status) => {
  if (!ride) return;
  const emails = [];
  try {
    const build = MESSAGES[event];
    if (build) {
      const context = await loadContext(ride);
      const messages = build({ ride, child: context.child, driver: firstName(context.driver?.name) || 'Your driver' });
      const rows = [];
      for (const [role, message] of Object.entries(messages)) {
        const recipient = context[role];
        if (!recipient || !message) continue;
        rows.push({ user_id: recipient.id, ride_id: ride.id, kind: event, title: message.title, body: message.body });
        if (recipient.notify_email !== false) emails.push({ userId: recipient.id, to: recipient.email, ...message });
      }
      if (rows.length) {
        const { error } = await supabaseAdmin.from('notifications').insert(rows);
        if (error) console.warn('Notification not saved', error.message);
      }
    }
  } catch (error) {
    console.warn('Notification failed; ride update saved', error?.message || error);
  }
  await notifyRide(ride);
  const sending = Promise.all(emails.map(async ({ userId, to, title, body }) => {
    if (!(await sendEmail(to, title, body, ride.id))) return;
    const { error } = await supabaseAdmin.from('notifications').update({ email_sent_at: new Date().toISOString() })
      .eq('user_id', userId).eq('ride_id', ride.id).eq('kind', event).is('email_sent_at', null);
    if (error) console.warn('Email time not saved', error.message);
  })).catch((error) => console.warn('Email failed', error?.message || error));
  if (EMAIL_STAYS_IN_REQUEST) await sending;
};

module.exports = { notifyRideEvent };
