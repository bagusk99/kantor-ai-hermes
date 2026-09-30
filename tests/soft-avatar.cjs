const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:4173');await page.waitForFunction(()=>window.officeScene);
 await page.click('#bRoutine');
 for(const name of ['Mira','Rizky Hakim']){
 await page.selectOption('#teamSelect',name);
 await page.screenshot({path:`/private/tmp/soft-${name.split(' ')[0]}.png`});
 }
 await page.click('#iEyes');await page.waitForTimeout(400);assert.equal(await page.evaluate(()=>officeScene.snapshot().follow.mode),'eyes');
 await page.click('#fChase');await page.waitForTimeout(400);assert.equal(await page.evaluate(()=>officeScene.snapshot().follow.mode),'chase');
 await page.keyboard.press('Escape');await page.locator('[data-floor="0"]').click();await page.waitForFunction(()=>!officeScene.snapshot().transitioning);
 await page.click('#bLunch');await page.waitForFunction(()=>officeScene.snapshot().team.some(a=>a.state==='stairs'),null,{timeout:90000});
 await page.click('#bPause');const positions=await page.evaluate(()=>officeScene.snapshot().team.map(a=>a.position));await page.waitForTimeout(500);assert.deepEqual(await page.evaluate(()=>officeScene.snapshot().team.map(a=>a.position)),positions);
 await page.click('#bPause');await page.waitForFunction(()=>officeScene.snapshot().team.every(a=>a.floor===2&&a.state==='break'),null,{timeout:150000});
 await page.locator('[data-floor="2"]').click();await page.waitForFunction(()=>!officeScene.snapshot().transitioning);await page.screenshot({path:'/private/tmp/soft-lunch.png'});
 assert.deepEqual(errors,[]);console.log('PASS: soft-avatar rendering, eyes/chase camera, stairs, pause and all 13 seated at lunch');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
