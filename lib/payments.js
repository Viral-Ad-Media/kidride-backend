// Card payments and driver payouts with Stripe.
//
// Off until STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY are set (and
// PAYMENTS_ENABLED is not "false"). While off, booking works exactly as before
// and nothing here touches the database.
//
// Flow:
//   1. The parent saves a card once (SetupIntent; card details go straight to Stripe).
//   2. When a driver accepts, the fare is held on the card (manual-capture PaymentIntent).
//   3. On drop-off the hold is captured. Cancelling releases it, or captures only
//      the cancellation/no-show fee. With no hold (it failed or expired) the
//      amount is charged to the saved card instead.
//   4. After a successful charge the driver's share is sent to their Stripe
//      Express account (separate charges and transfers). A driver who has not
//      finished payout setup has it kept as "pending" and paid once they finish.
// Payment problems never block a ride: the parent is told to fix their card and
// admins see the status on the ride.

const stripe = require('./stripeApi');
// Loaded on first use so this module can be required without database settings (tests, payments off).
const db = () => require('../config/supabase').supabaseAdmin;

const enabled = () => process.env.PAYMENTS_ENABLED !== 'false'
  && /^sk_(test|live)_/.test(process.env.STRIPE_SECRET_KEY || '')
  && /^pk_(test|live)_/.test(process.env.STRIPE_PUBLISHABLE_KEY || '');
const testMode = () => String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_');
const webAppUrl = () => (process.env.FRONTEND_URLS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)[0] || 'http://localhost:3001';
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const fail = (message, status = 400, code) => Object.assign(new Error(message), { status, code });

// ---------- stored state ----------

const loadAccount = async (userId) => {
  const { data, error } = await db().from('payment_accounts').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data;
};
const saveAccount = async (userId, values) => {
  const { data, error } = await db().from('payment_accounts')
    .upsert({ user_id: userId, ...values, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }).select('*').single();
  if (error) throw error;
  return data;
};
const loadRidePayment = async (rideId) => {
  const { data, error } = await db().from('ride_payments').select('*').eq('ride_id', rideId).maybeSingle();
  if (error) throw error;
  return data;
};
const saveRidePayment = async (ride, values) => {
  const { data, error } = await db().from('ride_payments').upsert({
    ride_id: ride.id, parent_id: ride.parent_id, driver_id: ride.driver_id || null,
    currency: ride.currency || 'USD', ...values, updated_at: new Date().toISOString()
  }, { onConflict: 'ride_id' }).select('*').single();
  if (error) throw error;
  return data;
};

/** What the parent and admin see about a ride's payment. */
const publicPayment = (row) => (row ? {
  status: row.status,
  amountHeld: Number(row.amount_authorized) || 0,
  amountCharged: Number(row.amount_charged) || 0,
  amountRefunded: Number(row.amount_refunded) || 0,
  currency: row.currency,
  error: row.last_error || null,
  payoutStatus: row.payout_status,
  payoutAmount: Number(row.payout_amount) || 0,
  updatedAt: row.updated_at
} : null);

/** Payment rows for many rides at once: Map rideId -> public payment. Empty while payments are off or the table is missing. */
const paymentsForRides = async (rideIds) => {
  if (!enabled() || !rideIds.length) return new Map();
  const { data, error } = await db().from('ride_payments').select('*').in('ride_id', rideIds);
  if (error) { console.warn('Ride payments unavailable', error.message); return new Map(); }
  return new Map((data || []).map((row) => [row.ride_id, publicPayment(row)]));
};

// ---------- parent card ----------

const card = (account) => (account?.default_payment_method ? {
  brand: account.card_brand, last4: account.card_last4, expMonth: account.card_exp_month, expYear: account.card_exp_year
} : null);

const ensureCustomer = async (user) => {
  const account = await loadAccount(user.id);
  if (account?.stripe_customer_id) return account;
  const customer = await stripe.post('/customers', { email: user.email, name: user.name, metadata: { kidride_user_id: user.id } }, { idempotencyKey: `customer-${user.id}` });
  return saveAccount(user.id, { stripe_customer_id: customer.id });
};

