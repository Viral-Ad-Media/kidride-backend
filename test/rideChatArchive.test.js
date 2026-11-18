// When a trip ends its chat closes for the parent and the driver, and a
// compressed copy is kept for KidRide's safety team.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const rideChat = require('../lib/rideChat');

// A small in-memory database: just the calls the chat code makes.
const memoryDb = (tables, { failInsertInto } = {}) => ({
  tables,
  from(table) {
    const all = () => { tables[table] = tables[table] || []; return tables[table]; };
    const filters = [];
    let action = { kind: 'select' };
    let limit = Infinity;
    const matches = (row) => filters.every((filter) => filter(row));
    const run = () => {
      if (action.kind === 'insert') {
        if (failInsertInto === table) return { data: null, error: { code: 'XX000', message: 'disk full' } };
        all().push({ id: table + '-' + (all().length + 1), ...action.row });
        return { data: null, error: null };
      }
      if (action.kind === 'update') { all().filter(matches).forEach((row) => Object.assign(row, action.row)); return { data: null, error: null }; }
      if (action.kind === 'delete') { tables[table] = all().filter((row) => !matches(row)); return { data: null, error: null }; }
      return { data: all().filter(matches).slice(0, limit).map((row) => ({ ...row })), error: null };
    };
    const query = {
      select: () => query,
      order: () => query,
      limit: (count) => { limit = count; return query; },
      eq: (column, value) => { filters.push((row) => row[column] === value); return query; },
      neq: (column, value) => { filters.push((row) => row[column] !== value); return query; },
      in: (column, values) => { filters.push((row) => values.includes(row[column])); return query; },
      is: (column, value) => { filters.push((row) => (row[column] ?? null) === value); return query; },
      insert: (row) => { action = { kind: 'insert', row }; return query; },
      update: (row) => { action = { kind: 'update', row }; return query; },
      delete: () => { action = { kind: 'delete' }; return query; },
      maybeSingle: async () => ({ data: run().data[0] || null, error: null }),
      single: async () => { const result = run(); return result.error ? result : { data: action.kind === 'insert' ? all()[all().length - 1] : result.data[0], error: null }; },
      then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject)
    };
    return query;
  }
});

const message = (id, minute, role, body, extra = {}) => ({
  id, ride_id: 'ride-1', driver_id: 'driver-1', sender_id: role === 'parent' ? 'parent-1' : 'driver-1', sender_role: role, body,
  created_at: `2026-11-18T10:${String(minute).padStart(2, '0')}:00Z`, read_at: null, ...extra
});
const ride = { id: 'ride-1', parent_id: 'parent-1', driver_id: 'driver-1', status: 'completed' };

test('a conversation packs into far less space and reads back exactly', () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({ id: 'm' + i, at: `2026-11-18T10:${String(i).padStart(2, '0')}:00Z`, from: i % 2 ? 'driver' : 'parent', senderId: 'u' + (i % 2), body: 'Where are you? We are ready at the pickup', readAt: null }));
  const packed = rideChat.packTranscript(messages);
  assert.ok(packed.length < JSON.stringify(messages).length / 3);
  assert.deepEqual(rideChat.unpackTranscript(packed), messages);
  assert.deepEqual(rideChat.unpackTranscript('damaged'), []);
});

