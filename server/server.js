// Kantor AI server: serves public/ and a small task API. Tasks assigned to a connected
// team member (server/agents.js) are worked by Claude, or by a labelled dry run when no API key is set.
// No login yet, so it only listens on this machine.

const cp = require('node:child_process');
function execHermes(args) {
  return new Promise((resolve, reject) => {
    cp.execFile('hermes', args, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { resolve({}); }
    });
  });
}
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

let dashboardToken = null;
async function getHermesToken() {
  if (dashboardToken) return dashboardToken;
  try {
    const res = await fetch('http://127.0.0.1:9119/');
    if (!res.ok) throw new Error('Cannot reach dashboard');
    const text = await res.text();
    const match = text.match(/window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/);
    if (match) {
      dashboardToken = match[1];
      return dashboardToken;
    }
    throw new Error('Token not found in HTML');
  } catch (err) {
    return null;
  }
}

async function apiFetch(method, path, body = null) {
  let token = await getHermesToken();
  if (!token) throw new Error('No Hermes session token');
  
  const doFetch = async (t) => {
    const headers = { 'Authorization': `Bearer ${t}` };
    const opts = { method, headers };
    if (body) {
      headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(`http://127.0.0.1:9119${path}`, opts);
  };
  
  let res = await doFetch(token);
  if (res.status === 401) {
    dashboardToken = null;
    token = await getHermesToken();
    if (token) res = await doFetch(token);
  }
  
  if (!res.ok) {
    let errText = '';
    try { errText = await res.text(); } catch(e){}
    throw new Error(`Hermes API Error ${res.status}: ${errText}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

try { process.loadEnvFile(process.env.ENV_FILE || path.join(ROOT, '.env')); } catch { /* no .env file: dry run */ }

const agents = require('./agents');
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const HOST = '127.0.0.1', PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const API_URL = `${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`;
const DRY_RUN = !API_KEY || process.env.ANTHROPIC_DRY_RUN === '1';
const STATES = new Set(['queued', 'active', 'blocked', 'review', 'done']);
// Which model a member uses: their own, else the .env default.
const modelOf = agent => agent.model || MODEL;

// ---- storage: one JSON file, written atomically ----
fs.mkdirSync(DATA_DIR, {recursive: true});
let tasks = [];
try { tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); if (!Array.isArray(tasks)) throw new Error('not a list'); }
catch (error) { if (error.code !== 'ENOENT') { console.error(`Cannot read ${TASKS_FILE}: ${error.message}. Fix or move the file, then restart.`); process.exit(1); } }
let durable = JSON.stringify(tasks);
function save() {
  try {
  const tmp = `${TASKS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2));
  fs.renameSync(tmp, TASKS_FILE);
  durable=JSON.stringify(tasks);
  } catch(error) { tasks=JSON.parse(durable); throw error; }
}
const now = () => new Date().toISOString();

let teamOverrides = {};
try { teamOverrides = JSON.parse(fs.readFileSync('data/team-overrides.json', 'utf8')); } catch(e) {}

let TEAM_PROFILES = [];
const MEMBERS = new Set();
async function rebuildTeam() {
  TEAM_PROFILES = [];
  try {
    const data = await apiFetch('GET', '/api/profiles');
    if (!data || !data.profiles) return;
    let c = 0;
    for (const p of data.profiles) {
      if (p.name !== 'default') {
        c++;
        TEAM_PROFILES.push({
          n: p.name,
          initials: p.name,
          gender: c % 2 === 0 ? 'female' : 'male',
          role: 'AI Agent',
          group: teamOverrides[p.name]?.group || (p.name === 'techlead' ? 'leadership' : 'engineering')
        });
      }
    }
  } catch(e) {
    console.error('Failed to load profiles:', e.message);
  }
  MEMBERS.clear();
  TEAM_PROFILES.forEach(p => MEMBERS.add(p.n));
}
// Note: initial call is deferred to server start.

const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

// ---- agent worker: one task at a time per connected member, oldest first ----
const busy = new Set();
async function askClaude(agent, task) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(API_URL, {
      method: 'POST', signal: controller.signal,
      headers: {'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01'},
      body: JSON.stringify({model: modelOf(agent), max_tokens: 2000, system: agent.system,
        messages: [{role: 'user', content: `Task: ${task.title}\n\nBrief:\n${task.brief || '(no brief given)'}${task.feedback ? `\n\nPrevious draft:\n${task.result}\n\nRevision requested:\n${task.feedback}` : ''}`}]})
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || `Claude API returned ${response.status}`);
    const answer = (body.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
    if (!answer) throw new Error('Claude returned an empty answer');
    return answer;
  } finally { clearTimeout(timer); }
}
async function dryRun(agent, task) {
  await new Promise(resolve => setTimeout(resolve, Number(process.env.DRY_RUN_DELAY_MS ?? 4000)));
  // Dry runs ask back when the brief is nearly empty, so the "Needs decision" flow can be tried without a key.
  if ((task.brief || '').trim().length < 12) return 'QUESTIONS:\n1. DRY RUN: who is this for, and what should it say?\n2. DRY RUN: any facts, links or deadlines to include?';
  return `DRY RUN: no ANTHROPIC_API_KEY is set, so this is placeholder text, not AI output.\n\n${agent.role} would draft: "${task.title}".\nBrief received: ${task.brief || '(none)'}${task.feedback ? `\nRevision requested: ${task.feedback}` : ''}`;
}
async function work(name) {
  if (busy.has(name)) return;
  const task = tasks.filter(t => t.assignee === name && t.status === 'queued' && !t.error).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!task || tasks.some(t => t.assignee === name && t.status === 'active')) return;
  busy.add(name);
  const runId=crypto.randomUUID();
  try {
    Object.assign(task, {status: 'active', runId, version:(task.version||0)+1, updatedAt: now()}); save();
    const input=structuredClone(task);
    const answer = DRY_RUN ? await dryRun(agents[name], input) : await askClaude(agents[name], input);
    const current = tasks.find(t => t.id === task.id);
    // The task may have been moved back to the queue or reassigned while the agent worked.
    if (current && current.status === 'active' && current.assignee === name && current.runId === runId) {
      const by=DRY_RUN?'dry-run':modelOf(agents[name]),asked=answer.match(/^QUESTIONS:\s*([\s\S]+)/);
      // The agent asked instead of guessing: park the task until someone answers.
      if(asked){Object.assign(current,{status:'blocked',questions:asked[1].trim().slice(0,2000),askedBy:by,runId:null,version:(current.version||0)+1,updatedAt:now()});save();return;}
      const draft={result:answer.slice(0,10000),by,createdAt:now(),feedback:input.feedback||''};
      Object.assign(current, {status:'review',result:draft.result,by:draft.by,history:[...(current.history||[]),draft],runId:null,version:(current.version||0)+1,updatedAt:now()});save();
    }
  } catch (error) {
    const current = tasks.find(t => t.id === task.id);
    if (current && current.status === 'active' && current.assignee === name && current.runId === runId) { Object.assign(current, {status: 'queued', runId:null, version:(current.version||0)+1, error: error.name === 'AbortError' ? 'Claude took too long to answer.' : error.message === 'fetch failed' ? 'Could not reach the Claude API. Check the internet connection.' : error.message, updatedAt: now()}); save(); }
    console.error(`Agent ${name} failed on "${task.title}": ${error.message}`);
  } finally { busy.delete(name); setImmediate(() => work(name)); }
}
const kick = () => Object.keys(agents).forEach(work);

// ---- HTTP ----
function send(res, status, body) {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
  res.end(JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > 1e6) { reject(Object.assign(new Error('Request too large'), {status: 413})); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(Object.assign(new Error('Invalid JSON'), {status: 400})); } });
  });
}
function newTask(input) {
  if(!input||typeof input!=='object')return null;
  const title = text(input.title, 160), assignee = text(input.assignee, 80);
  if (!title || !assignee) return null;
  const status = STATES.has(input.status) ? input.status : 'queued', result = text(input.result, 10000);
  return {id: crypto.randomUUID(), title, assignee, brief: text(input.brief, 100000), status: ['done','review'].includes(status) && !result ? 'queued' : status, result, createdAt: now()};
}
async function api(req, res, url) {
    if (url.pathname === '/api/boards' && req.method === 'GET') {
    try {
      const data = await apiFetch('GET', '/api/plugins/kanban/boards');
      return send(res, 200, data.boards || []);
    } catch (e) {
      return send(res, 200, []);
    }
  }
  if (url.pathname === '/api/boards' && req.method === 'POST') {
    try {
      const payload = await readJson(req);
      const data = await apiFetch('POST', '/api/plugins/kanban/boards', payload);
      return send(res, 200, data);
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }
  const switchMatch = url.pathname.match(/^\/api\/boards\/([^/]+)\/switch$/);
  if (switchMatch && req.method === 'POST') {
    try {
      const slug = decodeURIComponent(switchMatch[1]);
      const data = await apiFetch('POST', `/api/plugins/kanban/boards/${encodeURIComponent(slug)}/switch`);
      return send(res, 200, data);
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }
  const boardMatch = url.pathname.match(/^\/api\/boards\/([^/]+)$/);
  if (boardMatch && req.method === 'PATCH') {
    try {
      const slug = decodeURIComponent(boardMatch[1]);
      const payload = await readJson(req);
      const data = await apiFetch('PATCH', `/api/plugins/kanban/boards/${encodeURIComponent(slug)}`, payload);
      return send(res, 200, data);
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }
  if (boardMatch && req.method === 'DELETE') {
    try {
      const slug = decodeURIComponent(boardMatch[1]);
      const data = await apiFetch('DELETE', `/api/plugins/kanban/boards/${encodeURIComponent(slug)}`);
      return send(res, 200, data);
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }
  if (url.pathname === '/api/team' && req.method === 'GET') {
    return send(res, 200, TEAM_PROFILES);
  }
  const teamMatch = url.pathname.match(/^\/api\/team\/(.+)$/);
  if (teamMatch && req.method === 'PATCH') {
    const name = decodeURIComponent(teamMatch[1]);
    const input = await readJson(req);
    if (input.group) {
      if (!teamOverrides[name]) teamOverrides[name] = {};
      teamOverrides[name].group = input.group;
      fs.mkdirSync('data', {recursive: true});
      fs.writeFileSync('data/team-overrides.json', JSON.stringify(teamOverrides));
      rebuildTeam();
    }
    return send(res, 200, TEAM_PROFILES.find(p => p.n === name) || {});
  }

  // Profile management
  const profileMatch = url.pathname.match(/^\/api\/profiles\/(.+)$/);
  if (profileMatch && req.method === 'GET') {
    const name = decodeURIComponent(profileMatch[1]);
    try {
      const desc = cp.execSync(`hermes profile describe "${name}"`, {encoding: 'utf8'}).trim();
      const show = cp.execSync(`hermes profile show "${name}"`, {encoding: 'utf8'});
      const pathMatch = show.match(/Path:\s+(.+)/);
      let soul = '';
      if (pathMatch) {
        const soulPath = path.join(pathMatch[1], 'SOUL.md');
        if (fs.existsSync(soulPath)) soul = fs.readFileSync(soulPath, 'utf8');
      }
      return send(res, 200, { description: desc, soul });
    } catch(e) {
      return send(res, 404, {error: e.message});
    }
  }

  if (profileMatch && req.method === 'DELETE') {
    const name = decodeURIComponent(profileMatch[1]);
    try {
      // Deletion is not easily exposed via GET/PATCH on profiles plugin API, 
      // but if the UI needs it, we leave this as execSync for now, 
      // or map it if Hermes expose DELETE /api/profiles/:name. 
      // Since it's a destructive op on the file system, fallback to CLI if API is not available.
      cp.execSync(`hermes profile delete -y "${name.replace(/"/g, '')}"`, {stdio: 'pipe'});
      if (teamOverrides[name]) {
        delete teamOverrides[name];
        fs.writeFileSync('data/team-overrides.json', JSON.stringify(teamOverrides));
      }
      await rebuildTeam();
      return send(res, 200, { success: true });
    } catch(e) {
      return send(res, 500, {error: String(e.stderr || e.message)});
    }
  }

  if (profileMatch && req.method === 'PATCH') {
    let name = decodeURIComponent(profileMatch[1]);
    const input = await readJson(req);
    try {
      if (input.name && input.name !== name) {
        cp.execSync(`hermes profile rename "${name}" "${input.name.replace(/"/g, '')}"`, {stdio: 'pipe'});
        if (teamOverrides[name]) {
          teamOverrides[input.name] = teamOverrides[name];
          delete teamOverrides[name];
          fs.writeFileSync('data/team-overrides.json', JSON.stringify(teamOverrides));
        }
        name = input.name; 
      }
      if (input.description !== undefined) {
        await apiFetch('PATCH', `/api/plugins/kanban/profiles/${encodeURIComponent(name)}`, {description: input.description});
      }
      if (input.soul !== undefined) {
        const data = await apiFetch('GET', '/api/profiles');
        const prof = (data.profiles || []).find(p => p.name === name);
        if (prof && prof.path) {
          fs.writeFileSync(path.join(prof.path, 'SOUL.md'), input.soul);
        }
      }
      await rebuildTeam();
      return send(res, 200, { success: true });
    } catch(e) {
      return send(res, 500, {error: e.message});
    }
  }

  if (url.pathname === '/api/profiles' && req.method === 'POST') {
    const input = await readJson(req);
    try {
      // Profile creation is typically CLI
      let cmd = `hermes profile create "${input.name.replace(/"/g, '')}"`;
      if (input.description) cmd += ` --description "${input.description.replace(/"/g, '\\"')}"`;
      cp.execSync(cmd, {stdio: 'pipe'});
      if (input.soul) {
        const data = await apiFetch('GET', '/api/profiles');
        const prof = (data.profiles || []).find(p => p.name === input.name);
        if (prof && prof.path) {
          fs.writeFileSync(path.join(prof.path, 'SOUL.md'), input.soul);
        }
      }
      await rebuildTeam();
      return send(res, 200, { success: true });
    } catch(e) {
      return send(res, 500, {error: String(e.stderr || e.message)});
    }
  }

  if (url.pathname === '/api/agents' && req.method === 'GET') {
    const mems = {};
    for (const p of TEAM_PROFILES) {
      mems[p.n] = { role: p.role, model: 'hermes' };
    }
    return send(res, 200, {mode: 'claude', model: 'hermes', members: mems});
  }
if (url.pathname === '/api/tasks' && req.method === 'GET') {
    const board = url.searchParams.get('board');
    if (board) {
      try {
        const data = await apiFetch('GET', `/api/plugins/kanban/board?board=${encodeURIComponent(board)}`);
        
        let allTasks = [];
        if (data.columns) {
          data.columns.forEach(col => {
            if (col.tasks) allTasks = allTasks.concat(col.tasks);
          });
        }
        
        const statusMap = {todo: 'queued', ready: 'queued', running: 'active', blocked: 'blocked', review: 'review', done: 'done', triage: 'queued', scheduled: 'queued'};
        const mapped = await Promise.all(allTasks.map(async t => {
          const matchedAssignee = Array.from(MEMBERS).find(m => m.toLowerCase() === (t.assignee || '').toLowerCase()) || t.assignee || '';
          const currentStatus = statusMap[t.status] || 'queued';
          
          let workerLog = currentStatus === 'active' ? (t.latest_summary || undefined) : (t.latest_summary || undefined);
          if (currentStatus === 'active') {
            try {
              const logData = await apiFetch('GET', `/api/plugins/kanban/tasks/${t.id}/log?board=${encodeURIComponent(board)}`);
              if (logData && logData.content) {
                workerLog = logData.content;
              }
            } catch (e) {
              // fallback to latest_summary if fetching log fails
            }
          }
          
          return {
            id: t.id,
            title: t.title,
            brief: t.body || '',
            assignee: matchedAssignee,
            status: currentStatus,
            result: (currentStatus === 'review' || currentStatus === 'done') ? (t.result || t.latest_summary || '') : '',
            questions: currentStatus === 'blocked' ? (t.latest_summary || '') : undefined,
            createdAt: new Date(t.created_at * 1000).toISOString(),
            error: t.last_failure_error || undefined,
            workerLog,
            workspace: t.workspace_kind || '',
            absolutePath: t.workspace_path || ''
          };
        }));
        return send(res, 200, mapped);
      } catch (e) {
        return send(res, 200, []);
      }
    }
    return send(res, 200, tasks);
  }

  if (url.pathname === '/api/tasks' && req.method === 'POST') {
    const input = await readJson(req);
    const board = url.searchParams.get('board');
    if (board) {
      try {
        const payload = {
          title: input.title,
          body: input.brief || null,
          assignee: input.assignee || null,
          triage: true
        };
        if (input.workspace) {
          if (input.workspace === 'scratch') {
            payload.workspace_kind = 'scratch';
            payload.workspace_path = null;
          } else if (input.workspace === 'worktree') {
            payload.workspace_kind = 'worktree';
            payload.workspace_path = input.absolutePath || null;
          } else {
            payload.workspace_kind = 'dir';
            payload.workspace_path = input.absolutePath || input.workspace.replace(/^dir:/, '');
          }
        }
        
        const data = await apiFetch('POST', `/api/plugins/kanban/tasks?board=${encodeURIComponent(board)}`, payload);
        const hTask = data.task;
        
        const statusMap = {todo: 'queued', ready: 'queued', running: 'active', blocked: 'blocked', review: 'review', done: 'done', triage: 'queued', scheduled: 'queued'};
        const matchedAssignee = Array.from(MEMBERS).find(m => m.toLowerCase() === (hTask.assignee || '').toLowerCase()) || hTask.assignee || '';
        
        return send(res, 201, {
          id: hTask.id,
          title: hTask.title,
          brief: hTask.body || '',
          assignee: matchedAssignee,
          status: statusMap[hTask.status] || 'queued',
          result: hTask.result || '',
          createdAt: hTask.created_at ? new Date(hTask.created_at * 1000).toISOString() : new Date().toISOString()
        });
      } catch (e) {
        return send(res, 500, {error: e.message});
      }
    }
    
    if(input?.status!==undefined&&!STATES.has(input.status))return send(res,400,{error:'Unknown status.'});
    const task = newTask(input); if (!task) return send(res, 400, {error: 'A task needs a title and an assignee.'});
    if(!MEMBERS.has(task.assignee))return send(res,400,{error:'Unknown assignee.'});
    if(task.status==='review'||task.status==='blocked'||(agents[task.assignee]&&task.status!=='queued'))return send(res,409,{error:'AI drafts must be generated before review.'});
    if(task.status==='active'&&tasks.some(t=>t.assignee===task.assignee&&t.status==='active'))return send(res,409,{error:'This member already has an active task.'});
    tasks.unshift(task); save(); send(res, 201, task); setImmediate(kick); return;
  }
  if (url.pathname === '/api/webhook/hermes' && req.method === 'POST') {
    const payload = await readJson(req);
    if (!payload || !payload.hook_event_name) return send(res, 400, {error: 'Invalid webhook payload'});
    
    // Fallback: karena webhook tidak membawa ID task atau nama profil langsung (tergantung versi),
    // web UI bisa mengupdate log/ucapan dari state internalnya yang aktif.
    const eventName = payload.hook_event_name;
    
    // Optional extension: Jika payload membawa task_id, bisa dicocokkan langsung.
    // Di sini kita sekedar mem-broadcast event ke client agar bisa update UI.
    return send(res, 200, {status: 'ok', event: eventName});
  }

  // One-time move of tasks saved in a browser before the server existed; only into an empty store.
  if (url.pathname === '/api/tasks/import' && req.method === 'POST') {
    if (tasks.length) return send(res, 409, {error: 'The server already has tasks.'});
    const list = await readJson(req); if (!Array.isArray(list)) return send(res, 400, {error: 'Expected a list of tasks.'});
    if(tasks.length)return send(res,409,{error:'The server already has tasks.'});
    tasks = list.map(item => { const task = newTask(item); if (task && typeof item.createdAt === 'string') task.createdAt = item.createdAt; if(task&&Array.isArray(item.history))task.history=item.history; return task; }).filter(Boolean);
    // Imported work that was in progress by hand goes back to the queue.
    tasks.forEach(task => { if (task.status === 'active') task.status = 'queued'; });
    save(); kick(); return send(res, 201, tasks);
  }
  const match = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)$/);
  if (match && req.method === 'PATCH') {
    const input = await readJson(req);
    const board = url.searchParams.get('board');
    if (board) {
      try {
        const taskId = match[1];
        if (input.action === 'answer') {
           const answerText = typeof input.answer === 'string' ? input.answer.trim().slice(0, 3000) : '';
           if (answerText) {
             await apiFetch('POST', `/api/plugins/kanban/tasks/${taskId}/comments?board=${encodeURIComponent(board)}`, {text: answerText, author: 'user'});
           }
           await apiFetch('PATCH', `/api/plugins/kanban/tasks/${taskId}?board=${encodeURIComponent(board)}`, {status: 'ready'});
        } else if (input.action === 'revise') {
           const feedbackText = typeof input.feedback === 'string' ? input.feedback.trim().slice(0, 100000) : 'Please revise.';
           await apiFetch('PATCH', `/api/plugins/kanban/tasks/${taskId}?board=${encodeURIComponent(board)}`, {status: 'todo', body: feedbackText});
        } else if (input.action === 'approve') {
           await apiFetch('PATCH', `/api/plugins/kanban/tasks/${taskId}?board=${encodeURIComponent(board)}`, {status: 'done', result: 'Approved'});
        } else if (input.action === 'archive') {
           await apiFetch('PATCH', `/api/plugins/kanban/tasks/${taskId}?board=${encodeURIComponent(board)}`, {status: 'archived'});
           return send(res, 200, {id: taskId, archived: true});
        }

        if (input.assignee !== undefined) {
           await apiFetch('PATCH', `/api/plugins/kanban/tasks/${taskId}?board=${encodeURIComponent(board)}`, {assignee: input.assignee});
        }
        if (input.status === 'done') {
           await apiFetch('PATCH', `/api/plugins/kanban/tasks/${taskId}?board=${encodeURIComponent(board)}`, {status: 'done', result: input.result || 'done'});
        } else if (input.status === 'queued') {
           await apiFetch('PATCH', `/api/plugins/kanban/tasks/${taskId}?board=${encodeURIComponent(board)}`, {status: 'ready'});
        } else if (input.status === 'review') {
           await apiFetch('PATCH', `/api/plugins/kanban/tasks/${taskId}?board=${encodeURIComponent(board)}`, {status: 'review'});
        }
        
        const data = await apiFetch('GET', `/api/plugins/kanban/tasks/${taskId}?board=${encodeURIComponent(board)}`);
        const hTask = data.task;
        
        if (hTask) {
          const currentStatus = {todo: 'queued', ready: 'queued', running: 'active', blocked: 'blocked', review: 'review', done: 'done', triage: 'queued', scheduled: 'queued'}[hTask.status] || 'queued';
          let summary = hTask.latest_summary || '';
          const matchedAssignee = Array.from(MEMBERS).find(m => m.toLowerCase() === (hTask.assignee || '').toLowerCase()) || hTask.assignee || '';
          
          let workerLog = summary;
          if (currentStatus === 'active') {
            try {
              const logData = await apiFetch('GET', `/api/plugins/kanban/tasks/${hTask.id}/log?board=${encodeURIComponent(board)}`);
              if (logData && logData.content) {
                workerLog = logData.content;
              }
            } catch (e) {
              // fallback
            }
          }
          
          return send(res, 200, {
            id: hTask.id,
            title: hTask.title,
            brief: hTask.body || '',
            assignee: matchedAssignee,
            status: currentStatus,
            result: (currentStatus === 'review' || currentStatus === 'done') ? (hTask.result || summary || '') : '',
            questions: currentStatus === 'blocked' ? summary : undefined,
            createdAt: new Date(hTask.created_at * 1000).toISOString(),
            error: hTask.last_failure_error || undefined,
            workerLog,
            workspace: hTask.workspace_kind || '',
            absolutePath: hTask.workspace_path || ''
          });
        }
        return send(res, 200, {id: taskId});
      } catch (e) {
        return send(res, 500, {error: e.message});
      }
    }
    const task = tasks.find(t => t.id === match[1]); if (!task) return send(res, 404, {error: 'Task not found.'});
    let change = {};
    if(!input||typeof input!=='object')return send(res,400,{error:'Expected an object.'});
    // Answering an agent's questions adds the answers to the brief and puts the task back in its queue.
    if(input.action==='answer'){
      if(task.status!=='blocked'||input.version!==(task.version||0))return send(res,409,{error:'These questions changed. Refresh and answer the latest ones.'});
      const answer=text(input.answer,3000);if(!answer)return send(res,400,{error:'Write an answer first.'});
      Object.assign(task,{status:'queued',brief:`${task.brief}\n\nQuestions from ${task.assignee}:\n${task.questions}\n\nAnswers:\n${answer}`.trim().slice(0,100000),questions:undefined,askedBy:undefined,error:undefined,runId:null,version:(task.version||0)+1,updatedAt:now()});
      save();send(res,200,task);setImmediate(kick);return;
    }
    if(input.action!==undefined){
      if(input.action === 'archive') {
        const idx = tasks.findIndex(t => t.id === task.id);
        if(idx !== -1) { tasks.splice(idx, 1); save(); }
        return send(res, 200, {id: match[1], archived: true});
      }
      if(!['approve','revise'].includes(input.action))return send(res,400,{error:'Unknown action.'});
      if(task.status!=='review'||input.version!==(task.version||0))return send(res,409,{error:'This draft changed. Refresh and review the latest version.'});
      if(input.action==='revise'&&!text(input.feedback,100000))return send(res,400,{error:'Describe the changes needed.'});
      Object.assign(task,{status:input.action==='approve'?'done':'queued',feedback:input.action==='revise'?text(input.feedback,100000):'',reviewedAt:input.action==='approve'?now():null,runId:null,error:undefined,version:(task.version||0)+1,updatedAt:now()});
      save();send(res,200,task);setImmediate(kick);return;
    }
    if (input.assignee !== undefined) { change.assignee = text(input.assignee, 80); if (!MEMBERS.has(change.assignee)) return send(res, 400, {error: 'Pick an assignee.'}); if (task.status !== 'done') change.status = 'queued'; }
    if (input.status !== undefined) {
      if (!STATES.has(input.status)||input.status==='review'||input.status==='blocked') return send(res, 400, {error: 'Unknown status.'});
      const assignee = change.assignee || task.assignee;
      if(task.status==='review'&&!change.assignee)return send(res,409,{error:'Approve this draft or request a revision.'});
      if (agents[assignee] && input.status !== 'queued') return send(res, 409, {error: 'This member is connected to an AI agent; it starts and finishes its own tasks.'});
      if (input.status === 'active' && tasks.some(t => t.id !== task.id && t.assignee === assignee && t.status === 'active')) return send(res, 409, {error: 'This member already has an active task.'});
      if (input.status === 'done' && !text(input.result, 10000)) return send(res, 400, {error: 'Write a result before finishing.'});
      change.status = input.status; change.result = input.status === 'done' ? text(input.result, 10000) : '';
    }
    if(!Object.keys(change).length)return send(res,400,{error:'Provide an assignee, status, or review action.'});
    // Moving a task back to the queue clears a previous agent error so it is tried again.
    Object.assign(task, change, {runId:null,version:(task.version||0)+1,error: undefined, updatedAt: now()}); save(); kick(); return send(res, 200, task);
  }
  send(res, 404, {error: 'Not found.'});
}
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon'};
function serveFile(res, url) {
  let file;
  try { file = path.join(PUBLIC, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)); } catch { return send(res, 400, {error: 'Bad path.'}); }
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, {error: 'Forbidden.'});
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404, {'content-type': 'text/plain'}); return res.end('Not found'); }
    res.writeHead(200, {'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache'}); res.end(data);
  });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  if (!url.pathname.startsWith('/api/')) return serveFile(res, url);
  try { await api(req, res, url); }
  catch (error) { send(res, error.status || 500, {error: error.status ? error.message : 'Server error.'}); if (!error.status) console.error(error); }
});
server.listen(PORT, HOST, async () => {
  console.log(`Kantor AI: http://${HOST}:${PORT}`);
  console.log('AI agents: Using Hermes gateway. Trying to reach dashboard at 9119...');
  try {
    await rebuildTeam();
    console.log('Profiles initialized.');
  } catch (e) {
    console.log('Could not load profiles (dashboard might not be running yet).');
  }
});