/** Starts saving a card: returns the SetupIntent client secret for Stripe's card form. */
const startCardSetup = async (user) => {
  const account = await ensureCustomer(user);
  const intent = await stripe.post('/setup_intents', {
    customer: account.stripe_customer_id, usage: 'off_session',
    // Cards only (wallets such as Apple Pay and Google Pay save as cards): rides need a hold and a later capture.
    payment_method_types: ['card'],
    metadata: { kidride_user_id: user.id }
  });
  return { clientSecret: intent.client_secret };
};

/** After the card form succeeds: makes that card the default and stores its brand/last 4. */
const finishCardSetup = async (user, setupIntentId) => {
  if (typeof setupIntentId !== 'string' || !setupIntentId.startsWith('seti_')) throw fail('Card setup not found');
  const account = await loadAccount(user.id);
  const intent = await stripe.get(`/setup_intents/${encodeURIComponent(setupIntentId)}?expand[]=payment_method`);
  if (!account?.stripe_customer_id || intent.customer !== account.stripe_customer_id) throw fail('Card setup not found', 404);
  if (intent.status !== 'succeeded') throw fail('The card was not saved. Try again.', 409);
  const method = intent.payment_method;
  const old = account.default_payment_method;
  await stripe.post(`/customers/${account.stripe_customer_id}`, { invoice_settings: { default_payment_method: method.id } });
  const saved = await saveAccount(user.id, {
    default_payment_method: method.id,
    card_brand: method.card?.brand || method.type,
    card_last4: method.card?.last4 || null,
    card_exp_month: method.card?.exp_month || null,
    card_exp_year: method.card?.exp_year || null
  });
  if (old && old !== method.id) await stripe.post(`/payment_methods/${old}/detach`).catch(() => {});
  // A new card is a chance to settle rides whose payment failed.
  await retryFailedForParent(user.id).catch((error) => console.warn('Retry after new card failed', error.message));
  return card(saved);
};

const removeCard = async (user) => {
  const account = await loadAccount(user.id);
  if (!account?.default_payment_method) return null;
  const { count } = await db().from('rides').select('id', { count: 'exact', head: true })
    .eq('parent_id', user.id).not('status', 'in', '(completed,cancelled)');
  if (count > 0) throw fail('You have rides booked. Add a new card instead of removing this one, or cancel those rides first.', 409);
  await stripe.post(`/payment_methods/${account.default_payment_method}/detach`).catch(() => {});
  await saveAccount(user.id, { default_payment_method: null, card_brand: null, card_last4: null, card_exp_month: null, card_exp_year: null });
  return null;
};

/** Throws 402 when payments are on and the parent has no card saved. */
const requireCard = async (parentId) => {
  if (!enabled()) return;
  const account = await loadAccount(parentId);
  if (!account?.default_payment_method) throw fail('Add a payment card in Settings before booking.', 402, 'payment_method_required');
};

// ---------- charging ----------

const declineReason = (error) => {
  const reasons = { insufficient_funds: 'insufficient funds', expired_card: 'card expired', lost_card: 'card reported lost', stolen_card: 'card reported stolen', incorrect_cvc: 'security code wrong' };
  return reasons[error.declineCode] || reasons[error.code] || (error.code === 'card_declined' ? 'card declined' : null);
};

// Records a PaymentIntent the bank wants the parent to confirm, or a decline.
const recordFailure = async (ride, error, amount, { notify = true } = {}) => {
  const intent = error.paymentIntent;
  const needsAction = error.code === 'authentication_required' || intent?.status === 'requires_action';
  const row = await saveRidePayment(ride, {
    status: needsAction ? 'requires_action' : 'failed',
    payment_intent_id: intent?.id || null,
    last_error: needsAction ? 'Your bank needs you to confirm this payment' : (declineReason(error) || error.message || 'Payment failed').slice(0, 200)
  });
  if (notify) {
    const { notifyRideEvent } = require('./notifications');
    await notifyRideEvent(ride, needsAction ? 'payment_action_required' : 'payment_failed', { amount, reason: needsAction ? null : row.last_error });
  }
  return row;
};