test('when a ride ends its messages move into one compressed copy and are gone from the chat', async () => {
  const db = memoryDb({ ride_messages: [message('m1', 1, 'parent', 'Where are you?'), message('m2', 2, 'driver', 'Two minutes away', { read_at: '2026-11-18T10:03:00Z' })] });
  assert.equal(await rideChat.archiveRideChat(db, ride), 2);
  assert.deepEqual(db.tables.ride_messages, []);
  assert.equal(db.tables.ride_chat_archives.length, 1);
  const copy = db.tables.ride_chat_archives[0];
  assert.equal(copy.ride_id, 'ride-1');
  assert.equal(copy.driver_id, 'driver-1');
  assert.equal(copy.parent_id, 'parent-1');
  assert.equal(copy.message_count, 2);
  assert.equal(copy.first_message_at, '2026-11-18T10:01:00Z');
  assert.equal(copy.last_message_at, '2026-11-18T10:02:00Z');
  // Stored compressed: the words are not readable in the row itself.
  assert.doesNotMatch(copy.transcript_gz, /Where are you|Two minutes/);
  assert.deepEqual(rideChat.unpackTranscript(copy.transcript_gz).map((item) => [item.from, item.body]), [['parent', 'Where are you?'], ['driver', 'Two minutes away']]);
  // Nothing left to archive: asking again changes nothing.
  assert.equal(await rideChat.archiveRideChat(db, ride), 0);
  assert.equal(db.tables.ride_chat_archives.length, 1);
});

test('a later message is added to the copy that already exists', async () => {
  const db = memoryDb({ ride_messages: [message('m1', 1, 'parent', 'Hello')] });
  await rideChat.archiveRideChat(db, ride);
  db.tables.ride_messages.push(message('m2', 5, 'driver', 'Sorry, missed this'));
  await rideChat.archiveRideChat(db, ride);
  assert.equal(db.tables.ride_chat_archives.length, 1);
  assert.equal(db.tables.ride_chat_archives[0].message_count, 2);
  assert.deepEqual(rideChat.unpackTranscript(db.tables.ride_chat_archives[0].transcript_gz).map((item) => item.id), ['m1', 'm2']);
  assert.deepEqual(db.tables.ride_messages, []);
});

test('if the copy cannot be stored, the messages are left where they are', async () => {
  const db = memoryDb({ ride_messages: [message('m1', 1, 'parent', 'Hello')] }, { failInsertInto: 'ride_chat_archives' });
  await assert.rejects(rideChat.archiveRideChat(db, ride));
  assert.equal(db.tables.ride_messages.length, 1);
});

test('the sweep closes chats of ended rides and of a driver no longer on the ride, and leaves live ones alone', async () => {
  const db = memoryDb({
    rides: [
      { id: 'ride-1', parent_id: 'parent-1', driver_id: 'driver-1', status: 'cancelled' },
      { id: 'ride-2', parent_id: 'parent-2', driver_id: 'driver-2', status: 'driver_assigned' },
      { id: 'ride-3', parent_id: 'parent-3', driver_id: 'driver-9', status: 'driver_assigned' }
    ],
    ride_messages: [
      message('m1', 1, 'parent', 'ended ride'),
      { ...message('m2', 2, 'parent', 'live ride'), ride_id: 'ride-2', driver_id: 'driver-2' },
      { ...message('m3', 3, 'driver', 'from the first driver'), ride_id: 'ride-3', driver_id: 'driver-3' }
    ]
  });
  assert.equal(await rideChat.sweepEndedChats(db), 2);
  assert.deepEqual(db.tables.ride_messages.map((row) => row.id), ['m2']);
  assert.deepEqual(db.tables.ride_chat_archives.map((row) => row.ride_id + ':' + row.driver_id).sort(), ['ride-1:driver-1', 'ride-3:driver-3']);
});

test('the safety team sees the archived conversation and anything still live, in order', async () => {
  const db = memoryDb({ ride_messages: [message('m1', 1, 'parent', 'Where are you?'), message('m2', 2, 'driver', 'Outside')] });
  await rideChat.archiveRideChat(db, ride);
  db.tables.ride_messages.push(message('m3', 9, 'parent', 'Thanks'));
  const record = await rideChat.transcriptForSafety(db, ride);
  assert.deepEqual(record.map((item) => [item.body, item.archived]), [['Where are you?', true], ['Outside', true], ['Thanks', false]]);
  assert.ok(record.every((item) => item.mine === false));
});

// ---- Through the real routes ----

