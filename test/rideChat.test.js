const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MAX_LENGTH, parseMessage, chatRole, chatOpen, formatMessage, pushWords, listMessages, unreadSummary } = require('../lib/rideChat');

const ride = { id: 'ride-1', parent_id: 'parent-1', driver_id: 'driver-1', status: 'driver_assigned' };

// A stand-in for the database: records the filters and answers with the rows given.
const fakeDb = (rows, error = null) => {
  const calls = [];
  const query = {
    select: (...args) => { calls.push(['select', ...args]); return query; },
    eq: (...args) => { calls.push(['eq', ...args]); return query; },
    neq: (...args) => { calls.push(['neq', ...args]); return query; },
    is: (...args) => { calls.push(['is', ...args]); return query; },
    order: (...args) => { calls.push(['order', ...args]); return query; },
    limit: async (...args) => { calls.push(['limit', ...args]); return { data: rows, error }; }
  };
  return { calls, from: (table) => { calls.push(['from', table]); return query; } };
};

test('a message is tidied; empty and over-long ones are refused', () => {
  assert.deepEqual(parseMessage({ body: '  Where   are you?  ' }), { text: 'Where are you?' });
  assert.equal(parseMessage({ body: 'Line one \r\n\r\n\r\n\r\n line two' }).text, 'Line one\n\nline two');
  assert.match(parseMessage({ body: '   ' }).error, /Write a message/);
  assert.match(parseMessage({}).error, /Write a message/);
  assert.match(parseMessage({ body: 42 }).error, /Write a message/);
  assert.match(parseMessage({ body: 'x'.repeat(MAX_LENGTH + 1) }).error, /under 500/);
  assert.equal(parseMessage({ body: 'x'.repeat(MAX_LENGTH) }).text.length, MAX_LENGTH);
});

test('only the parent and the present driver of a ride are in its chat', () => {
  assert.equal(chatRole({ id: 'parent-1', role: 'parent' }, ride), 'parent');
  assert.equal(chatRole({ id: 'driver-1', role: 'driver' }, ride), 'driver');
  assert.equal(chatRole({ id: 'driver-2', role: 'driver' }, ride), null);
  assert.equal(chatRole({ id: 'parent-2', role: 'parent' }, ride), null);
  assert.equal(chatRole({ id: 'admin-1', role: 'admin' }, ride), null);
  // No driver yet: an account without an id must never match the empty driver.
  assert.equal(chatRole({ id: undefined }, { ...ride, driver_id: null }), null);
  assert.equal(chatRole({ id: 'driver-1' }, { ...ride, driver_id: null }), null);
});

test('the chat is open from acceptance until the trip ends', () => {
  for (const status of ['driver_assigned', 'driver_arrived_at_pickup', 'child_picked_up']) assert.equal(chatOpen({ ...ride, status }), true);
  for (const status of ['requested', 'searching_driver', 'completed', 'cancelled']) assert.equal(chatOpen({ ...ride, status }), false);
  assert.equal(chatOpen({ ...ride, driver_id: null }), false);
});

test('messages say who sent them without exposing account ids', () => {
  const row = { id: 'm1', sender_id: 'driver-1', sender_role: 'driver', body: 'I am outside', created_at: '2026-11-17T10:00:00Z', read_at: null };
  assert.deepEqual(formatMessage(row, 'parent-1'), { id: 'm1', body: 'I am outside', from: 'driver', mine: false, sentAt: '2026-11-17T10:00:00Z', readAt: null });
  assert.equal(formatMessage(row, 'driver-1').mine, true);
  assert.equal('sender_id' in formatMessage(row, 'parent-1'), false);
});

test('the phone alert names the sender by first name and keeps long messages short', () => {
  assert.deepEqual(pushWords({ from: 'driver', senderName: 'Ada Obi', text: 'I am outside' }), { title: 'Ada (your driver)', body: 'I am outside' });
  assert.equal(pushWords({ from: 'parent', senderName: 'Grace Lee', text: 'On our way down' }).title, 'Grace (parent)');
  assert.equal(pushWords({ from: 'driver', senderName: '', text: 'Hi' }).title, 'Your driver (your driver)');
  const long = pushWords({ from: 'parent', senderName: 'Grace', text: 'y'.repeat(300) }).body;
  assert.equal(long.length, 160);
  assert.ok(long.endsWith('...'));
});

test('the history is limited to the ride and its present driver, oldest first', async () => {
  const db = fakeDb([
    { id: 'm2', sender_id: 'parent-1', sender_role: 'parent', body: 'Thanks', created_at: '2026-11-17T10:01:00Z', read_at: null },
    { id: 'm1', sender_id: 'driver-1', sender_role: 'driver', body: 'Outside', created_at: '2026-11-17T10:00:00Z', read_at: '2026-11-17T10:00:30Z' }
  ]);
  const messages = await listMessages(db, ride, 'parent-1');
  assert.deepEqual(messages.map((message) => message.id), ['m1', 'm2']);
  assert.deepEqual(messages.map((message) => message.mine), [false, true]);
  assert.ok(db.calls.some((call) => call[0] === 'eq' && call[1] === 'ride_id' && call[2] === 'ride-1'));
  // A driver who takes the ride later must not see what was said to the first driver.
  assert.ok(db.calls.some((call) => call[0] === 'eq' && call[1] === 'driver_id' && call[2] === 'driver-1'));
  assert.deepEqual(await listMessages(fakeDb([{ id: 'x' }]), { ...ride, driver_id: null }, 'parent-1'), []);
});

test('the unread summary counts only the other person\'s unopened messages', async () => {
  const db = fakeDb([
    { id: 'm3', body: 'Are you close?', created_at: '2026-11-17T10:02:00Z' },
    { id: 'm2', body: 'Hello', created_at: '2026-11-17T10:01:00Z' }
  ]);
  assert.deepEqual(await unreadSummary(db, ride, 'driver-1'), { unread: 2, latest: { id: 'm3', body: 'Are you close?', sentAt: '2026-11-17T10:02:00Z' } });
  assert.ok(db.calls.some((call) => call[0] === 'neq' && call[1] === 'sender_id' && call[2] === 'driver-1'));
  assert.ok(db.calls.some((call) => call[0] === 'is' && call[1] === 'read_at' && call[2] === null));
  assert.deepEqual(await unreadSummary(fakeDb([]), ride, 'driver-1'), { unread: 0, latest: null });
  assert.deepEqual(await unreadSummary(fakeDb([{ id: 'x' }]), { ...ride, driver_id: null }, 'parent-1'), { unread: 0, latest: null });
  await assert.rejects(unreadSummary(fakeDb(null, { code: '42P01', message: 'no table' }), ride, 'driver-1'));
});