const parentCard = async (parentId) => {
  const account = await loadAccount(parentId);
  if (!account?.stripe_customer_id || !account.default_payment_method) throw fail('No payment card saved', 402, 'payment_method_required');
  return account;
};

/** Puts a hold for the fare on the parent's card. Called when a driver accepts. */
const authorizeRide = async (ride, attempt = '') => {
  if (!enabled() || !(Number(ride.price) > 0)) return null;
  const existing = await loadRidePayment(ride.id);
  if (existing && ['authorized', 'succeeded'].includes(existing.status)) return existing;
  try {
    const account = await parentCard(ride.parent_id);
    const intent = await stripe.post('/payment_intents', {
      amount: stripe.toMinor(ride.price, ride.currency), currency: String(ride.currency || 'USD').toLowerCase(),
      customer: account.stripe_customer_id, payment_method: account.default_payment_method,
      payment_method_types: ['card'], capture_method: 'manual', confirm: true, off_session: true,
      description: `KidRide ride ${ride.id.slice(0, 8)}`,
      metadata: { ride_id: ride.id, purpose: 'ride_fare' }
    }, { idempotencyKey: `hold-${ride.id}-${account.default_payment_method}${attempt}` });
    return saveRidePayment(ride, { status: 'authorized', payment_intent_id: intent.id, amount_authorized: ride.price, last_error: null });
  } catch (error) {
    if (!error.provider && error.code !== 'payment_method_required') throw error;
    return recordFailure(ride, error, ride.price);
  }
};

const chargeOffSession = async (ride, amount, purpose, attempt = '') => {
  const account = await parentCard(ride.parent_id);
  return stripe.post('/payment_intents', {
    amount: stripe.toMinor(amount, ride.currency), currency: String(ride.currency || 'USD').toLowerCase(),
    customer: account.stripe_customer_id, payment_method: account.default_payment_method,
    payment_method_types: ['card'], confirm: true, off_session: true,
    description: `KidRide ${purpose === 'ride_fare' ? 'ride' : 'cancellation'} ${ride.id.slice(0, 8)}`,
    metadata: { ride_id: ride.id, purpose }
  }, { idempotencyKey: `charge-${ride.id}-${purpose}-${account.default_payment_method}${attempt}` });
};

/**
 * Settles a finished ride: amount = fare on completion, the fee on cancellation (0 = nothing owed).
 * driverAmount is what the driver receives from it.
 */
const settleRide = async (ride, { amount, driverAmount, purpose, attempt = '' }) => {
  if (!enabled()) return null;
  amount = round2(amount);
  const existing = await loadRidePayment(ride.id);
  if (existing?.status === 'succeeded') return existing;
  const base = { driver_id: ride.driver_id || null, payout_amount: amount > 0 && ride.driver_id ? round2(Math.min(driverAmount, amount)) : 0 };
  try {
    if (existing?.status === 'authorized' && existing.payment_intent_id) {
      if (amount <= 0) {
        await stripe.post(`/payment_intents/${existing.payment_intent_id}/cancel`, {}, { idempotencyKey: `release-${ride.id}` });
        return saveRidePayment(ride, { ...base, status: 'canceled', amount_charged: 0, last_error: null });
      }
      const captured = await stripe.post(`/payment_intents/${existing.payment_intent_id}/capture`, { amount_to_capture: Math.min(stripe.toMinor(amount, ride.currency), stripe.toMinor(existing.amount_authorized, ride.currency)) }, { idempotencyKey: `capture-${ride.id}` })
        .catch(async (error) => {
          // An expired hold (holds last about 7 days) is charged afresh below.
          if (error.provider && ['payment_intent_unexpected_state', 'charge_expired_for_capture'].includes(error.code)) return null;
          throw error;
        });
      if (captured) return afterCharge(ride, base, captured, purpose);
    }
    if (amount <= 0) return existing ? saveRidePayment(ride, { ...base, status: 'canceled', last_error: null }) : null;
    const intent = await chargeOffSession(ride, amount, purpose, attempt);
    return afterCharge(ride, base, intent, purpose);
  } catch (error) {
    if (!error.provider && error.code !== 'payment_method_required') throw error;
    await saveRidePayment(ride, { ...base, amount_due: amount, purpose });
    return recordFailure(ride, error, amount);
  }
};

