const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const root=path.resolve(__dirname,'..');
const baseURL=process.env.TEST_BASE_URL || 'http://127.0.0.1:8003/';
const screenshots=fs.mkdtempSync(path.join(os.tmpdir(),'english-focus-'));
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    page.setDefaultTimeout(6000);
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`);});
    await page.addInitScript(()=>{
      const NativeAudio=window.Audio;
      window.Audio=function(...args){const a=new NativeAudio(...args);window.__audio=a;return a;};
    });
    await page.goto(baseURL,{waitUntil:'networkidle'});
    await page.selectOption('#speed','1');
    const examples=await page.evaluate(()=>window.COURSE.lists[1].examples);
    const allTimings=await page.evaluate(()=>window.SENTENCE_TIMINGS);
    for(const item of examples){
      const t=allTimings[item.audio];
      assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root,item.audio))).digest('hex'),t.sha256);
      assert.deepEqual(t.words.map(w=>w.text),item.text.match(/[A-Za-z]+(?:[’'-][A-Za-z]+)*|\d+(?:,\d{3})*/g));
      t.words.forEach((w,i)=>{assert.ok(w.start>=0&&w.end>w.start);if(i)assert.ok(w.start>=t.words[i-1].end);});
    }
    const opened=()=>page.waitForFunction(()=>document.querySelector('#sentence-focus').open&&window.__audio.currentTime>0&&!window.__audio.paused);
    const pause=async()=>{await page.locator('#focus-toggle').click();await page.waitForFunction(()=>window.__audio.paused);};
    const seek=async(time)=>{await page.evaluate(t=>window.__audio.currentTime=t,time);await page.waitForFunction(t=>!window.__audio.seeking&&Math.abs(window.__audio.currentTime-t)<.06,time);};
    const colors=()=>page.locator('.focus-word').evaluateAll(ws=>ws.map(w=>parseFloat(w.style.getPropertyValue('--word-progress'))));
    await page.locator('.sentence-play').first().click();await opened();
    assert.equal(await page.locator('#sentence-focus').evaluate(n=>n.matches(':modal')),true);
    assert.equal(await page.locator('#focus-sentence').textContent(),examples[0].text);
    assert.equal(await page.locator('#player').isVisible(),false);
    assert.match(await page.locator('#sentence-focus').evaluate(n=>getComputedStyle(n,'::backdrop').backdropFilter),/blur/);
    assert.equal(await page.locator('#focus-toggle').getAttribute('aria-label'),'暂停朗读');
    await pause();await seek(2);
    const before=await colors();
    assert.equal(before[0],100);assert.equal(before.at(-1),0);assert.ok(before[3]>30&&before[3]<50);
    await page.waitForTimeout(350);assert.deepEqual(await colors(),before);
    assert.equal(await page.locator('#focus-toggle').getAttribute('aria-label'),'继续朗读');
    await page.locator('#focus-forward').click();
    assert.ok(Math.abs(await page.evaluate(()=>window.__audio.currentTime)-7)<.06);
    assert.ok((await colors()).filter(x=>x===100).length>before.filter(x=>x===100).length);
    await page.locator('#focus-rewind').click();
    assert.ok(Math.abs(await page.evaluate(()=>window.__audio.currentTime)-2)<.06);
    await page.locator('#focus-rewind').click();assert.equal(await page.evaluate(()=>window.__audio.currentTime),0);
    await page.locator('#focus-rewind').click();assert.equal(await page.evaluate(()=>window.__audio.currentTime),0);
    await page.locator('#focus-toggle').click();await opened();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#sentence-focus').evaluate(n=>n.open),false);
    assert.equal(await page.evaluate(()=>window.__audio.paused),true);
    assert.equal(await page.locator('.sentence-play').first().evaluate(n=>n===document.activeElement),true);
    await page.locator('.sentence-play').last().click();await opened();
    await page.evaluate(()=>window.__audio.currentTime=window.__audio.duration-.12);
    await page.waitForFunction(()=>!document.querySelector('#sentence-focus').open);
    assert.equal(await page.locator('body').evaluate(n=>n.classList.contains('sentence-focus-open')),false);
    console.log('Single sentence: native modal, progress gradient, pause, +/-5s, bounds, resume, natural completion and Escape passed.');
    await page.locator('#play-examples').click();
    for(let i=0;i<examples.length;i++){
      await opened();
      assert.equal(await page.locator('#focus-count').textContent(),`${String(i+1).padStart(2,'0')} / 15`);
      assert.equal(await page.locator('#focus-sentence').textContent(),examples[i].text);
      const timeline=allTimings[examples[i].audio].words;
      assert.equal(await page.locator('.focus-word').count(),timeline.length);
      await pause();
      const wi=Math.floor(timeline.length/2),word=timeline[wi];
      await seek((word.start+word.end)/2);
      const progress=await colors();
      assert.ok(Math.abs(progress[wi]-50)<1.5,`${i}: ${progress[wi]}`);
      assert.equal(progress[0],100);assert.equal(progress.at(-1),0);
      if(i===3){
        await page.screenshot({path:path.join(screenshots,'desktop.png')});
        for(const [width,height] of [[390,844],[320,568],[844,390]]){
          await page.setViewportSize({width,height});
          await seek(timeline.at(-1).start+.05);
          for(const id of ['focus-toggle','focus-forward','focus-rewind','focus-close']){
            const b=await page.locator('#'+id).boundingBox();
            assert.ok(b.x>=0&&b.y>=0&&b.x+b.width<=width&&b.y+b.height<=height,`${id} ${JSON.stringify(b)}`);
          }
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
          await page.screenshot({path:path.join(screenshots,`${width}x${height}.png`)});
          const pane=await page.locator('#focus-sentence').evaluate(n=>({top:n.scrollTop,scroll:n.scrollHeight,height:n.clientHeight}));if(pane.scroll>pane.height)assert.ok(pane.top>0,JSON.stringify(pane));
        }
        await page.setViewportSize({width:1280,height:900});
      }
      await seek(await page.evaluate(()=>window.__audio.duration-.12));
      await page.locator('#focus-toggle').click();
      if(i<examples.length-1)await page.waitForFunction(n=>document.querySelector('#focus-count').textContent===`${String(n+2).padStart(2,'0')} / 15`,i);
      else await page.waitForFunction(()=>!document.querySelector('#sentence-focus').open);
    }
    console.log('All15 sequential sentences used aligned coloring and natural ended events to advance; long/short/landscape layouts passed.');
    // Fast stop/reopen should survive the previous dialog close event.
    await page.locator('.sentence-play').first().click();await opened();
    await page.evaluate(()=>{document.querySelector('#focus-close').click();document.querySelectorAll('.sentence-play')[1].click();});
    await opened();assert.equal(await page.locator('#focus-sentence').textContent(),examples[1].text);
    await page.mouse.click(3,3);await page.waitForFunction(()=>!document.querySelector('#sentence-focus').open);
    // Existing half speed and word-card playback retain their compact player.
    await page.selectOption('#speed','0.5');await page.reload({waitUntil:'networkidle'});
    assert.equal(await page.locator('#speed').inputValue(),'0.5');
    await page.locator('.sentence-play').first().click();await opened();
    assert.equal(await page.evaluate(()=>window.__audio.playbackRate),.5);
    await page.locator('#focus-close').click();
    await page.locator('.word-token').first().click();
    await page.locator('#word-detail-play').click();
    await page.waitForFunction(()=>window.__audio.currentTime>0&&!window.__audio.paused);
    assert.equal(await page.locator('#sentence-focus').evaluate(n=>n.open),false);
    assert.equal(await page.locator('#player').isVisible(),true);
    await page.keyboard.press('Escape');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({sentencesAligned:15,wordTimingTokens:Object.values(allTimings).reduce((n,e)=>n+e.words.length,0),pauseSeekResume:'passed',allSequentialTransitions:'passed',naturalCompletion:'passed',wordCardRegression:'passed',halfSpeed:'passed',mobile:'passed',browserErrors:errors}));
    console.log('Screenshots: '+screenshots);
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
