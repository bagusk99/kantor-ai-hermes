const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:4173');await page.waitForFunction(()=>window.officeScene);
 await page.click('#bRoutine');await page.click('#bPause');
 await page.locator('[data-floor="0"]').click();await page.waitForFunction(()=>!officeScene.snapshot().transitioning);
 await page.selectOption('#teamSelect','Kak Rani');
 const snap=()=>page.evaluate(()=>officeScene.snapshot());const camera=(await snap()).camera;
 await page.locator('[data-command="lunch"]').click();
 let s=await snap();assert.deepEqual(s.team.filter(a=>a.destination===2).map(a=>a.initials),['KR']);assert.deepEqual(s.camera,camera);
 await page.selectOption('#iScope','division');await page.locator('[data-command="roof"]').click();
 s=await snap();assert.equal(s.team.filter(a=>a.destination===4).length,4);assert.ok(s.team.filter(a=>a.destination===4).every(a=>a.group==='marketing'));
 await page.locator('[data-command="work"]').click();
 await page.selectOption('#iScope','custom');
 await page.locator('#iPeople input[value="Tari"]').check();await page.locator('[data-command="meet"]').click();
 s=await snap();assert.deepEqual(s.team.filter(a=>a.activity==='meet').map(a=>a.initials),['KR','T']);
 await page.locator('#iPeople input').evaluateAll(inputs=>inputs.forEach(i=>i.checked=true));
 await page.locator('[data-command="meet"]').click();assert.match(await page.locator('#sceneStatus').innerText(),/Only 6 places/);
 assert.equal((await snap()).team.filter(a=>a.activity==='meet').length,2);
 await page.locator('#iPeople input').evaluateAll(inputs=>inputs.forEach(i=>i.checked=false));
 await page.locator('[data-command="work"]').click();assert.match(await page.locator('#sceneStatus').innerText(),/at least one/);
 await page.click('#iTasks');await page.fill('#taskTitle','Review content <draft>');await page.fill('#taskBrief','Check captions with Tari');await page.click('#taskForm button[type=submit]');
 await page.getByRole('button',{name:'Start task',exact:true}).click();await page.keyboard.press('Escape');
 await page.waitForFunction(()=>document.querySelector('#iActiveTask').textContent==='Review content <draft>');
 assert.match(await page.locator('#iTaskBrief').innerText(),/Check captions/);
 assert.equal(await page.locator('.name-label.has-task').count(),1);
 await page.selectOption('#iScope','person');await page.locator('[data-command="lunch"]').click();assert.equal(await page.locator('#iActiveTask').innerText(),'Review content <draft>');
 await page.locator('[data-command="work"]').click();await page.click('#bPause');
 await page.waitForFunction(()=>officeScene.snapshot().team.find(a=>a.initials==='L').state==='meet',null,{timeout:120000});
 assert.deepEqual((await snap()).camera,camera);
 for(const width of [375,768,1440]){
 await page.setViewportSize({width,height:900});await page.selectOption('#iScope','custom');
 assert.equal(await page.evaluate(()=>document.querySelector('#info').scrollWidth>document.querySelector('#info').clientWidth),false);
 await page.screenshot({path:`/private/tmp/kantor-member-${width}.png`});
 }
 await page.click('#iTasks');await page.locator('.task-item textarea').fill('Reviewed');await page.getByRole('button',{name:'Save result & finish'}).click();await page.keyboard.press('Escape');
 await page.waitForFunction(()=>document.querySelector('#iActiveTask').textContent==='No active task');assert.equal(await page.locator('.name-label.has-task').count(),0);
 assert.deepEqual(errors,[]);console.log('PASS: individual/division/custom commands, capacity, empty selection, meeting arrival, camera, live task state and 375/768/1440 layouts');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