const afterCharge = async (ride, base, intent, purpose) => {
  const charged = stripe.fromMinor(intent.amount_received || intent.amount, ride.currency);
  const row = await saveRidePayment(ride, {
    ...base, purpose, status: intent.status === 'succeeded' ? 'succeeded' : intent.status === 'requires_action' ? 'requires_action' : 'processing',
    payment_intent_id: intent.id, charge_id: intent.latest_charge || null,
    amount_charged: intent.status === 'succeeded' ? charged : 0, amount_due: charged, last_error: null
  });
  return row.status === 'succeeded' ? payDriver(row) : row;
};

/** Retries failed charges for a parent (after they add a new card). */
const retryFailedForParent = async (parentId) => {
  const { data } = await db().from('ride_payments').select('ride_id').eq('parent_id', parentId).eq('status', 'failed').limit(10);
  for (const { ride_id: rideId } of data || []) await retryRide(rideId, parentId).catch(() => {});
};

const loadRide = async (rideId) => {
  const { data, error } = await db().from('rides').select('id, parent_id, driver_id, status, price, currency, driver_earnings, cancellation_fee').eq('id', rideId).maybeSingle();
  if (error) throw error;
  return data;
};

/** Parent (or admin) retries a failed payment with the current card. */
const retryRide = async (rideId, parentId = null) => {
  const ride = await loadRide(rideId);
  const row = await loadRidePayment(rideId);
  if (!ride || !row || (parentId && ride.parent_id !== parentId)) throw fail('Payment not found', 404);
  if (!['failed', 'requires_action'].includes(row.status)) return row;
  // A retry gets a fresh idempotency key so Stripe tries the card again instead of replaying the decline.
  const attempt = `-retry${Date.now()}`;
  if (!['completed', 'cancelled'].includes(ride.status)) return authorizeRide(ride, attempt);
  return settleRide(ride, { amount: Number(row.amount_due) || 0, driverAmount: Number(row.payout_amount) || 0, purpose: row.purpose || 'ride_fare', attempt });
};

/** The client secret the parent's browser needs to confirm a payment their bank flagged. */
const actionFor = async (rideId, parentId) => {
  const row = await loadRidePayment(rideId);
  if (!row || row.parent_id !== parentId || row.status !== 'requires_action' || !row.payment_intent_id) throw fail('Nothing to confirm', 404);
  const intent = await stripe.get(`/payment_intents/${row.payment_intent_id}`);
  return { clientSecret: intent.client_secret };
};

/** Re-reads a PaymentIntent from Stripe (after the parent confirmed it, or from a webhook). */
const syncIntent = async (intent) => {
  const rideId = intent.metadata?.ride_id;
  if (!rideId) return null;
  const row = await loadRidePayment(rideId);
  if (!row) return null;
  const ride = await loadRide(rideId);
  if (!ride) return null;
  const base = { driver_id: row.driver_id };
  if (intent.status === 'requires_capture') return saveRidePayment(ride, { status: 'authorized', payment_intent_id: intent.id, amount_authorized: stripe.fromMinor(intent.amount, ride.currency), last_error: null });
  if (intent.status === 'succeeded') {
    if (row.status === 'succeeded') return row;
    return afterCharge(ride, base, intent, intent.metadata?.purpose || row.purpose);
  }
  if (intent.status === 'canceled' && row.status !== 'succeeded') return saveRidePayment(ride, { status: 'canceled' });
  if (intent.status === 'requires_payment_method' && row.status !== 'failed') {
    return saveRidePayment(ride, { status: 'failed', last_error: (declineReason({ code: intent.last_payment_error?.code, declineCode: intent.last_payment_error?.decline_code }) || intent.last_payment_error?.message || 'Payment failed').slice(0, 200) });
  }
  return row;
};

