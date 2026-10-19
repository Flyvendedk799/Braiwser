import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright-core';
const root = path.resolve(import.meta.dirname, '../../..');

test('standalone service, actual stdio MCP and authenticated human continue the original Chromium context once', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braiwser-standalone-'));
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><style>body { margin:0 } input { position:absolute;left:10px;top:10px;width:200px;height:30px } button{position:absolute;left:10px;top:70px;width:100px;height:30px}</style><label for="name">Name</label><input id="name"><button id="submit">Submit</button><p id="result" style="position:absolute;top:120px">waiting</p><main aria-label="Complete" hidden>Verified</main><div style="height:2000px"></div><script>window.identity=crypto.randomUUID();window.submits=0;document.querySelector('button').onclick=()=>{submits++;document.querySelector('main').hidden=false;localStorage.setItem('identity',identity);document.querySelector('button').textContent='Submitted '+submits+' '+document.querySelector('input').value}</script>`);
  });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ dataDir: path.join(dir, 'store'),
    principal: { id: 'fixture-agent', kind: 'mcp', scopes: ['class:observe','class:navigate','class:interact',`origin:${origin}`] } }));
  const child = spawn(process.execPath, [path.join(root, 'src/main/services/automation/server.mjs')], {
    env: { ...process.env, BRAIWSER_SERVER_CONFIG: configFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  let client, browser;
  t.after(async () => {
    await client?.close(); await browser?.close();
    child.kill(); await once(child, 'exit').catch(() => {});
    await new Promise(r => site.close(r)); fs.rmSync(dir, { recursive:true, force:true });
  });
  const readiness = await new Promise((resolve, reject) => {
    let text = '';
    child.once('exit', (code) => reject(new Error(`service exited ${code}`)));
    child.stdout.on('data', c => { text += c; if(text.includes('\n')) { try { resolve(JSON.parse(text.split('\n')[0])); } catch(e) {reject(e);} } });
  });
  assert.equal(readiness.handoffVersion, '2.1.0');
  const transport = () => new StdioClientTransport({ command: process.execPath,
    args: [path.join(root,'src/main/services/automation/sidecar.mjs')],
    env: { ...getDefaultEnvironment(), BRAIWSER_BRIDGE_INFO: readiness.bridgeFile }, stderr: 'pipe' });
  client = new Client({ name:'generic-independent-client',version:'1.0.0' }); await client.connect(transport());
  const call = async (name,args) => {
    const result = (await client.callTool({name,arguments:args})).structuredContent;
    assert.equal(result.ok,true,JSON.stringify(result)); return result.value;
  };
  const caps = JSON.parse((await client.readResource({uri:'braiwser://capabilities'})).contents[0].text);
  assert.equal(caps.handoffVersion, '2.1.0');
  const opened = await call('browser_session_open',{driver:'playwright',mode:'headless',grant:{allowedOrigins:[origin],toolClasses:['observe','navigate','interact']}});
  const ids = {sessionId:opened.sessionId,pageId:opened.pageId};
  const observation = await call('browser_observe',ids);
  await call('browser_act',{...ids,observationId:observation.observationId,documentEpoch:observation.documentEpoch,operationId:'navigate-fixture',action:{kind:'navigate',url:origin}});
  const before = await call('browser_observe',ids);
  const run = await call('browser_run', {...ids,requestKey:'original-run',skillId:'review-responsive',skillVersion:'1.0.0',inputs:{url:origin,landmarks:[{role:'main',name:'Complete'}],viewports:[{name:'fixture',width:1280,height:800}],capture:false}});
  const deadline = Date.now()+10000;
  while (true) { const status=await call('browser_run_status',{runId:run.runId}); if(status.events.some(e=>e.stepId==='fixture-landmark-1' && e.kind==='step_started'))break; if(Date.now()>deadline)throw new Error('run did not reach its blocked assertion'); await new Promise(r=>setTimeout(r,20)); }
  const handoff = await call('browser_handoff',{...ids,runId:run.runId,reason:'Complete the synthetic form',requestKey:'handoff-fixture'});
  assert.equal(JSON.stringify(handoff).includes('token'),false);
  const owner = JSON.parse(fs.readFileSync(readiness.ownerFile,'utf8'));
  browser = await chromium.launch({headless:true});
  const human = await browser.newPage();
  await human.goto(handoff.viewerUrl);
  await human.locator('#code').fill(owner.token); await human.locator('#redeem button').click();
  await human.locator('#take').waitFor({state:'visible'});
  await human.locator('#take').click();
  await human.waitForFunction(()=>document.querySelector('#identity').textContent.includes('human'));
  // Drive the same authenticated API as the UI; screenshots bind each event to fresh geometry.
  const result = await human.evaluate(async ({handoffId}) => {
    const csrf = decodeURIComponent(document.cookie.match(/braiwser_csrf=([^;]+)/)[1]);
    const api=async(action,body)=>{
      const res=await fetch(`/v1/handoffs/${handoffId}${action?'/'+action:''}`,{method:body?'POST':'GET',headers:body?{'content-type':'application/json','x-braiwser-csrf':csrf}:{},body:body?JSON.stringify(body):undefined});
      const r=await res.json(); if(!r.ok) throw new Error(JSON.stringify(r));return r.value;
    };
    const write=async(action,data={})=>{const state=await api('');return api(action,{...data,viewerInstanceId:window.braiwserViewerInstance,expectedControlEpoch:state.controlEpoch,requestKey:crypto.randomUUID()});};
    const input=async(data)=>{const f=await api('frame');if(!f.fresh)throw new Error('no frame');return write('input',{...data,frameSequence:f.sequence,documentEpoch:f.documentEpoch});};
    await input({kind:'click',x:50,y:25});
    await input({kind:'text',text:'Human fixture'});
    await input({kind:'key',key:'End'});
    await input({kind:'click',x:50,y:85});
    const released=await write('release');
    if(released.controlOwner!=='paused')throw new Error('release resumed');
    return write('resume');
  },{handoffId:handoff.handoffId});
  assert.equal(result.resumed,true);
  let finished; const finishDeadline=Date.now()+15000;
  do { finished=await call('browser_run_status',{runId:run.runId}); if(!['queued','running','needsHuman'].includes(finished.state))break; await new Promise(r=>setTimeout(r,30)); }while(Date.now()<finishDeadline);
  assert.equal(finished.state,'passed',JSON.stringify(finished)); assert.equal(finished.runId,run.runId);
  const after = await call('browser_observe',ids);
  const stored = await client.readResource({uri:after.evidenceUri});
  assert.equal(JSON.parse(stored.contents[0].text).sessionId,ids.sessionId);
  assert.equal(after.sessionId,before.sessionId); assert.equal(after.pageId,before.pageId);
  assert.ok(JSON.stringify(after.nodes).includes('Submitted 1 Human fixture'),JSON.stringify(after.nodes));
  // Reconnect the MCP client: it must attach to the retained owner, not create a new browser.
  await client.close(); client=new Client({name:'second-generic-client',version:'1.0.0'}); await client.connect(transport());
  assert.ok(JSON.stringify(await call('browser_observe',ids)).includes('Submitted 1 Human fixture'));
  await call('browser_session_close',{sessionId:ids.sessionId});
});
