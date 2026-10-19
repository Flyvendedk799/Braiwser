import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

test('actual viewer typing survives frame refresh after navigation and expired authentication offers sign-in', {timeout:30000}, async t => {
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();let authenticated=true,delayFrame=false;const inputs=[];
  await page.route('http://127.0.0.1:49123/**',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.pathname==='/viewer.js')return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(new URL('../../../src/viewer/viewer.js',import.meta.url),'utf8')});
    if(url.pathname==='/handoff/ui')return route.fulfill({contentType:'text/html',body:fs.readFileSync(new URL('../../../src/viewer/index.html',import.meta.url),'utf8')});
    if(!authenticated)return route.fulfill({status:401,json:{ok:false,error:{message:'Sign in required'}}});
    let value={state:'human',controlOwner:'human',controlEpoch:2,documentEpoch:1};
    if(url.pathname.endsWith('/frame')) {
      if(delayFrame){delayFrame=false;await new Promise(r=>setTimeout(r,150));}
      value={fresh:true,sequence:inputs.length+1,documentEpoch:2,controlEpoch:2,width:100,height:100,image:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='};
    }
    if(url.pathname.endsWith('/input')){inputs.push(request.postDataJSON());delayFrame=true;}
    return route.fulfill({json:{ok:true,value}});
  });
  await page.goto('http://127.0.0.1:49123/handoff/ui');
  await page.waitForFunction(()=>document.querySelector('#fresh').textContent==='Live view');
  await page.locator('#stage').pressSequentially('abc',{delay:20});
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='human');
  const deadline=Date.now()+5000;while(inputs.length<3&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
  assert.equal(inputs.map(x=>x.text).join(''),'abc');
  assert.ok(inputs.every(x=>x.documentEpoch===2));
  authenticated=false;
  await page.locator('#redeem').waitFor({state:'visible'});
  assert.equal(await page.locator('#controls').isVisible(),false);
});