const confirmedByParent = async (rideId, parentId) => {
  const row = await loadRidePayment(rideId);
  if (!row || row.parent_id !== parentId || !row.payment_intent_id) throw fail('Payment not found', 404);
  return syncIntent(await stripe.get(`/payment_intents/${row.payment_intent_id}`));
};

// ---------- driver payouts (Stripe Connect Express) ----------

/** Sends the driver's share of a charged ride, or marks it pending until their payout account is ready. */
const payDriver = async (row) => {
  if (!row.driver_id || !(Number(row.payout_amount) > 0) || row.payout_status === 'paid') return row;
  const account = await loadAccount(row.driver_id);
  if (!account?.stripe_account_id || !account.payouts_enabled) return updatePayout(row, { payout_status: 'pending' });
  try {
    const transfer = await stripe.post('/transfers', {
      amount: stripe.toMinor(row.payout_amount, row.currency), currency: row.currency.toLowerCase(),
      destination: account.stripe_account_id,
      ...(row.charge_id ? { source_transaction: row.charge_id } : {}),
      transfer_group: `ride_${row.ride_id}`, metadata: { ride_id: row.ride_id }
    }, { idempotencyKey: `payout-${row.ride_id}` });
    return updatePayout(row, { payout_status: 'paid', transfer_id: transfer.id, payout_error: null });
  } catch (error) {
    if (!error.provider) throw error;
    return updatePayout(row, { payout_status: 'failed', payout_error: String(error.message).slice(0, 200) });
  }
};
const updatePayout = async (row, values) => {
  const { data, error } = await db().from('ride_payments').update({ ...values, updated_at: new Date().toISOString() }).eq('ride_id', row.ride_id).select('*').single();
  if (error) throw error;
  return data;
};

const payPendingForDriver = async (driverId) => {
  const { data } = await db().from('ride_payments').select('*').eq('driver_id', driverId).eq('status', 'succeeded').in('payout_status', ['pending', 'failed']).limit(50);
  for (const row of data || []) await payDriver(row).catch((error) => console.warn('Pending payout failed', error.message));
};

const syncConnectAccount = async (driverId, stripeAccount) => {
  const saved = await saveAccount(driverId, {
    stripe_account_id: stripeAccount.id,
    payouts_enabled: !!stripeAccount.payouts_enabled,
    details_submitted: !!stripeAccount.details_submitted,
    payout_requirements: (stripeAccount.requirements?.currently_due || []).slice(0, 20)
  });
  if (saved.payouts_enabled) await payPendingForDriver(driverId);
  return saved;
};

/** Link to Stripe's hosted onboarding where the driver adds their bank details. */
const payoutOnboardingLink = async (user) => {
  let account = await loadAccount(user.id);
  if (!account?.stripe_account_id) {
    const created = await stripe.post('/accounts', {
      type: 'express', email: user.email, business_type: 'individual',
      // Country comes from STRIPE_CONNECT_COUNTRY (two letters) when set; otherwise Stripe uses the platform's country.
      ...(/^[A-Z]{2}$/.test(process.env.STRIPE_CONNECT_COUNTRY || '') ? { country: process.env.STRIPE_CONNECT_COUNTRY } : {}),
      capabilities: { transfers: { requested: true } },
      business_profile: { product_description: 'Driving children for KidRide' },
      metadata: { kidride_user_id: user.id }
    }, { idempotencyKey: `connect-${user.id}` });
    account = await saveAccount(user.id, { stripe_account_id: created.id, payouts_enabled: false, details_submitted: false });
  }
  const link = await stripe.post('/account_links', {
    account: account.stripe_account_id, type: 'account_onboarding',
    refresh_url: `${webAppUrl()}/#/profile/payments`,
    return_url: `${webAppUrl()}/#/profile/payments`
  });
  return { url: link.url };
};

