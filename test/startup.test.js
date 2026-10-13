const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const serverPath = path.resolve(__dirname, '../server.js');

// Each scenario gets a cold-start process and HTTP requests through the real app.
const run = (overrides) => new Promise((resolve, reject) => {
  const env = { ...process.env, VERCEL: '1', NODE_ENV: 'production', DOTENV_CONFIG_PATH: '/nonexistent/kidride-test.env' };
  for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET']) delete env[key];
  Object.assign(env, overrides);
  const source = `
    const assert = require('node:assert/strict');
    let networkCalls = 0;
    global.fetch = async () => { networkCalls++; throw new Error('Unexpected outbound fetch'); };
    const http = require('node:http');
    const originalListen = http.Server.prototype.listen;
    let importListeners = 0;
    http.Server.prototype.listen = function(...args) { importListeners++; return originalListen.apply(this, args); };
    const app = require(${JSON.stringify(serverPath)});
    assert.equal(typeof app, 'function');
    assert.equal(importListeners, 0, 'import must not open a port');
    assert.equal(app.get('io'), undefined, 'Vercel must not attach Socket.IO');
    const server = http.createServer(app);
    function request(route, method = 'GET', body) { return new Promise((resolve, reject) => {
      const req = http.request({host:'127.0.0.1',port:server.address().port,path:route,method,headers:body?{'Content-Type':'application/json'}:{}},res => {
        let text='';res.on('data',chunk => text+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:text}));
      });req.on('error',reject);req.end(body);
    }); }
    server.listen(0,'127.0.0.1',async()=>{
      try {
        const results={};for(const route of ['/','/health','/api/health','/favicon.ico','/missing']) results[route]=await request(route);
        ${overrides.SUPABASE_URL === 'https://example.supabase.co' ? '' : "results['/api/auth/login']=await request('/api/auth/login','POST','{}');"}
        results.networkCalls=networkCalls;
        console.log('RESULT:'+JSON.stringify(results));
      } catch(error) { console.error(error); process.exitCode=1; }
      finally { server.close(); }
    });
  `;
  const isolatedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kidride-startup-'));
  const child = spawn(process.execPath, ['-e', source], { env, cwd: isolatedDirectory, stdio: ['ignore','pipe','pipe'] });
  let output='', logs='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>logs+=c);
  const timeout=setTimeout(()=>{child.kill();reject(Error('Cold-start test timed out'));},10000);
  child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);fs.rmSync(isolatedDirectory,{recursive:true,force:true});if(code!==0)return reject(Error(`Child exited ${code}: ${logs}`));try{resolve({results:JSON.parse(output.split('RESULT:')[1].trim()),logs});}catch(error){reject(error);}});
});

test('missing credentials return controlled 503 instead of killing the function', async () => {
  const {results,logs}=await run({});assert.equal(results['/'].status,503);assert.equal(results['/api/health'].status,503);assert.equal(results['/health'].status,200);assert.equal(results['/favicon.ico'].status,204);assert.equal(results['/api/auth/login'].status,503);assert.equal(results['/missing'].status,404);assert.equal(results.networkCalls,0);assert.match(logs,/Missing required environment variables: SUPABASE_URL/);assert.doesNotMatch(results['/'].body+results['/api/auth/login'].body,/SUPABASE_SERVICE_ROLE_KEY|JWT_SECRET|Error:/);
});
test('malformed Supabase URL does not crash startup or leak configuration', async () => {
  const {results,logs}=await run({SUPABASE_URL:'not-a-url',SUPABASE_ANON_KEY:'test-anon',SUPABASE_SERVICE_ROLE_KEY:'test-secret',JWT_SECRET:'test-jwt'});assert.equal(results['/api/health'].status,503);assert.equal(results['/favicon.ico'].status,204);assert.match(logs,/SUPABASE_URL must be a valid HTTP/);assert.doesNotMatch(logs+results['/'].body,/test-secret|test-jwt/);assert.equal(results.networkCalls,0);
});
test('configured Vercel handler imports without a listener or external calls', async () => {
  const {results}=await run({SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'test-anon',SUPABASE_SERVICE_ROLE_KEY:'test-secret',JWT_SECRET:'test-jwt'});assert.equal(results['/'].status,200);assert.equal(results['/api/health'].status,200);assert.equal(JSON.parse(results['/api/health'].body).database,'not_checked');assert.equal(results['/favicon.ico'].status,204);assert.equal(results.networkCalls,0);
});
