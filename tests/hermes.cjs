// Hermes integration: profile CRUD, a kanban task, and webhook -> SSE relay. Needs `hermes dashboard` on 9119.
// Creates and deletes a throwaway profile `kantor-test` and archives the task it makes.
const assert=require('node:assert/strict');
const http=require('node:http');
const {spawn}=require('node:child_process');
const path=require('node:path');
const PORT=4191,B=`http://127.0.0.1:${PORT}`,NAME='kantor-test';
const api=(m,p,b)=>fetch(B+p,{method:m,headers:{'content-type':'application/json'},body:b&&JSON.stringify(b)}).then(async r=>({status:r.status,body:await r.json().catch(()=>null)}));
(async()=>{
 const child=spawn(process.execPath,[path.join(__dirname,'../server/server.js')],{env:{...process.env,PORT:String(PORT),ENV_FILE:'/nonexistent'},stdio:['ignore','pipe','inherit']});
 await new Promise((ok,fail)=>{child.stdout.on('data',d=>String(d).includes('Profiles initialized')&&ok());child.on('exit',c=>fail(new Error('server exited '+c)));});
 try{
  assert.equal((await api('POST','/api/profiles',{name:NAME,description:'d1',soul:'s1'})).status,200);
  assert.deepEqual((await api('GET',`/api/profiles/${NAME}`)).body,{description:'d1',soul:'s1'});
  assert.ok((await api('GET','/api/team')).body.some(p=>p.n===NAME));
  assert.equal((await api('PATCH',`/api/profiles/${NAME}`,{description:'d2',soul:'s2'})).status,200);
  assert.deepEqual((await api('GET',`/api/profiles/${NAME}`)).body,{description:'d2',soul:'s2'});
  // A name with shell syntax is rejected by Hermes, never run through a shell.
  assert.equal((await api('POST','/api/profiles',{name:'a$(id)'})).status,500);

  const task=(await api('POST','/api/tasks',{title:'kantor test task',brief:'x',assignee:NAME,workspace:'scratch'})).body;
  assert.equal(task.assignee,NAME);
  assert.ok((await api('GET','/api/tasks')).body.some(t=>t.id===task.id));
  assert.equal((await api('PATCH',`/api/tasks/${task.id}`,{action:'archive'})).body.archived,true);

  // Webhook events reach SSE listeners.
  const event=await new Promise((ok,fail)=>{
   const req=http.get(`${B}/api/events`,res=>{
    res.setEncoding('utf8');let buf='';
    res.on('data',d=>{buf+=d;const m=buf.match(/^data: (.+)$/m);if(m){req.destroy();ok(JSON.parse(m[1]));}});
    api('POST','/api/webhook/hermes',{hook_event_name:'kanban_task_completed',profile:NAME,extra:{task_id:task.id,assignee:NAME,summary:'ok'}});
   });req.on('error',fail);
  });
  assert.deepEqual(event,{event:'kanban_task_completed',profile:NAME,taskId:task.id,note:'ok'});
  assert.equal((await api('POST','/api/webhook/hermes',{})).status,400);
  console.log('hermes.cjs: ok');
 }finally{
  await api('DELETE',`/api/profiles/${NAME}`).catch(()=>{});
  child.kill();
 }
})().catch(e=>{console.error(e);process.exit(1);});