const payoutSummary = async (driverId) => {
  let account = await loadAccount(driverId);
  if (account?.stripe_account_id) {
    try { account = await syncConnectAccount(driverId, await stripe.get(`/accounts/${account.stripe_account_id}`)); }
    catch (error) { console.warn('Payout account refresh failed', error.message); }
  }
  const { data } = await db().from('ride_payments').select('payout_amount, payout_status, currency').eq('driver_id', driverId).eq('status', 'succeeded');
  const sum = (status) => round2((data || []).filter((row) => status.includes(row.payout_status)).reduce((total, row) => total + Number(row.payout_amount || 0), 0));
  return {
    status: !account?.stripe_account_id ? 'not_started' : account.payouts_enabled ? 'ready' : account.details_submitted ? 'in_review' : 'incomplete',
    paid: sum(['paid']), pending: sum(['pending', 'failed']),
    currency: data?.[0]?.currency || null
  };
};

const payoutDashboardLink = async (driverId) => {
  const account = await loadAccount(driverId);
  if (!account?.stripe_account_id) throw fail('Set up payouts first', 409);
  const link = await stripe.post(`/accounts/${account.stripe_account_id}/login_links`);
  return { url: link.url };
};

// ---------- admin ----------

/** Refunds part or all of what was charged; fromDriver also takes the same share back from the driver's payout. */
const refundRide = async (rideId, { amount, fromDriver = false, reason }) => {
  const row = await loadRidePayment(rideId);
  if (!row || row.status !== 'succeeded' || !row.payment_intent_id) throw fail('Nothing charged on this ride to refund', 409);
  const refundable = round2(Number(row.amount_charged) - Number(row.amount_refunded || 0));
  const value = amount === undefined || amount === null ? refundable : round2(amount);
  if (!(value > 0) || value > refundable) throw fail(`Refund must be between 0 and ${refundable}`);
  const refund = await stripe.post('/refunds', { payment_intent: row.payment_intent_id, amount: stripe.toMinor(value, row.currency), metadata: { ride_id: rideId, reason: String(reason || '').slice(0, 200) } });
  let reversed = 0;
  if (fromDriver && row.transfer_id && Number(row.payout_amount) > 0) {
    reversed = round2(Math.min(Number(row.payout_amount), Number(row.payout_amount) * value / Number(row.amount_charged)));
    if (reversed > 0) await stripe.post(`/transfers/${row.transfer_id}/reversals`, { amount: stripe.toMinor(reversed, row.currency) });
  }
  const { data, error } = await db().from('ride_payments').update({
    amount_refunded: round2(Number(row.amount_refunded || 0) + value),
    payout_reversed: round2(Number(row.payout_reversed || 0) + reversed),
    last_refund_id: refund.id, updated_at: new Date().toISOString()
  }).eq('ride_id', rideId).select('*').single();
  if (error) throw error;
  return publicPayment(data);
};

// ---------- webhook ----------

/** Handles a verified Stripe event once (payment_events keeps the ids already seen). */
const handleEvent = async (event) => {
  const { error: seenError } = await db().from('payment_events').insert({ id: event.id, type: event.type });
  if (seenError?.code === '23505') return 'duplicate';
  if (seenError) throw seenError;
  const object = event.data?.object || {};
  if (event.type.startsWith('payment_intent.')) await syncIntent(object);
  else if (event.type === 'account.updated') {
    const { data } = await db().from('payment_accounts').select('user_id').eq('stripe_account_id', object.id).maybeSingle();
    if (data) await syncConnectAccount(data.user_id, object);
  } else if (event.type === 'charge.dispute.created') {
    const { data } = await db().from('ride_payments').select('ride_id').eq('payment_intent_id', object.payment_intent).maybeSingle();
    if (data) await db().from('ride_payments').update({ disputed: true, updated_at: new Date().toISOString() }).eq('ride_id', data.ride_id);
  }
  return 'handled';
};

const webhookSecrets = () => [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_CONNECT_WEBHOOK_SECRET];

module.exports = {
  enabled, testMode, publicPayment, paymentsForRides, card, loadAccount,
  startCardSetup, finishCardSetup, removeCard, requireCard,
  authorizeRide, settleRide, retryRide, actionFor, confirmedByParent, loadRidePayment,
  payoutOnboardingLink, payoutSummary, payoutDashboardLink, payPendingForDriver,
  refundRide, handleEvent, webhookSecrets
};
