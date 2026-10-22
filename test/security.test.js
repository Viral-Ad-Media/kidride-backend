const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const security = require('../lib/security');
const { createRateLimiter, getClientIdentifier } = require('../middleware/rateLimitMiddleware');
const pricing = require('../lib/pricing');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
function load(relative, mocks) {
  const filename = path.join(__dirname, '..', relative);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name), process, console, Date, Set }, { filename });
  return module.exports;
}
function response() { return { code: 200, headers: {}, status(n) { this.code=n; return this; }, json(body) { this.body=body; return this; }, setHeader(k,v) { this.headers[k]=v; } }; }
function routes(repository = {}, database = {}) {
  const handlers = {};
  const router = Object.fromEntries(['get','post','put','delete'].map(method => [method, (url,...args) => { handlers[`${method} ${url}`]=args.at(-1); }]));
  load('routes/rideRoutes.js', { express: { Router: () => router }, '../middleware/authMiddleware': { protect() {} }, '../middleware/rateLimitMiddleware': { createRateLimiter: () => () => {}, parsePositiveInt: (_, fallback) => fallback }, '../config/supabase': { supabaseAdmin: database }, '../lib/repository': repository, '../lib/security': security, '../lib/push': { notifyRide: async () => {} }, '../lib/notifications': { notifyRideEvent: async () => {} }, '../lib/ratings': { MAX_COMMENT_LENGTH: 500 }, '../lib/pricingSettings': { loadPricing: async () => pricing.normalizeSettings({}) }, '../lib/dispatch': { advanceDispatch: async () => {}, releaseDueScheduledRides: async () => 0, fetchLiveOffers: async () => new Map(), setOfferStatus: async () => {}, findNearbyDrivers: async () => [] } });
  return handlers;
}
test('approval requires role, verification and approved status together', () => {
  const good={role:'driver',isVerifiedDriver:true,driverApplicationStatus:'approved'};
  assert.equal(security.isApprovedDriver(good),true);
  for (const mutation of [{role:'parent'},{isVerifiedDriver:false},{driverApplicationStatus:'pending'},{driverApplicationStatus:'rejected'}]) assert.equal(security.isApprovedDriver({...good,...mutation}),false);
});
test('offer redaction removes child, parent and handoff credentials without changing participant payload', () => {
  const ride={id:'ride',child:'child',parent:'parent',tripCode:'1234',safeWord:'secret',price:25};
  assert.deepEqual(security.redactOffer(ride),{id:'ride',price:25}); assert.equal(ride.tripCode,'1234');
});
test('GPS rejects strings, nonfinite numbers and out-of-range coordinates', () => {
  assert.equal(security.validateCoordinates({latitude:90,longitude:-180,accuracy:0}),true);
  for (const value of [{latitude:'1',longitude:1},{latitude:NaN,longitude:1},{latitude:91,longitude:1},{latitude:1,longitude:181},{latitude:1,longitude:1,accuracy:-1}]) assert.equal(security.validateCoordinates(value),false);
});
test('handoff credentials have the expected format', () => { for(let i=0;i<100;i++) { assert.match(security.generateTripCode(),/^\d{4}$/); assert.match(security.generateSafeWord(),/^[A-Za-z]+-[A-Za-z]+-\d{3}$/); } });
test('forwarded headers cannot choose the rate-limit identity', () => { assert.equal(getClientIdentifier({ip:'trusted',headers:{'x-forwarded-for':'spoof'}}),'trusted'); assert.equal(getClientIdentifier({socket:{remoteAddress:'socket'},headers:{'x-forwarded-for':'spoof'}}),'socket'); });
test('shared rate limiter uses persistent counts and fails closed on store failure', async () => {
  const limiter=createRateLimiter({max:2,consume:async()=>3});const res=response(); let called=false; await limiter({ip:'a'},res,()=>called=true);assert.equal(res.code,429);assert.equal(called,false);
  const failing=createRateLimiter({consume:async()=>{throw Error('database');}});const failed=response();await failing({ip:'a'},failed,()=>called=true);assert.equal(failed.code,503);
});
test('unapproved drivers cannot list offers or accept rides', async () => {
  const handlers=routes(); for (const endpoint of ['get /open','put /:id/accept']) { const res=response(); await handlers[endpoint]({user:{role:'driver',isVerifiedDriver:false},params:{id:'ride'}},res);assert.equal(res.code,403); }
});
test('booking rejects a child belonging to a different account before database access', async () => {
  const res=response();await routes()['post /request']({user:{role:'parent',id:'parent',children:[{id:'own'}]},body:{childId:'other'}},res);assert.equal(res.code,403);
});
test('booking rejects a missing, forged or different-trip quote rather than accepting a client price', async () => {
  const { quoteAllServices } = require('../lib/fareQuotes');
  const a = { lat: 51.5, lng: -0.12 }, b = { lat: 51.52, lng: -0.1 };
  const { quotes } = await quoteAllServices(pricing.normalizeSettings({}), 'parent', { pickupCoords: a, dropoffCoords: b, scheduledAt: null, stayMinutes: 60 });
  const body = { childId: 'own', pickup: 'A', dropoff: 'B', pickupCoords: a, dropoffCoords: b, serviceType: 'pickup_only', price: 1 };
  const cases = [{}, { quoteToken: 'forged' }, { quoteToken: quotes.dropoff_only.quoteToken }, { quoteToken: quotes.pickup_only.quoteToken, dropoffCoords: { lat: 51.6, lng: -0.1 } }];
  for (const extra of cases) { const res=response();await routes()['post /request']({user:{role:'parent',id:'parent',children:[{id:'own'}]},body:{...body,...extra}},res);assert.equal(res.code,409); }
  const res=response();await routes()['post /request']({user:{role:'parent',id:'someone-else',children:[{id:'own'}]},body:{...body,quoteToken:quotes.pickup_only.quoteToken}},res);assert.equal(res.code,409);
});
test('ride writes compare the expected status and assigned driver and report conflicts', async () => {
  const filters=[]; const query={update(){return this;},eq(k,v){filters.push([k,v]);return this;},select(){return this;},async maybeSingle(){return {data:null,error:null};}};
  const repository=load('lib/repository.js',{'../config/supabase':{supabaseAdmin:{from:()=>query}}});
  await assert.rejects(repository.updateRideRow('ride',{status:'completed'},'child_picked_up','driver'),e=>e.status===409);
  assert.deepEqual(filters,[['id','ride'],['status','child_picked_up'],['driver_id','driver']]);
});
test('ordinary cancellation is blocked after pickup', async () => {
  const handlers=routes({fetchRideRowById:async()=>({id:'ride',parent_id:'parent',status:'child_picked_up'})});const res=response();await handlers['put /:id/cancel']({params:{id:'ride'},user:{id:'parent',role:'parent'}},res);assert.equal(res.code,409);
});
test('public signup rejects admin role before creating an auth account', async () => {
  let register;
  load('routes/authRoutes.js', {express:{Router:()=>({post:(url,...handlers)=>{if(url==='/register')register=handlers.at(-1);},get(){}})},jsonwebtoken:{},'../middleware/authMiddleware':{protect(){},BLOCKED_MESSAGE:'blocked'},'../middleware/rateLimitMiddleware':{createRateLimiter:()=>()=>{},parsePositiveInt:(_,fallback)=>fallback},'../config/supabase':{},'../lib/repository':{}});
  const res=response();await register({body:{name:'Admin',email:'admin@example.test',password:'password',role:'admin'}},res);assert.equal(res.code,400);
});
test('assigned driver status writes compare the previous state and surface a stale-update conflict', async () => {
  let argumentsSeen;
  const handlers=routes({fetchRideRowById:async()=>({id:'ride',driver_id:'driver',status:'driver_assigned'}),updateRideRow:async(...args)=>{argumentsSeen=args;throw Object.assign(Error('changed'),{status:409});}});
  const res=response();await handlers['put /:id/status']({params:{id:'ride'},body:{status:'driver_arrived_at_pickup'},user:{id:'driver',role:'driver',isVerifiedDriver:true,driverApplicationStatus:'approved'}},res);
  assert.equal(res.code,409);assert.equal(argumentsSeen[2],'driver_assigned');assert.equal(argumentsSeen[3],'driver');
});
test('assigned driver who is no longer approved cannot advance ride status', async () => {
  let updated=false;
  const handlers=routes({fetchRideRowById:async()=>({id:'ride',driver_id:'driver',status:'driver_assigned'}),updateRideRow:async()=>{updated=true;}});
  for (const user of [{id:'driver',role:'driver',isVerifiedDriver:false,driverApplicationStatus:'pending'},{id:'driver',role:'driver',isVerifiedDriver:true,driverApplicationStatus:'rejected'}]) {
    const res=response();await handlers['put /:id/status']({params:{id:'ride'},body:{status:'child_picked_up'},user},res);assert.equal(res.code,403);
  }
  assert.equal(updated,false);
});
function authHandlers(supabaseAuth, repository = {}, supabaseAdmin = {}) {
  const handlers={};
  load('routes/authRoutes.js', {express:{Router:()=>({post:(url,...h)=>{handlers[url]=h.at(-1);},get(){}})},jsonwebtoken:{sign:()=>'token'},'../middleware/authMiddleware':{protect(){}},'../middleware/rateLimitMiddleware':{createRateLimiter:()=>()=>{},parsePositiveInt:(_,fallback)=>fallback},'../config/supabase':{supabaseAuth,supabaseAdmin},'../lib/repository':repository});
  return handlers;
}
test('registration requires email confirmation and issues no token', async () => {
  let profile;
  const handlers=authHandlers({auth:{signUp:async()=>({data:{user:{id:'u1',identities:[{}]}},error:null})}},{upsertProfileRow:async row=>{profile=row;}});
  const res=response();await handlers['/register']({body:{name:'Pat',email:'Pat@Example.test',password:'password',role:'parent'}},res);
  assert.equal(res.code,202);assert.equal(res.body.requiresEmailVerification,true);assert.equal(res.body.token,undefined);assert.equal(profile.email,'pat@example.test');
});
test('registration for an existing email looks identical and writes no profile', async () => {
  let wrote=false;
  const handlers=authHandlers({auth:{signUp:async()=>({data:{user:{id:'existing',identities:[]}},error:null})}},{upsertProfileRow:async()=>{wrote=true;}});
  const res=response();await handlers['/register']({body:{name:'Pat',email:'pat@example.test',password:'password'}},res);
  assert.equal(res.code,202);assert.equal(wrote,false);
});
test('registration signs the user in when Supabase confirms the email at signup', async () => {
  let profile;
  const user={id:'u2',email:'pat@example.test',email_confirmed_at:'2026-01-01',identities:[{}],user_metadata:{name:'Pat',role:'parent'}};
  const handlers=authHandlers({auth:{signUp:async()=>({data:{user,session:{access_token:'s'}},error:null})}},{upsertProfileRow:async row=>{profile=row;},fetchUserById:async()=>profile&&{id:'u2',name:'Pat',email:profile.email,role:profile.role,tokenVersion:0}});
  const res=response();await handlers['/register']({body:{name:'Pat',email:'pat@example.test',password:'password',role:'parent'}},res);
  assert.equal(res.code,201);assert.equal(res.body.token,'token');assert.equal(res.body.role,'parent');assert.equal(res.body.requiresEmailVerification,undefined);
});
test('login is refused until the email is confirmed', async () => {
  for (const result of [{data:{user:null},error:{code:'email_not_confirmed'}},{data:{user:{id:'u1',email_confirmed_at:null}},error:null}]) {
    const handlers=authHandlers({auth:{signInWithPassword:async()=>result}});
    const res=response();await handlers['/login']({body:{email:'pat@example.test',password:'password'}},res);assert.equal(res.code,403);assert.equal(res.body.code,'email_not_confirmed');
  }
});
const { sendError } = require('../lib/http');
test('sendError hides internal error text but passes through deliberate 4xx/503 and unique-violations', () => {
  const originalError=console.error; console.error=()=>{};
  try {
    let res=response(); sendError(res, new Error('relation "rides" violates constraint rides_child_id_fkey')); assert.equal(res.code,500); assert.equal(res.body.message,'Request failed');
    res=response(); sendError(res, Object.assign(new Error('Ride changed. Refresh and try again.'),{status:409})); assert.equal(res.code,409); assert.match(res.body.message,/Ride changed/);
    res=response(); sendError(res, Object.assign(new Error('Pricing unavailable'),{status:503})); assert.equal(res.code,503);
    res=response(); sendError(res, Object.assign(new Error('duplicate key'),{code:'23505'})); assert.equal(res.code,409);
  } finally { console.error=originalError; }
});
test('terminal status updates and cancellations clear the driver GPS fix and notify the driver too', async () => {
  const emitted=[]; let updates;
  const io={ to:(rooms)=>({ emit:(event)=>emitted.push([rooms,event]) }) };
  const handlers=routes({fetchRideRowById:async()=>({id:'ride',parent_id:'parent',driver_id:'driver',status:'child_picked_up'}),updateRideRow:async(_id,changes)=>{updates=changes;return {id:'ride',parent_id:'parent',driver_id:'driver',status:changes.status,price:1};}, formatRide:(r)=>r});
  let res=response();await handlers['put /:id/status']({params:{id:'ride'},body:{status:'completed'},user:{id:'driver',role:'driver',isVerifiedDriver:true,driverApplicationStatus:'approved'},app:{get:()=>io}},res);
  assert.equal(res.code,200); assert.equal(updates.driver_location,null); assert.equal(JSON.stringify(emitted.at(-1)[0]),JSON.stringify(['parent','driver']));
  const cancel=routes({fetchRideRowById:async()=>({id:'ride',parent_id:'parent',driver_id:'driver',status:'driver_assigned'}),updateRideRow:async(_id,changes)=>{updates=changes;return {id:'ride',parent_id:'parent',driver_id:'driver',status:'cancelled',price:1};}, formatRide:(r)=>r});
  res=response();await cancel['put /:id/cancel']({params:{id:'ride'},user:{id:'parent',role:'parent'},app:{get:()=>null}},res);
  assert.equal(res.code,200); assert.equal(updates.driver_location,null);
});
test('protect rejects tokens whose version predates a logout-everywhere', async () => {
  const { protect } = load('middleware/authMiddleware.js', { jsonwebtoken:{ verify:()=>({id:'u1',tv:0}) }, '../lib/repository':{ fetchUserById: async()=>({id:'u1',tokenVersion:1}) } });
  let nextCalled=false; const res=response();
  await protect({headers:{authorization:'Bearer x'}},res,()=>{nextCalled=true;});
  assert.equal(res.code,401); assert.equal(nextCalled,false);
  const { protect: fresh } = load('middleware/authMiddleware.js', { jsonwebtoken:{ verify:()=>({id:'u1',tv:1}) }, '../lib/repository':{ fetchUserById: async()=>({id:'u1',tokenVersion:1}) } });
  nextCalled=false; await fresh({headers:{authorization:'Bearer x'}},response(),()=>{nextCalled=true;}); assert.equal(nextCalled,true);
});
test('login rebuilds a missing profile from auth metadata with a non-admin role', async () => {
  let written;
  const handlers=authHandlers({auth:{signInWithPassword:async()=>({data:{user:{id:'u9',email:'Dash@Example.test',email_confirmed_at:'2026-01-01',user_metadata:{name:'Dash',role:'admin'}}},error:null})}},{fetchUserById:async()=>written?{id:'u9',name:'Dash',email:'dash@example.test',role:written.role,tokenVersion:0}:null,upsertProfileRow:async row=>{written=row;}});
  const res=response();await handlers['/login']({body:{email:'dash@example.test',password:'pw'}},res);
  assert.equal(res.code,200); assert.equal(written.role,'parent'); assert.equal(res.body.token,'token');
});
test('a successful driver application removes only the applicant uploads it does not use', async () => {
  let removed;
  const storage = { from: () => ({
    list: async (folder) => ({ data: folder.endsWith('/license') ? [{ name: 'keep-1' }, { name: 'old-2' }] : [] }),
    remove: async (paths) => { removed = paths; return {}; }
  }) };
  const { removeUnusedUploads } = load('lib/verification.js', { '../config/supabase': { supabaseAdmin: { storage } } });
  await removeUnusedUploads('u1', { license: 'u1/license/keep-1' });
  assert.deepEqual([...removed], ['u1/license/old-2']);
  const failing = load('lib/verification.js', { '../config/supabase': { supabaseAdmin: { storage: { from: () => ({ list: async () => { throw new Error('down'); } }) } } } });
  await failing.removeUnusedUploads('u1', {});
});
test('blocked accounts are refused by protect and are never issued a login token', async () => {
  const { protect } = load('middleware/authMiddleware.js', { jsonwebtoken:{ verify:()=>({id:'u1',tv:0}) }, '../lib/repository':{ fetchUserById: async()=>({id:'u1',tokenVersion:0,isBlocked:true}) } });
  let nextCalled=false; const res=response();
  await protect({headers:{authorization:'Bearer x'}},res,()=>{nextCalled=true;});
  assert.equal(res.code,403); assert.equal(res.body.code,'account_blocked'); assert.equal(nextCalled,false);
  const handlers=authHandlers({auth:{signInWithPassword:async()=>({data:{user:{id:'u1',email:'b@example.test',email_confirmed_at:'2026-01-01'}},error:null})}},{fetchUserById:async()=>({id:'u1',name:'B',email:'b@example.test',role:'parent',tokenVersion:0,isBlocked:true})});
  const login=response(); await handlers['/login']({body:{email:'b@example.test',password:'pw'}},login);
  assert.equal(login.code,403); assert.equal(login.body.token,undefined);
});
function adminRoutes(repository = {}, database = {}) {
  const handlers = {};
  const router = Object.fromEntries(['get','put'].map(method => [method, (url,...args) => { handlers[`${method} ${url}`]=args; }]));
  load('routes/adminUserRoutes.js', { express: { Router: () => router }, '../middleware/authMiddleware': { protect() {} }, '../config/supabase': { supabaseAdmin: database }, '../lib/repository': repository, '../lib/ratings': { fetchRatingSummaries: async ids => new Map(ids.map(id => [id, { count: 0, average: null }])) } });
  // Run the admin check and then the handler, as Express would.
  const run = (key) => async (req, res) => { const [, guard, handler] = handlers[key]; let passed=false; guard(req, res, () => { passed=true; }); if (passed) await handler(req, res); };
  return { list: run('get /'), block: run('put /:id/block'), revoke: run('put /driver-applications/:id/revoke') };
}
test('admin user management is admin-only and block/revoke need a reason', async () => {
  let updated;
  const db = { from: () => ({ update: (row) => { updated=row; const q={ eq: () => q, then: (r) => r({ error:null }) }; return q; } }) };
  const routes = adminRoutes({ fetchUserById: async () => ({ id:'d1', role:'driver', tokenVersion:2, driverApplicationStatus:'approved' }) }, db);
  let res=response(); await routes.list({ user:{role:'parent'}, query:{role:'driver'} }, res); assert.equal(res.code,403);
  res=response(); await routes.block({ user:{role:'admin'}, params:{id:'d1'}, body:{} }, res); assert.equal(res.code,400);
  res=response(); await routes.block({ user:{role:'admin'}, params:{id:'d1'}, body:{reason:'Fake documents'} }, res);
  assert.equal(res.code,200); assert.equal(updated.is_blocked,true); assert.equal(updated.token_version,3);
  res=response(); await routes.revoke({ user:{role:'admin'}, params:{id:'d1'}, body:{} }, res); assert.equal(res.code,400);
  const pending = adminRoutes({ fetchUserById: async () => ({ id:'d2', role:'driver', tokenVersion:0, driverApplicationStatus:'pending' }) }, db);
  res=response(); await pending.revoke({ user:{role:'admin'}, params:{id:'d2'}, body:{reason:'x'} }, res); assert.equal(res.code,409);
});
test('only the booking parent can rate a completed ride, once, with 1-5 stars', async () => {
  let inserted;
  const insertResult = { data: { stars: 4, comment: 'Great', created_at: 'now' }, error: null };
  const db = { from: () => ({ insert: (row) => { inserted=row; return { select: () => ({ single: async () => insertResult }) }; } }) };
  const ride = { id:'r1', parent_id:'p1', driver_id:'d1', status:'completed' };
  const handlers = routes({ fetchRideRowById: async () => ride }, db);
  const rate = handlers['post /:id/rating'];
  let res=response(); await rate({ user:{id:'p1',role:'parent'}, params:{id:'r1'}, body:{stars:6} }, res); assert.equal(res.code,400);
  res=response(); await rate({ user:{id:'p2',role:'parent'}, params:{id:'r1'}, body:{stars:4} }, res); assert.equal(res.code,403);
  res=response(); await rate({ user:{id:'p1',role:'parent'}, params:{id:'r1'}, body:{stars:4, comment:'Great'} }, res);
  assert.equal(res.code,201); assert.equal(inserted.driver_id,'d1'); assert.equal(inserted.stars,4);
  insertResult.error = { code:'23505' }; insertResult.data = null;
  res=response(); await rate({ user:{id:'p1',role:'parent'}, params:{id:'r1'}, body:{stars:5} }, res); assert.equal(res.code,409);
  const active = routes({ fetchRideRowById: async () => ({ ...ride, status:'driver_assigned' }) }, db)['post /:id/rating'];
  res=response(); await active({ user:{id:'p1',role:'parent'}, params:{id:'r1'}, body:{stars:5} }, res); assert.equal(res.code,409);
});
test('driver presence heartbeat sets or clears last_online_at, drivers only', async () => {
  const handlers = {};
  const router = Object.fromEntries(['get','post','put','delete'].map(method => [method, (url,...args) => { handlers[`${method} ${url}`]=args.at(-1); }]));
  let updated;
  const supabaseAdmin = { from: () => ({ update: (row) => { updated=row; return { eq: async () => ({ error:null }) }; } }) };
  load('routes/userRoutes.js', { express: { Router: () => router }, '../middleware/authMiddleware': { protect() {} }, '../lib/repository': {}, '../config/supabase': { supabaseAdmin }, '../middleware/rateLimitMiddleware': { createRateLimiter: () => () => {}, parsePositiveInt: (_, f) => f }, '../lib/verification': { REQUIRED_DOCUMENTS: [], MIME_TYPES: new Set() }, '../lib/dispatch': { saveDriverLocation: async () => {} } });
  const presence = handlers['put /me/presence'];
  let res=response(); await presence({ user:{id:'p1',role:'parent'}, body:{online:true} }, res); assert.equal(res.code,403);
  res=response(); await presence({ user:{id:'d1',role:'driver'}, body:{online:true} }, res); assert.equal(res.body.online,true); assert.ok(updated.last_online_at);
  res=response(); await presence({ user:{id:'d1',role:'driver'}, body:{online:false} }, res); assert.equal(updated.last_online_at,null);
});
test('protect answers 503, not 401, when the account cannot be loaded', async () => {
  const originalError=console.error; console.error=()=>{};
  try {
    const { protect } = load('middleware/authMiddleware.js', { jsonwebtoken:{ verify:()=>({id:'u1',tv:0}) }, '../lib/repository':{ fetchUserById: async()=>{ throw new Error('fetch failed'); } } });
    let nextCalled=false; const res=response();
    await protect({headers:{authorization:'Bearer x'}},res,()=>{nextCalled=true;});
    assert.equal(res.code,503); assert.equal(nextCalled,false);
    const { protect: badToken } = load('middleware/authMiddleware.js', { jsonwebtoken:{ verify:()=>{ throw new Error('bad'); } }, '../lib/repository':{ fetchUserById: async()=>null } });
    const res2=response(); await badToken({headers:{authorization:'Bearer x'}},res2,()=>{}); assert.equal(res2.code,401);
  } finally { console.error=originalError; }
});
function childRoutes(db) {
  const handlers = {};
  const router = Object.fromEntries(['get','post','put','delete'].map(method => [method, (url,...args) => { handlers[`${method} ${url}`]=args.at(-1); }]));
  load('routes/userRoutes.js', { express: { Router: () => router }, '../middleware/authMiddleware': { protect() {} }, '../lib/repository': { fetchChildrenRowsByParentId: async () => [], formatChild: c => c }, '../config/supabase': { supabaseAdmin: db }, '../middleware/rateLimitMiddleware': { createRateLimiter: () => () => {}, parsePositiveInt: (_, f) => f }, '../lib/verification': { REQUIRED_DOCUMENTS: [], MIME_TYPES: new Set() }, '../lib/dispatch': { saveDriverLocation: async () => {} } });
  return handlers;
}
test('parents can edit and remove only their own children; children with ride history are archived', async () => {
  let removed = false, archived = false, activeRide = false, history = false;
  const ridesQuery = () => { let active = false; const q = { eq: () => q, not: () => { active = true; return q; }, limit: async () => ({ data: (active ? activeRide : history) ? [{ id: 'r1' }] : [], error: null }) }; return q; };
  const done = (fn) => { const q = { eq: () => q, then: (r) => { fn(); r({ error: null }); } }; return q; };
  const db = { from: (table) => ({
    select: () => table === 'children' ? { eq: () => ({ maybeSingle: async () => ({ data: { id: 'c1', parent_id: 'p1', archived_at: null }, error: null }) }) } : ridesQuery(),
    update: (row) => done(() => { if (row.archived_at) archived = true; }),
    delete: () => done(() => { removed = true; })
  }) };
  const h = childRoutes(db);
  let res = response(); await h['put /children/:id']({ user: { id: 'p2', role: 'parent' }, params: { id: 'c1' }, body: { name: 'A', age: 5 } }, res); assert.equal(res.code, 404);
  res = response(); await h['put /children/:id']({ user: { id: 'p1', role: 'parent' }, params: { id: 'c1' }, body: { name: '', age: 5 } }, res); assert.equal(res.code, 400);
  res = response(); await h['put /children/:id']({ user: { id: 'p1', role: 'parent' }, params: { id: 'c1' }, body: { name: 'Ada', age: 7 } }, res); assert.equal(res.code, 200);
  activeRide = true;
  res = response(); await h['delete /children/:id']({ user: { id: 'p1', role: 'parent' }, params: { id: 'c1' } }, res); assert.equal(res.code, 409); assert.equal(removed || archived, false);
  activeRide = false; history = true;
  res = response(); await h['delete /children/:id']({ user: { id: 'p1', role: 'parent' }, params: { id: 'c1' } }, res); assert.equal(res.code, 200); assert.equal(archived, true); assert.equal(removed, false);
  history = false;
  res = response(); await h['delete /children/:id']({ user: { id: 'p1', role: 'parent' }, params: { id: 'c1' } }, res); assert.equal(res.code, 200); assert.equal(removed, true);
});
test('login reports a connection failure as 503, not as a wrong password', async () => {
  const originalError=console.error; console.error=()=>{};
  try {
    const offline=authHandlers({auth:{signInWithPassword:async()=>({data:{user:null},error:{name:'AuthRetryableFetchError',status:0,message:'fetch failed'}})}});
    let res=response(); await offline['/login']({body:{email:'a@example.test',password:'pw'}},res); assert.equal(res.code,503);
    const wrong=authHandlers({auth:{signInWithPassword:async()=>({data:{user:null},error:{name:'AuthApiError',status:400,code:'invalid_credentials'}})}});
    res=response(); await wrong['/login']({body:{email:'a@example.test',password:'pw'}},res); assert.equal(res.code,401);
  } finally { console.error=originalError; }
});
test('trusted contacts: parents only, valid phone, at most five, own contacts only', async () => {
  const handlers = {};
  const router = Object.fromEntries(['get','post','delete'].map(method => [method, (url,...args) => { handlers[`${method} ${url}`]=args; }]));
  let rows = [], inserted;
  const listQuery = { eq: () => listQuery, order: async () => ({ data: rows, error: null }) };
  const db = { from: () => ({
    select: () => listQuery,
    insert: async (row) => { inserted = row; rows = [...rows, { id: `t${rows.length}`, ...row, created_at: 'now' }]; return { error: null }; },
    delete: () => { const q = { eq: (k, v) => { q[k] = v; return q; }, select: async () => ({ data: q.parent_id === 'p1' ? [{ id: q.id }] : [], error: null }) }; return q; }
  }) };
  load('routes/trustedContactRoutes.js', { express: { Router: () => router }, '../middleware/authMiddleware': { protect() {} }, '../config/supabase': { supabaseAdmin: db } });
  const run = (key) => async (req, res) => { const [, guard, handler] = handlers[key]; let ok=false; guard(req, res, () => { ok=true; }); if (ok) await handler(req, res); };
  const add = run('post /'), remove = run('delete /:id');
  let res = response(); await add({ user: { id: 'd1', role: 'driver' }, body: { name: 'A', phone: '+44 7700 900123' } }, res); assert.equal(res.code, 403);
  res = response(); await add({ user: { id: 'p1', role: 'parent' }, body: { name: 'Gran', phone: 'call me' } }, res); assert.equal(res.code, 400);
  res = response(); await add({ user: { id: 'p1', role: 'parent' }, body: { name: 'Gran', phone: '+44 7700 900123', relationship: 'Grandmother' } }, res);
  assert.equal(res.code, 201); assert.equal(inserted.parent_id, 'p1'); assert.equal(res.body.contacts.length, 1);
  rows = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, name: 'X', phone: '0123456789', created_at: 'now' }));
  res = response(); await add({ user: { id: 'p1', role: 'parent' }, body: { name: 'Sixth', phone: '0123456789' } }, res); assert.equal(res.code, 409);
  res = response(); await remove({ user: { id: 'p2', role: 'parent' }, params: { id: 't0' } }, res); assert.equal(res.code, 404);
  res = response(); await remove({ user: { id: 'p1', role: 'parent' }, params: { id: 't0' } }, res); assert.equal(res.code, 200);
});
test('driver GPS accepts heading and speed in range; booked places keep only valid lat/lng', () => {
  assert.equal(security.validateCoordinates({ latitude: 51.5, longitude: -0.12, heading: 270, speed: 12 }), true);
  assert.equal(security.validateCoordinates({ latitude: 51.5, longitude: -0.12, heading: 400 }), false);
  assert.equal(security.validateCoordinates({ latitude: 51.5, longitude: -0.12, speed: -1 }), false);
  assert.deepEqual(security.parsePlaceCoords({ lat: 51.5, lng: -0.12, extra: 'x' }), { lat: 51.5, lng: -0.12 });
  assert.equal(security.parsePlaceCoords({ lat: 'a', lng: 1 }), null);
  assert.equal(security.parsePlaceCoords(null), null);
});
// A tiny in-memory stand-in for the Supabase query builder, enough for lib/dispatch.js.
function fakeDb(tables) {
  const log = [];
  const from = (table) => {
    let filters = [];
    let op = 'select', payload;
    const rows = () => (tables[table] || []).filter((row) => filters.every((f) => f(row)));
    const q = {
      select: () => q,
      eq: (k, v) => { filters.push((r) => r[k] === v); return q; },
      in: (k, vs) => { filters.push((r) => vs.includes(r[k])); return q; },
      is: (k, v) => { filters.push((r) => (r[k] ?? null) === v); return q; },
      gte: (k, v) => { filters.push((r) => r[k] >= v); return q; },
      gt: (k, v) => { filters.push((r) => r[k] > v); return q; },
      lte: (k, v) => { filters.push((r) => r[k] <= v); return q; },
      limit: () => q,
      order: () => q,
      maybeSingle: async () => ({ data: rows()[0] || null, error: null }),
      update: (p) => { op = 'update'; payload = p; return q; },
      insert: async (p) => { log.push({ table, op: 'insert', payload: p }); (tables[table] = tables[table] || []).push(p); return { error: null }; },
      upsert: async (p) => { log.push({ table, op: 'upsert', payload: p }); return { error: null }; },
      then: (resolve) => {
        if (op === 'update') { const hit = rows(); hit.forEach((r) => Object.assign(r, payload)); log.push({ table, op: 'update', payload, count: hit.length }); return resolve({ error: null }); }
        return resolve({ data: rows(), error: null });
      }
    };
    return q;
  };
  return { db: { from }, log };
}
const loadDispatch = (db) => load('lib/dispatch.js', { '../config/supabase': { supabaseAdmin: db }, 'h3-js': require('h3-js') });
const now = () => new Date().toISOString();
const pickup = { lat: 51.5034, lng: -0.1276 };
const nearDriver = (id, lat, lng) => ({ driver_id: id, lat, lng, h3_index: require('h3-js').latLngToCell(lat, lng, 8), updated_at: now() });
const approved = (id, extra = {}) => ({ id, role: 'driver', is_verified_driver: true, driver_application_status: 'approved', is_blocked: false, last_online_at: now(), ...extra });

