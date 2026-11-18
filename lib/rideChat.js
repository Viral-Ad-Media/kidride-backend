// Chat between the parent and the driver of a ride ("Where are you?", "I'm
// outside"). It opens when a driver accepts and closes when the trip ends. Once
// the trip has ended neither of them can read it any more: the conversation is
// compressed into ride_chat_archives, where only KidRide's safety team can see
// it, and its messages are removed from ride_messages. The rules live here;
// routes/messageRoutes.js serves them. Nothing here loads the database: callers pass it in.

const zlib = require('node:zlib');

const MAX_LENGTH = 500;
// The newest messages a chat shows. A trip's chat is a handful of lines, so this is only a ceiling.
const HISTORY_LIMIT = 200;
// The two are meeting or travelling.
const OPEN_STATUSES = ['driver_assigned', 'driver_arrived_at_pickup', 'child_picked_up'];
const COLUMNS = 'id, sender_id, sender_role, body, created_at, read_at';
const CLOSED_MESSAGE = 'This chat closed when the trip ended.';
const ENDED_STATUSES = ['completed', 'cancelled'];
// The most messages one conversation is archived with at a time; far more than a trip's chat ever holds.
const ARCHIVE_BATCH = 2000;
// Finished chats that were not archived the moment the ride ended are looked for this often.
const SWEEP_EVERY_MS = 60 * 1000;
const NO_DRIVER_MESSAGE = 'You can message the driver once one has accepted the ride.';

/** The text of a message someone wants to send, tidied; or why it cannot be sent. */
const parseMessage = (input) => {
  const text = typeof input?.body === 'string'
    ? input.body.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    : '';
  if (!text) return { error: 'Write a message first.' };
  if (text.length > MAX_LENGTH) return { error: `Keep messages under ${MAX_LENGTH} characters.` };
  return { text };
};

/** Which side of the chat this person is on: 'parent', 'driver', or null for anyone else. */
const chatRole = (user, ride) => {
  if (!user?.id || !ride) return null;
  if (ride.parent_id === user.id) return 'parent';
  if (ride.driver_id && ride.driver_id === user.id) return 'driver';
  return null;
};

/** New messages can be sent only while a driver is on the ride and the trip has not ended. */
const chatOpen = (ride) => !!ride?.driver_id && OPEN_STATUSES.includes(ride.status);

const formatMessage = (row, userId) => ({
  id: row.id,
  body: row.body,
  from: row.sender_role,
  mine: row.sender_id === userId,
  sentAt: row.created_at,
  readAt: row.read_at || null
});

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/** What the other person's phone shows for a new message. */
const pushWords = ({ from, senderName, text }) => ({
  title: from === 'driver'
    ? `${firstName(senderName) || 'Your driver'} (your driver)`
    : `${firstName(senderName) || 'The parent'} (parent)`,
  body: text.length > 160 ? `${text.slice(0, 157)}...` : text
});

/** The chat as this person sees it, oldest first. */
const listMessages = async (db, ride, userId) => {
  if (!ride.driver_id) return [];
  const { data, error } = await db.from('ride_messages').select(COLUMNS)
    .eq('ride_id', ride.id).eq('driver_id', ride.driver_id)
    .order('created_at', { ascending: false }).limit(HISTORY_LIMIT);
  if (error) throw error;
  return (data || []).reverse().map((row) => formatMessage(row, userId));
};

/**
 * What is waiting for this person in a ride's chat: how many messages they have
 * not opened, and the newest of them (for the badge and the in-app alert).
 */
const unreadSummary = async (db, ride, userId) => {
  if (!ride.driver_id) return { unread: 0, latest: null };
  const { data, error } = await db.from('ride_messages').select('id, body, created_at')
    .eq('ride_id', ride.id).eq('driver_id', ride.driver_id).neq('sender_id', userId).is('read_at', null)
    .order('created_at', { ascending: false }).limit(20);
  if (error) throw error;
  const rows = data || [];
  return { unread: rows.length, latest: rows[0] ? { id: rows[0].id, body: rows[0].body, sentAt: rows[0].created_at } : null };
};

// ---- The safety copy ----

/** A conversation as one compressed text: gzip of its JSON, in base64. */
const packTranscript = (messages) => zlib.gzipSync(Buffer.from(JSON.stringify({ v: 1, messages }), 'utf8'), { level: 9 }).toString('base64');

/** The messages of a packed conversation; none when it cannot be read. */
const unpackTranscript = (packed) => {
  try {
    const parsed = JSON.parse(zlib.gunzipSync(Buffer.from(String(packed), 'base64')).toString('utf8'));
    return Array.isArray(parsed?.messages) ? parsed.messages : [];
  } catch {
    return [];
  }
};

const toArchived = (row) => ({ id: row.id, at: row.created_at, from: row.sender_role, senderId: row.sender_id, body: row.body, readAt: row.read_at || null });

/**
 * Moves one conversation (a ride with one driver) out of ride_messages into its
 * compressed safety copy. The copy is stored first; only then are the readable
 * messages removed, so a failure half way loses nothing. Returns how many messages moved.
 */
