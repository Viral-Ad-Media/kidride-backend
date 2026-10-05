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
  load('routes/rideRoutes.js', { express: { Router: () => router }, '../middleware/authMiddleware': { protect() {} }, '../middleware/rateLimitMiddleware': { createRateLimiter: () => () => {}, parsePositiveInt: (_, fallback) => fallback }, '../config/supabase': { supabaseAdmin: database }, '../lib/repository': repository, '../lib/security': security, '../lib/push': { notifyRide: async () => {} } });
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
  load('routes/authRoutes.js', {express:{Router:()=>({post:(url,...handlers)=>{if(url==='/register')register=handlers.at(-1);},get(){}})},jsonwebtoken:{},'../middleware/authMiddleware':{protect(){}},'../middleware/rateLimitMiddleware':{createRateLimiter:()=>()=>{},parsePositiveInt:(_,fallback)=>fallback},'../config/supabase':{},'../lib/repository':{}});
  const res=response();await register({body:{name:'Admin',email:'admin@example.test',password:'password',role:'admin'}},res);assert.equal(res.code,400);
});
test('assigned driver status writes compare the previous state and surface a stale-update conflict', async () => {
  let argumentsSeen;
  const handlers=routes({fetchRideRowById:async()=>({id:'ride',driver_id:'driver',status:'driver_assigned'}),updateRideRow:async(...args)=>{argumentsSeen=args;throw Object.assign(Error('changed'),{status:409});}});
  const res=response();await handlers['put /:id/status']({params:{id:'ride'},body:{status:'driver_arrived_at_pickup'},user:{id:'driver',role:'driver'}},res);
  assert.equal(res.code,409);assert.equal(argumentsSeen[2],'driver_assigned');assert.equal(argumentsSeen[3],'driver');
});
