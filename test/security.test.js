const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const security = require('../lib/security');
const { createRateLimiter, getClientIdentifier } = require('../middleware/rateLimitMiddleware');
const originalPrices = process.env.SERVICE_PRICES_JSON;
afterEach(() => { if (originalPrices === undefined) delete process.env.SERVICE_PRICES_JSON; else process.env.SERVICE_PRICES_JSON = originalPrices; });
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
  load('routes/rideRoutes.js', { express: { Router: () => router }, '../middleware/authMiddleware': { protect() {} }, '../middleware/rateLimitMiddleware': { createRateLimiter: () => () => {}, parsePositiveInt: (_, fallback) => fallback }, '../config/supabase': { supabaseAdmin: database }, '../lib/repository': repository, '../lib/security': security, '../lib/push': { notifyRide: async () => {} }, '../lib/ratings': { MAX_COMMENT_LENGTH: 500 } });
  return handlers;
}
test('approval requires role, verification and approved status together', () => {
  const good={role:'driver',isVerifiedDriver:true,driverApplicationStatus:'approved'};
  assert.equal(security.isApprovedDriver(good),true);
  for (const mutation of [{role:'parent'},{isVerifiedDriver:false},{driverApplicationStatus:'pending'},{driverApplicationStatus:'rejected'}]) assert.equal(security.isApprovedDriver({...good,...mutation}),false);
});
test('fares fail closed for absent, malformed, negative or fractional-cent configuration', () => {
  for (const raw of ['{}','invalid','{"pickup_only":-1}','{"pickup_only":1.001}','{"pickup_only":"25"}']) { process.env.SERVICE_PRICES_JSON=raw; assert.throws(() => security.quoteFare('pickup_only'),error => error.status===503); }
  process.env.SERVICE_PRICES_JSON='{"pickup_only":25.5}'; assert.equal(security.quoteFare('pickup_only'),25.5);
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
test('booking rejects a stale or missing quote rather than accepting client price', async () => {
  process.env.SERVICE_PRICES_JSON='{"pickup_only":25}';for(const quotedPrice of [undefined,1,'25']) { const res=response();await routes()['post /request']({user:{role:'parent',id:'parent',children:[{id:'own'}]},body:{childId:'own',pickup:'A',dropoff:'B',price:1,quotedPrice}},res);assert.equal(res.code,409); }
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
  load('routes/userRoutes.js', { express: { Router: () => router }, '../middleware/authMiddleware': { protect() {} }, '../lib/repository': {}, '../config/supabase': { supabaseAdmin }, '../middleware/rateLimitMiddleware': { createRateLimiter: () => () => {}, parsePositiveInt: (_, f) => f }, '../lib/verification': { REQUIRED_DOCUMENTS: [], MIME_TYPES: new Set() } });
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
  load('routes/userRoutes.js', { express: { Router: () => router }, '../middleware/authMiddleware': { protect() {} }, '../lib/repository': { fetchChildrenRowsByParentId: async () => [], formatChild: c => c }, '../config/supabase': { supabaseAdmin: db }, '../middleware/rateLimitMiddleware': { createRateLimiter: () => () => {}, parsePositiveInt: (_, f) => f }, '../lib/verification': { REQUIRED_DOCUMENTS: [], MIME_TYPES: new Set() } });
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
