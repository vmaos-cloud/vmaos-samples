import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const root = new URL('../', import.meta.url), demos = ['vanilla','react','vue','script'];
const server = createServer(async (req,res) => {
  try {
    const [,index,name] = req.url.split('/');
    if (!demos[index] || name !== 'volume.js') { res.setHeader('Content-Type','text/html'); res.end('<div id="volume"></div>'); return; }
    res.setHeader('Content-Type','text/javascript'); res.end(await readFile(new URL(`${demos[index]}/volume.js`,root)));
  } catch { res.statusCode=404; res.end(); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser=await chromium.launch({headless:true,executablePath:process.env.SAMPLES_BROWSER_PATH});
  for (const [index,demo] of demos.entries()) {
    const page=await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async index=>{
      const {mountRelativeVolume}=await import(`/${index}/volume.js`);
      const calls=[];let accepted=true;
      const host=document.querySelector('#volume');
      const volume=mountRelativeVolume(host,{up:()=>{calls.push(1);return accepted;},down:()=>{calls.push(-1);return accepted;}});
      const input=host.querySelector('input'),check=(ok,label)=>{if(!ok)throw new Error(label);};
      const pointer=type=>input.dispatchEvent(new PointerEvent(type,{pointerId:1,button:0,bubbles:true}));
      const change=value=>{input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));};
      const key=(type,key)=>input.dispatchEvent(new KeyboardEvent(type,{key,bubbles:true}));
      const wait=()=>new Promise(resolve=>setTimeout(resolve,420));
      check(input.disabled&&input.value==='0'&&input.min==='-5'&&input.max==='5'&&input.step==='1','Disabled neutral signed-step slider');
      volume.setEnabled(true);pointer('pointerdown');change(2);change(3);check(calls.length===0,'Dragging only previews');
      pointer('pointerup');pointer('pointerup');check(calls.length===1&&input.value==='0','Release commits once and immediately centres');
      await wait();check(calls.join(',')==='1,1,1','Exactly three increase steps');
      pointer('pointerdown');change(-5);pointer('pointerup');volume.setEnabled(false);await wait();
      check(calls.join(',')==='1,1,1,-1','Disconnect cancels remaining decrease steps');
      volume.setEnabled(true);await wait();check(calls.length===4,'Reconnect never replays');
      pointer('pointerdown');change(5);pointer('pointercancel');pointer('pointerup');
      pointer('pointerdown');change(-4);pointer('lostpointercapture');pointer('pointerup');
      key('keydown','End');change(5);key('keydown','Escape');key('keyup','End');
      key('keydown','ArrowRight');change(2);input.dispatchEvent(new Event('blur'));key('keyup','ArrowRight');
      pointer('pointerdown');change(0);pointer('pointerup');await wait();check(calls.length===4,'Cancelled, blurred and zero gestures do not send');
      key('keydown','ArrowLeft');change(-2);key('keydown','ArrowLeft');check(calls.length===4,'Keyboard repeat previews');
      key('keyup','ArrowLeft');key('keyup','ArrowLeft');await wait();check(calls.join(',')==='1,1,1,-1,-1,-1','Keyboard release submits final delta only once');
      accepted=false;pointer('pointerdown');change(5);pointer('pointerup');await wait();check(calls.length===7&&!input.disabled,'Rejected send stops immediately');
      accepted=true;pointer('pointerdown');change(5);pointer('pointerup');volume.destroy();await wait();
      check(calls.length===8&&host.childElementCount===0,'Destroy cancels remaining input and releases DOM');
    },index);
    assert.equal(await page.locator('#volume').textContent(),'');await page.close();
    console.log(`${demo}: relative steps, release, cancel, keyboard, rejection, disconnect and destroy verified`);
  }
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