const archiveConversation = async (db, { rideId, driverId, parentId }) => {
  const { data: rows, error } = await db.from('ride_messages').select(COLUMNS)
    .eq('ride_id', rideId).eq('driver_id', driverId).order('created_at', { ascending: true }).limit(ARCHIVE_BATCH);
  if (error) throw error;
  if (!rows?.length) return 0;
  const { data: existing, error: readError } = await db.from('ride_chat_archives').select('id, transcript_gz').eq('ride_id', rideId).eq('driver_id', driverId).maybeSingle();
  if (readError) throw readError;
  // A copy made earlier (the ride ended twice over, or a late message slipped in) is added to, not replaced.
  const earlier = existing ? unpackTranscript(existing.transcript_gz) : [];
  const known = new Set(earlier.map((message) => message.id));
  const messages = [...earlier, ...rows.filter((row) => !known.has(row.id)).map(toArchived)].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const record = {
    ride_id: rideId,
    driver_id: driverId,
    parent_id: parentId || null,
    message_count: messages.length,
    first_message_at: messages[0].at,
    last_message_at: messages[messages.length - 1].at,
    transcript_gz: packTranscript(messages),
    archived_at: new Date().toISOString()
  };
  const { error: writeError } = existing
    ? await db.from('ride_chat_archives').update(record).eq('id', existing.id)
    : await db.from('ride_chat_archives').insert(record);
  if (writeError) throw writeError;
  const { error: deleteError } = await db.from('ride_messages').delete().in('id', rows.map((row) => row.id));
  if (deleteError) throw deleteError;
  return rows.length;
};

/** The ride has ended: every conversation it had is closed and archived. */
const archiveRideChat = async (db, ride) => {
  const { data, error } = await db.from('ride_messages').select('driver_id').eq('ride_id', ride.id).limit(ARCHIVE_BATCH);
  if (error) throw error;
  let moved = 0;
  for (const driverId of [...new Set((data || []).map((row) => row.driver_id))]) {
    moved += await archiveConversation(db, { rideId: ride.id, driverId, parentId: ride.parent_id });
  }
  return moved;
};

/**
 * Archives conversations that should be closed but still have readable
 * messages: the ride ended some other way (a repeating booking cancelled, an
 * account closed), or the ride has since gone to another driver.
 */
const sweepEndedChats = async (db) => {
  const { data, error } = await db.from('ride_messages').select('ride_id, driver_id').order('created_at', { ascending: true }).limit(500);
  if (error) throw error;
  const pairs = [...new Map((data || []).map((row) => [`${row.ride_id}:${row.driver_id}`, row])).values()];
  if (!pairs.length) return 0;
  const { data: rides, error: rideError } = await db.from('rides').select('id, status, driver_id, parent_id').in('id', [...new Set(pairs.map((pair) => pair.ride_id))]);
  if (rideError) throw rideError;
  const byId = new Map((rides || []).map((ride) => [ride.id, ride]));
  let moved = 0;
  for (const pair of pairs) {
    const ride = byId.get(pair.ride_id);
    if (!ride) continue;
    if (ENDED_STATUSES.includes(ride.status) || ride.driver_id !== pair.driver_id) {
      moved += await archiveConversation(db, { rideId: ride.id, driverId: pair.driver_id, parentId: ride.parent_id });
    }
  }
  return moved;
};

let lastSweep = 0;
/** Runs the sweep at most once a minute. Never throws: a failed sweep is tried again later. */
const sweepIfDue = async (db, now = Date.now()) => {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  try {
    await sweepEndedChats(db);
  } catch (error) {
    console.warn('Chat archive sweep failed', error?.message || error);
  }
};

/**
 * Everything said on a ride, for KidRide's safety team: the archived
 * conversations and, on a ride still under way, the messages so far.
 */
const transcriptForSafety = async (db, ride) => {
  const [archives, live] = await Promise.all([
    db.from('ride_chat_archives').select('driver_id, transcript_gz, archived_at').eq('ride_id', ride.id),
    db.from('ride_messages').select(`${COLUMNS}, driver_id`).eq('ride_id', ride.id).order('created_at', { ascending: true }).limit(ARCHIVE_BATCH)
  ]);
  if (archives.error) throw archives.error;
  if (live.error) throw live.error;
  const archived = (archives.data || []).flatMap((archive) => unpackTranscript(archive.transcript_gz)
    .map((message) => ({ id: message.id, body: message.body, from: message.from, mine: false, sentAt: message.at, readAt: message.readAt || null, archived: true })));
  const current = (live.data || []).map((row) => ({ ...formatMessage(row, null), archived: false }));
  return [...archived, ...current].sort((a, b) => String(a.sentAt).localeCompare(String(b.sentAt)));
};

module.exports = {
  MAX_LENGTH,
  HISTORY_LIMIT,
  OPEN_STATUSES,
  COLUMNS,
  CLOSED_MESSAGE,
  NO_DRIVER_MESSAGE,
  parseMessage,
  chatRole,
  chatOpen,
  formatMessage,
  pushWords,
  listMessages,
  unreadSummary,
  ENDED_STATUSES,
  packTranscript,
  unpackTranscript,
  archiveConversation,
  archiveRideChat,
  sweepEndedChats,
  sweepIfDue,
  transcriptForSafety
};