const chatRoutes = (db, rides) => {
  const handlers = {};
  const router = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (url, ...args) => { handlers[method + ' ' + url] = args.at(-1); }]));
  const mocks = {
    express: { Router: () => router },
    '../middleware/authMiddleware': { protect() {} },
    '../middleware/rateLimitMiddleware': { createRateLimiter: () => () => {} },
    '../config/supabase': { supabaseAdmin: db },
    '../lib/repository': { fetchRideRowById: async (id) => rides[id] || null },
    '../lib/push': { pushToUsers: async () => {} },
    '../lib/webPush': { sendWebPush: async () => 0 }
  };
  const filename = path.join(__dirname, '..', 'routes/messageRoutes.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, require: (name) => (Object.hasOwn(mocks, name) ? mocks[name] : require(name)), process, console: { ...console, warn() {} }, Date }, { filename });
  return handlers;
};
const reply = () => ({ code: 200, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } });
const parent = { id: 'parent-1', role: 'parent', name: 'Grace Lee' };
const driver = { id: 'driver-1', role: 'driver', name: 'Ada Obi' };

test('during the trip both sides read and write; once it ends neither can, and only an admin sees the record', async () => {
  const live = { id: 'ride-1', parent_id: 'parent-1', driver_id: 'driver-1', status: 'driver_assigned' };
  const rides = { 'ride-1': live };
  const db = memoryDb({ rides: [live], ride_messages: [] });
  const routes = chatRoutes(db, rides);

  const sent = reply();
  await routes['post /:id/messages']({ user: parent, params: { id: 'ride-1' }, body: { body: 'Where are you?' } }, sent);
  assert.equal(sent.code, 201);
  const seen = reply();
  await routes['get /:id/messages']({ user: driver, params: { id: 'ride-1' } }, seen);
  assert.equal(seen.body.canSend, true);
  assert.equal(seen.body.closed, false);
  assert.deepEqual(seen.body.messages.map((item) => [item.body, item.mine]), [['Where are you?', false]]);

  // The trip ends.
  live.status = 'completed';
  db.tables.rides[0].status = 'completed';
  await rideChat.archiveRideChat(db, live);
  for (const user of [parent, driver]) {
    const after = reply();
    await routes['get /:id/messages']({ user, params: { id: 'ride-1' } }, after);
    assert.equal(after.body.closed, true);
    assert.equal(after.body.canSend, false);
    assert.equal(after.body.messages.length, 0);
    const late = reply();
    await routes['post /:id/messages']({ user, params: { id: 'ride-1' }, body: { body: 'One more thing' } }, late);
    assert.equal(late.code, 409);
  }

  const outsider = reply();
  await routes['get /:id/messages']({ user: { id: 'parent-2', role: 'parent' }, params: { id: 'ride-1' } }, outsider);
  assert.equal(outsider.code, 403);

  const admin = reply();
  await routes['get /:id/messages']({ user: { id: 'admin-1', role: 'admin' }, params: { id: 'ride-1' } }, admin);
  assert.equal(admin.body.safetyRecord, true);
  assert.deepEqual(admin.body.messages.map((item) => item.body), ['Where are you?']);
  const adminWrite = reply();
  await routes['post /:id/messages']({ user: { id: 'admin-1', role: 'admin' }, params: { id: 'ride-1' }, body: { body: 'Hello' } }, adminWrite);
  assert.equal(adminWrite.code, 403);
});

test('a ride that ended before its chat was archived still shows nothing to the parent', async () => {
  const ended = { id: 'ride-1', parent_id: 'parent-1', driver_id: 'driver-1', status: 'cancelled' };
  const db = memoryDb({ rides: [ended], ride_messages: [message('m1', 1, 'driver', 'On my way')] });
  const routes = chatRoutes(db, { 'ride-1': ended });
  const res = reply();
  await routes['get /:id/messages']({ user: parent, params: { id: 'ride-1' } }, res);
  assert.equal(res.body.closed, true);
  assert.equal(res.body.messages.length, 0);
});
