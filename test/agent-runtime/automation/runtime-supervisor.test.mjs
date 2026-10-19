import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

test('two cold-start MCP clients attach to one retained owner', {timeout:30000}, async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'braiwser-supervisor-'));
  const clients=[new Client({name:'first',version:'1'}),new Client({name:'second',version:'1'})];
  let pid;
  t.after(async()=>{await Promise.allSettled(clients.map(client=>client.close()));if(pid){try{process.kill(pid,'SIGTERM');}catch{}}fs.rmSync(dir,{recursive:true,force:true});});
  const config={dataDir:dir,principal:{id:'concurrent-runtime',kind:'mcp',scopes:['class:observe']}};
  const transport=()=>new StdioClientTransport({command:process.execPath,args:[path.resolve(import.meta.dirname,'../../../src/main/services/automation/runtime-sidecar.mjs')],env:{...getDefaultEnvironment(),BRAIWSER_RUNTIME_CONFIG:JSON.stringify(config)},stderr:'pipe'});
  await Promise.all(clients.map(client=>client.connect(transport())));
  pid=JSON.parse(fs.readFileSync(path.join(dir,'agent-bridge.json'),'utf8')).pid;
  assert.ok(Number.isInteger(pid));
  for(const client of clients)assert.equal(JSON.parse((await client.readResource({uri:'braiwser://capabilities'})).contents[0].text).handoffVersion,'2.1.0');
  await Promise.all(clients.map(client=>client.close()));
  assert.doesNotThrow(()=>process.kill(pid,0),'MCP disconnect retains the owner');
});
