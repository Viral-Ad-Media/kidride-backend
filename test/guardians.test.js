const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseInvite, resolveFamily, fetchGuardianProfiles, isMissingTable } = require('../lib/guardians');

const owner = { id: 'owner', email: 'Owner@Example.com', role: 'parent' };

test('an invite needs a real email that is not your own, and is normalised', () => {
  assert.ok(parseInvite({ email: 'nope' }, owner).error);
  assert.ok(parseInvite({ email: ' owner@example.com ' }, owner).error);
  const { invite } = parseInvite({ email: ' Sam@Example.COM ', name: '  Sam   Lee ', relationship: 'Dad' }, owner);
  assert.deepEqual(invite, { email: 'sam@example.com', name: 'Sam Lee', relationship: 'Dad' });
});

const fakeDb = (link, error = null) => ({
  from: () => ({ select() { return this; }, eq() { return this; }, in() { return this; }, maybeSingle: async () => ({ data: link, error }), then: (resolve) => resolve({ data: link ? [link] : [], error }) })
});

test('an active guardian acts for the owner family; everyone else for themselves', async () => {
  assert.deepEqual(await resolveFamily(fakeDb({ owner_id: 'owner' }), { id: 'sam', role: 'parent' }), { familyId: 'owner', familyRole: 'guardian', familyOwnerId: 'owner' });
  assert.equal((await resolveFamily(fakeDb(null), { id: 'sam', role: 'parent' })).familyId, 'sam');
  assert.equal((await resolveFamily(fakeDb({ owner_id: 'owner' }), { id: 'd1', role: 'driver' })).familyId, 'd1');
});

test('without the family table, nobody is linked and alerts go to the parent only', async () => {
  const missing = { code: '42P01', message: 'relation "public.family_guardians" does not exist' };
  assert.equal(isMissingTable(missing), true);
  assert.equal((await resolveFamily(fakeDb(null, missing), { id: 'sam', role: 'parent' })).familyId, 'sam');
  assert.deepEqual(await fetchGuardianProfiles(fakeDb(null, missing), 'owner'), []);
});