test('dispatch offers the ride to the nearest eligible driver first', async () => {
  const { db, log } = fakeDb({
    driver_locations: [nearDriver('far', 51.5070, -0.1300), nearDriver('near', 51.5036, -0.1278), nearDriver('busy', 51.5035, -0.1277), nearDriver('offline', 51.5034, -0.1276)],
    profiles: [approved('far'), approved('near'), approved('busy'), approved('offline', { last_online_at: '2000-01-01T00:00:00Z' })],
    rides: [{ driver_id: 'busy', status: 'driver_assigned' }],
    ride_offers: []
  });
  const dispatch = loadDispatch(db);
  const nearby = await dispatch.findNearbyDrivers(pickup);
  assert.deepEqual(nearby.map((d) => d.driverId), ['near', 'far']);
  await dispatch.advanceDispatch({ id: 'r1', status: 'searching_driver', driver_id: null, dispatch_state: 'targeted', pickup_coords: pickup });
  const offer = log.find((e) => e.table === 'ride_offers' && e.op === 'insert');
  assert.equal(offer.payload.driver_id, 'near');
  assert.ok(new Date(offer.payload.expires_at) > new Date());
});
test('dispatch keeps a live offer, then moves on, and opens the ride after three drivers or when nobody is near', async () => {
  const future = new Date(Date.now() + 10000).toISOString(), past = new Date(Date.now() - 1000).toISOString();
  let { db, log } = fakeDb({ ride_offers: [{ ride_id: 'r1', driver_id: 'a', status: 'pending', expires_at: future }] });
  await loadDispatch(db).advanceDispatch({ id: 'r1', status: 'searching_driver', driver_id: null, dispatch_state: 'targeted', pickup_coords: pickup });
  assert.equal(log.length, 0);
  ({ db, log } = fakeDb({ ride_offers: ['a', 'b', 'c'].map((d) => ({ ride_id: 'r1', driver_id: d, status: 'declined', expires_at: past })), rides: [{ id: 'r1', dispatch_state: 'targeted' }] }));
  await loadDispatch(db).advanceDispatch({ id: 'r1', status: 'searching_driver', driver_id: null, dispatch_state: 'targeted', pickup_coords: pickup });
  assert.ok(log.some((e) => e.table === 'rides' && e.payload.dispatch_state === 'open'));
  ({ db, log } = fakeDb({ ride_offers: [], driver_locations: [], rides: [{ id: 'r2', dispatch_state: 'targeted' }] }));
  await loadDispatch(db).advanceDispatch({ id: 'r2', status: 'searching_driver', driver_id: null, dispatch_state: 'targeted', pickup_coords: pickup });
  assert.ok(log.some((e) => e.table === 'rides' && e.payload.dispatch_state === 'open'));
});
test('admin live map lists online drivers as free or on a ride, with rides in progress', async () => {
  const recent = new Date().toISOString(), old = '2000-01-01T00:00:00Z';
  const { db } = fakeDb({
    driver_locations: [
      { driver_id: 'd1', lat: 51.5, lng: -0.12, heading: 90, updated_at: recent },
      { driver_id: 'd2', lat: 51.51, lng: -0.13, heading: null, updated_at: recent },
      { driver_id: 'd3', lat: 51.52, lng: -0.14, heading: null, updated_at: old }
    ],
    profiles: [
      { id: 'd1', name: 'Ada', role: 'driver', last_online_at: recent, vehicle: { make: 'Kia', plate: 'AB1' } },
      { id: 'd2', name: 'Ben', role: 'driver', last_online_at: recent, vehicle: {} },
      { id: 'd3', name: 'Cy', role: 'driver', last_online_at: recent, vehicle: {} }
    ],
    rides: [
      { id: 'r1', status: 'child_picked_up', driver_id: 'd1', pickup_location: 'A', dropoff_location: 'B', pickup_coords: { lat: 51.5, lng: -0.12 }, dispatch_state: 'open' },
      { id: 'r2', status: 'searching_driver', driver_id: null, pickup_location: 'C', dropoff_location: 'D', dispatch_state: 'targeted' },
      { id: 'r3', status: 'completed', driver_id: 'd2', pickup_location: 'E', dropoff_location: 'F' }
    ]
  });
  const handlers = {};
  load('routes/adminLiveRoutes.js', { express: { Router: () => ({ get: (url, ...args) => { handlers[url] = args.at(-1); } }) }, '../middleware/authMiddleware': { protect() {} }, '../config/supabase': { supabaseAdmin: db } });
  let res = response(); await handlers['/']({ user: { role: 'driver' } }, res); assert.equal(res.code, 403);
  res = response(); await handlers['/']({ user: { role: 'admin' } }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.drivers.map((d) => `${d.name}:${d.status}`), ['Ada:on_ride', 'Ben:free']);
  assert.deepEqual({ ...res.body.counts }, { online: 2, onRide: 1, ridesInProgress: 1, searching: 1 });
  assert.equal(res.body.rides.find((r) => r.id === 'r1').driverName, 'Ada');
});
const scheduling = require('../lib/scheduling');
const at = (ms) => new Date(Date.now() + ms).toISOString();
const MIN = 60 * 1000;
const slot = (ms) => { const d = new Date(Date.now() + ms); d.setUTCSeconds(0, 0); d.setUTCMinutes(Math.ceil(d.getUTCMinutes() / 5) * 5); return d; };

test('rides for later: 30 min to 30 days ahead, 5-minute steps', () => {
  assert.equal(scheduling.validateScheduledTime(slot(45 * MIN)), null);
  assert.equal(scheduling.validateScheduledTime(slot(29 * 24 * 60 * MIN)), null);
  assert.match(scheduling.validateScheduledTime(slot(10 * MIN)), /at least 30 minutes/);
  assert.match(scheduling.validateScheduledTime(slot(31 * 24 * 60 * MIN)), /30 days/);
  const odd = slot(60 * MIN); odd.setUTCMinutes(odd.getUTCMinutes() + 2);
  assert.match(scheduling.validateScheduledTime(odd), /5-minute/);
  assert.match(scheduling.validateScheduledTime(new Date('nope')), /valid/);
});
test('rides for later: held until released, current 15 min before pickup, needs attention 5 min before with no driver', () => {
  const held = { is_scheduled: true, status: 'searching_driver', driver_id: null, dispatch_released_at: null, pickup_time: at(3 * 60 * MIN) };
  assert.equal(scheduling.isHeld(held), true);
  assert.equal(scheduling.isCurrent(held), false);
  assert.equal(scheduling.scheduleState(held), 'scheduled');
  const dispatching = { ...held, dispatch_released_at: at(0), pickup_time: at(20 * MIN) };
  assert.equal(scheduling.isHeld(dispatching), false);
  assert.equal(scheduling.scheduleState(dispatching), 'dispatching');
  assert.equal(scheduling.isCurrent(dispatching), false);
  assert.equal(scheduling.isCurrent({ ...dispatching, pickup_time: at(14 * MIN) }), true);
  assert.equal(scheduling.scheduleState({ ...dispatching, pickup_time: at(4 * MIN) }), 'needs_attention');
  assert.equal(scheduling.needsAttention({ ...dispatching, pickup_time: at(4 * MIN), driver_id: 'd', status: 'driver_assigned' }), false);
  const accepted = { ...dispatching, driver_id: 'd', status: 'driver_assigned', pickup_time: at(25 * MIN) };
  assert.equal(scheduling.keepsDriverBusy(accepted), false);
  assert.equal(scheduling.keepsDriverBusy({ ...accepted, pickup_time: at(10 * MIN) }), true);
  assert.equal(scheduling.keepsDriverBusy({ ...accepted, status: 'driver_arrived_at_pickup' }), true);
  assert.equal(scheduling.isCurrent({ status: 'driver_assigned' }), true); // rides for now are unaffected
  assert.equal(scheduling.scheduleState({ status: 'searching_driver' }), null);
});
test('scheduled rides are released 30 min before pickup into nearest-driver dispatch; later ones stay held', async () => {
  const { db, log } = fakeDb({
    rides: [
      { id: 'due', is_scheduled: true, dispatch_released_at: null, driver_id: null, status: 'searching_driver', pickup_coords: pickup, pickup_time: at(25 * MIN), dispatch_state: 'open' },
      { id: 'later', is_scheduled: true, dispatch_released_at: null, driver_id: null, status: 'searching_driver', pickup_coords: pickup, pickup_time: at(3 * 60 * MIN), dispatch_state: 'open' },
      { id: 'now', is_scheduled: false, driver_id: null, status: 'searching_driver', pickup_coords: pickup, pickup_time: at(0), dispatch_state: 'open' }
    ],
    driver_locations: [nearDriver('near', 51.5036, -0.1278)],
    profiles: [approved('near')],
    ride_offers: []
  });
  assert.equal(await loadDispatch(db).releaseDueScheduledRides(), 1);
  const releases = log.filter((e) => e.table === 'rides' && e.op === 'update');
  assert.equal(releases.length, 1);
  assert.equal(releases[0].payload.dispatch_state, 'targeted');
  assert.equal(releases[0].count, 1);
  const offer = log.find((e) => e.table === 'ride_offers' && e.op === 'insert');
  assert.equal(offer.payload.ride_id, 'due');
  assert.equal(offer.payload.driver_id, 'near');
});
test('a driver with an accepted ride for later still gets offers until it is near', async () => {
  const { db } = fakeDb({
    driver_locations: [nearDriver('free', 51.5036, -0.1278), nearDriver('soon', 51.5035, -0.1277)],
    profiles: [approved('free'), approved('soon')],
    rides: [
      { driver_id: 'free', status: 'driver_assigned', is_scheduled: true, pickup_time: at(3 * 60 * MIN) },
      { driver_id: 'soon', status: 'driver_assigned', is_scheduled: true, pickup_time: at(10 * MIN) }
    ]
  });
  assert.deepEqual((await loadDispatch(db).findNearbyDrivers(pickup)).map((d) => d.driverId), ['free']);
});
test('booking for later validates the time; held rides cannot be accepted; only held rides can be moved', async () => {
  const parentUser = { role: 'parent', id: 'parent', children: [{ id: 'own' }] };
  let res = response();
  await routes()['post /request']({ user: parentUser, body: { childId: 'own', pickup: 'A', dropoff: 'B', scheduled: true, pickupTime: slot(10 * MIN).toISOString() } }, res);
  assert.equal(res.code, 400); assert.match(res.body.message, /30 minutes/);
  res = response();
  await routes()['post /request']({ user: parentUser, body: { childId: 'own', pickup: 'A', dropoff: 'B', scheduled: true } }, res);
  assert.equal(res.code, 400);

  const heldRide = { id: 'r', parent_id: 'parent', status: 'searching_driver', is_scheduled: true, dispatch_released_at: null, driver_id: null, pickup_time: at(3 * 60 * MIN), dispatch_state: 'open' };
  const driver = { id: 'd', role: 'driver', isVerifiedDriver: true, driverApplicationStatus: 'approved' };
  res = response(); await routes({ fetchRideRowById: async () => heldRide })['put /:id/accept']({ user: driver, params: { id: 'r' } }, res);
  assert.equal(res.code, 409); assert.match(res.body.message, /booked for later/);

  res = response(); await routes({ fetchRideRowById: async () => heldRide })['put /:id/schedule']({ user: { id: 'someone', role: 'parent' }, params: { id: 'r' }, body: {} }, res);
  assert.equal(res.code, 404);
  res = response(); await routes({ fetchRideRowById: async () => ({ ...heldRide, dispatch_released_at: at(0) }) })['put /:id/schedule']({ user: { id: 'parent', role: 'parent' }, params: { id: 'r' }, body: { pickupTime: slot(2 * 60 * MIN).toISOString() } }, res);
  assert.equal(res.code, 409);
  res = response(); await routes({ fetchRideRowById: async () => heldRide })['put /:id/schedule']({ user: { id: 'parent', role: 'parent' }, params: { id: 'r' }, body: { pickupTime: slot(5 * MIN).toISOString() } }, res);
  assert.equal(res.code, 400);
});
test('the current ride skips rides booked for later until 15 minutes before pickup', async () => {
  const chain = { select() { return chain; }, or() { return chain; }, neq() { return chain; }, order() { return chain; }, limit() { return chain; } };
  const later = { id: 'later', parent_id: 'p', status: 'searching_driver', is_scheduled: true, pickup_time: at(2 * 60 * MIN) };
  const soon = { id: 'soon', parent_id: 'p', status: 'driver_assigned', driver_id: 'd', is_scheduled: true, pickup_time: at(10 * MIN) };
  const run = async (rows) => { const res = response(); await routes({ fetchRideRows: async () => rows, formatRide: (r) => ({ id: r.id }) }, { from: () => chain })['get /active']({ user: { id: 'p', role: 'parent' } }, res); return res.body; };
  assert.equal(await run([later]), null);
  assert.equal((await run([later, soon])).id, 'soon');
});
test('nearby rides: waiting rides within 5 km of the driver, nearest first, never ones offered to someone else', async () => {
  const future = new Date(Date.now() + 10000).toISOString();
  const waiting = (id, lat, lng, extra = {}) => ({ id, status: 'searching_driver', driver_id: null, dispatch_state: 'open', pickup_location: id, pickup_coords: { lat, lng }, ...extra });
  const { db } = fakeDb({
    rides: [
      waiting('far', 51.5034, -0.0400), // about 6 km east
      waiting('near', 51.5040, -0.1280),
      waiting('mid', 51.5100, -0.1400),
      waiting('otherOffer', 51.5035, -0.1277, { dispatch_state: 'targeted' }),
      waiting('myOffer', 51.5200, -0.1276, { dispatch_state: 'targeted' }),
      waiting('noCoords', 0, 0, { pickup_coords: null }),
      waiting('heldForLater', 51.5036, -0.1277, { is_scheduled: true, dispatch_released_at: null }),
      { ...waiting('taken', 51.5034, -0.1276), status: 'driver_assigned', driver_id: 'x' }
    ],
    ride_declines: [{ driver_id: 'd1', ride_id: 'mid' }],
    ride_offers: [{ ride_id: 'otherOffer', driver_id: 'd2', status: 'pending', expires_at: future }, { ride_id: 'myOffer', driver_id: 'd1', status: 'pending', expires_at: future }],
    driver_locations: [{ driver_id: 'd1', lat: 51.5034, lng: -0.1276 }]
  });
  const handlers = {};
  load('routes/driverRoutes.js', {
    express: { Router: () => ({ get: (url, ...args) => { handlers[url] = args.at(-1); } }) },
    '../middleware/authMiddleware': { protect() {} },
    '../config/supabase': { supabaseAdmin: db },
    '../lib/ratings': { fetchRatingSummaries: async () => new Map() },
    '../lib/repository': { RIDE_SELECT: '*', fetchRideRows: async (query) => (await query).data, formatRide: (row) => ({ id: row.id, pickupLocation: row.pickup_location, tripCode: '1234', safeWord: 'secret' }) },
    '../lib/security': security,
    '../lib/dispatch': loadDispatch(db)
  });
  const driver = { id: 'd1', role: 'driver', isVerifiedDriver: true, driverApplicationStatus: 'approved' };
  let res = response(); await handlers['/nearby-rides']({ user: { ...driver, driverApplicationStatus: 'pending' }, query: {} }, res); assert.equal(res.code, 403);
  res = response(); await handlers['/nearby-rides']({ user: driver, query: { lat: '91', lng: '0' } }, res); assert.equal(res.code, 400);
  res = response(); await handlers['/nearby-rides']({ user: driver, query: { lat: '51.5034', lng: '-0.1276' } }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.rides.map((r) => r.id), ['near', 'mid', 'myOffer']);
  assert.equal(res.body.rides[1].declined, true);
  assert.equal(res.body.rides[2].offerExpiresAt, future);
  assert.ok(res.body.rides.every((r) => r.tripCode === undefined && r.safeWord === undefined && r.distanceMeters <= 5000));
  // Without coordinates in the request it uses the driver's last reported position.
  res = response(); await handlers['/nearby-rides']({ user: driver, query: {} }, res);
  assert.deepEqual({ ...res.body.origin }, { lat: 51.5034, lng: -0.1276 });
  assert.equal(res.body.rides.length, 3);
});
