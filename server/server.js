// Kantor AI server: serves public/ and proxies profiles and kanban tasks to the Hermes dashboard (9119).
// Hermes workers do the AI work; Hermes outbound webhooks are relayed to the browser over SSE.
// No login yet, so it only listens on this machine.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HERMES_URL = 'http://127.0.0.1:9119';

let dashboardToken = null;
async function getHermesToken() {
  if (dashboardToken) return dashboardToken;
  try {
    const res = await fetch(`${HERMES_URL}/`);
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
    return fetch(`${HERMES_URL}${path}`, opts);
  };

  let res;
  let attempts = 3;
  while (attempts > 0) {
    try {
      res = await doFetch(token);
      break;
    } catch (err) {
      const code = err.cause?.code || err.code;
      if (['ECONNREFUSED', 'UND_ERR_SOCKET', 'ECONNRESET'].includes(code) || err.message === 'fetch failed' || err.message.includes('other side closed')) {
        attempts--;
        if (attempts === 0) throw err;
        await new Promise(r => setTimeout(r, 800));
      } else {
        throw err;
      }
    }
  }

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

try { process.loadEnvFile(process.env.ENV_FILE || path.join(ROOT, '.env')); } catch { /* no .env file */ }

const PUBLIC = path.join(ROOT, 'public');
const HOST = '127.0.0.1', PORT = Number(process.env.PORT) || 3000;
const now = () => new Date().toISOString();

let teamOverrides = {};
const saveOverrides = () => { fs.mkdirSync('data', {recursive: true}); fs.writeFileSync('data/team-overrides.json', JSON.stringify(teamOverrides)); };

const taskSummaryCache = new Map();

// Each profile's worker fires hooks from its own config.yaml (no inheritance from default),
// so the webhook is added to every profile. claimed comes from the gateway, completed/blocked
// and tool calls from the worker: each event fires once, from one process.
const HOOK_URL = `http://${HOST}:${PORT}/api/webhook/hermes`;
const HOOK_EVENTS = ['kanban_task_claimed', 'kanban_task_completed', 'kanban_task_blocked', 'pre_tool_call', 'post_tool_call'];
const hooked = new Set();
async function ensureHook(profile) {
  if (hooked.has(profile) || process.env.NO_HOOKS) return;
  const q = `?profile=${encodeURIComponent(profile)}`;
  const {yaml = ''} = await apiFetch('GET', `/api/config/raw${q}`) || {};
  // ponytail: text check, not a YAML parse; a profile with its own hooks.outbound is left alone.
  if (yaml.includes(HOOK_URL)) {}
  else if (/^\s+outbound:/m.test(yaml)) console.warn(`Profile ${profile} has its own hooks.outbound; add ${HOOK_URL} there for live events.`);
  else await apiFetch('PUT', `/api/config${q}`, {config: {hooks: {outbound: [{name: 'kantor-ai-sync', url: HOOK_URL, events: HOOK_EVENTS}]}}});
  hooked.add(profile);
}

let TEAM_PROFILES = [];
const MEMBERS = new Set();
let rebuildPromise = null;
async function rebuildTeam() {
  if (rebuildPromise) return rebuildPromise;
  rebuildPromise = (async () => {
    try {
      try { teamOverrides = JSON.parse(fs.readFileSync('data/team-overrides.json', 'utf8')); } catch(e) {}
      const data = await apiFetch('GET', '/api/profiles');
      if (!data || !data.profiles) return;
      await Promise.all(data.profiles.map(p => ensureHook(p.name).catch(e => console.error(`Webhook for ${p.name}:`, e.message))));
      let c = 0;
      const newProfiles = [];
      for (const p of data.profiles) {
        if (p.name !== 'default') {
          c++;
          newProfiles.push({
            n: p.name,
            initials: p.name,
            gender: c % 2 === 0 ? 'female' : 'male',
            role: 'AI Agent',
            model: p.model || 'hermes',
            group: teamOverrides[p.name]?.group || (p.name === 'techlead' ? 'leadership' : 'engineering')
          });
        }
      }
      TEAM_PROFILES = newProfiles;
      MEMBERS.clear();
      TEAM_PROFILES.forEach(p => MEMBERS.add(p.n));
    } catch(e) {
      console.error('Failed to load profiles:', e.message);
    } finally {
      rebuildPromise = null;
    }
  })();
  return rebuildPromise;
}
// Note: initial call is deferred to server start.

// ---- Hermes kanban <-> office task shape ----
const STATUS = {triage: 'queued', todo: 'queued', ready: 'queued', scheduled: 'queued', running: 'active', blocked: 'blocked', review: 'review', done: 'done'};
const memberOf = name => [...MEMBERS].find(m => m.toLowerCase() === (name || '').toLowerCase()) || name || '';
const kanban = (p, board) => `/api/plugins/kanban${p}${board ? `${p.includes('?') ? '&' : '?'}board=${encodeURIComponent(board)}` : ''}`;
function toUiTask(t, {summary, runs, workerLog, comments} = {}) {
  const status = STATUS[t.status] || 'queued';
  return {
    id: t.id,
    title: t.title,
    brief: t.body || '',
    assignee: memberOf(t.assignee),
    status,
    result: status === 'review' || status === 'done' ? (summary || t.result || t.latest_summary || '') : '',
    questions: status === 'blocked' ? (t.latest_summary || '') : undefined,
    createdAt: t.created_at ? new Date(t.created_at * 1000).toISOString() : now(),
    error: t.last_failure_error || undefined,
    workerLog: workerLog || t.latest_summary || undefined,
    workspace: t.workspace_kind || '',
    absolutePath: t.workspace_path || '',
    runs,
    metadata: runs?.[0]?.metadata || undefined,
    comments
  };
}
// The live worker log, only while the task runs.
async function workerLogOf(t, board) {
  if (STATUS[t.status] !== 'active') return undefined;
  try { return (await apiFetch('GET', kanban(`/tasks/${t.id}/log`, board)))?.content || undefined; } catch { return undefined; }
}
// Full task (untruncated result, runs, comments); caches the summary for the board list.
async function taskDetail(id, board) {
  const data = await apiFetch('GET', kanban(`/tasks/${encodeURIComponent(id)}`, board));
  const t = data?.task;
  if (!t) return null;
  const runs = data.runs || [];
  const summary = t.result || t.latest_summary || runs[0]?.summary || '';
  if (summary) taskSummaryCache.set(`${board}:${id}`, {summary, runs});
  return toUiTask(t, {summary, runs, workerLog: await workerLogOf(t, board), comments: data.comments || []});
}

// ---- live events: Hermes outbound webhooks fanned out to browsers over SSE ----
const listeners = new Set();
const broadcast = data => { const msg = `data: ${JSON.stringify(data)}\n\n`; for (const res of listeners) res.write(msg); };
setInterval(() => { for (const res of listeners) res.write(':\n\n'); }, 25000).unref();

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
    await rebuildTeam();
    return send(res, 200, TEAM_PROFILES);
  }
  const teamMatch = url.pathname.match(/^\/api\/team\/(.+)$/);
  if (teamMatch && req.method === 'PATCH') {
    const name = decodeURIComponent(teamMatch[1]);
    const input = await readJson(req);
    if (input.group) {
      if (!teamOverrides[name]) teamOverrides[name] = {};
      teamOverrides[name].group = input.group;
      saveOverrides();
      rebuildTeam();
    }
    return send(res, 200, TEAM_PROFILES.find(p => p.n === name) || {});
  }

  // Profile management, all through the dashboard's /api/profiles.
  const profileMatch = url.pathname.match(/^\/api\/profiles\/(.+)$/);
  if (profileMatch && req.method === 'GET') {
    const name = decodeURIComponent(profileMatch[1]);
    try {
      const [data, soul] = await Promise.all([
        apiFetch('GET', '/api/profiles'),
        apiFetch('GET', `/api/profiles/${encodeURIComponent(name)}/soul`).catch(() => null)
      ]);
      const prof = (data?.profiles || []).find(p => p.name === name);
      if (!prof) return send(res, 404, {error: 'Profile not found.'});
      return send(res, 200, { description: prof.description || '', soul: soul?.content || '' });
    } catch(e) {
      return send(res, 500, {error: e.message});
    }
  }

  if (profileMatch && req.method === 'DELETE') {
    const name = decodeURIComponent(profileMatch[1]);
    try {
      await apiFetch('DELETE', `/api/profiles/${encodeURIComponent(name)}`);
      if (teamOverrides[name]) {
        delete teamOverrides[name];
        saveOverrides();
      }
      await rebuildTeam();
      return send(res, 200, { success: true });
    } catch(e) {
      return send(res, 500, {error: e.message});
    }
  }

  if (profileMatch && req.method === 'PATCH') {
    let name = decodeURIComponent(profileMatch[1]);
    const input = await readJson(req);
    try {
      if (input.name && input.name !== name) {
        // Hermes stops the profile's gateway before renaming, so this can take a few seconds.
        const renamed = await apiFetch('PATCH', `/api/profiles/${encodeURIComponent(name)}`, {new_name: input.name});
        const newName = renamed?.name || input.name;
        if (teamOverrides[name]) {
          teamOverrides[newName] = teamOverrides[name];
          delete teamOverrides[name];
          saveOverrides();
        }
        name = newName;
      }
      if (input.description !== undefined) {
        await apiFetch('PUT', `/api/profiles/${encodeURIComponent(name)}/description`, {description: input.description});
      }
      if (input.soul !== undefined) {
        await apiFetch('PUT', `/api/profiles/${encodeURIComponent(name)}/soul`, {content: input.soul});
      }
      await rebuildTeam();
      return send(res, 200, { success: true });
    } catch(e) {
      return send(res, 500, {error: e.message});
    }
  }

  if (url.pathname === '/api/profiles' && req.method === 'POST') {
    const input = await readJson(req);
    if (typeof input.name !== 'string' || !input.name.trim()) return send(res, 400, {error: 'A profile needs a name.'});
    try {
      const created = await apiFetch('POST', '/api/profiles', {name: input.name.trim(), description: input.description || undefined});
      const name = created?.name || input.name.trim();
      if (input.soul) {
        await apiFetch('PUT', `/api/profiles/${encodeURIComponent(name)}/soul`, {content: input.soul});
      }
      await rebuildTeam();
      return send(res, 200, { success: true });
    } catch(e) {
      return send(res, 500, {error: e.message});
    }
  }

  if (url.pathname === '/api/agents' && req.method === 'GET') {
    await rebuildTeam();
    const mems = {};
    for (const p of TEAM_PROFILES) {
      mems[p.n] = { role: p.role, model: p.model };
    }
    return send(res, 200, {mode: 'hermes', members: mems});
  }

  if (url.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive'});
    res.write(':\n\n');
    listeners.add(res);
    req.on('close', () => listeners.delete(res));
    return;
  }

  // Hermes hooks.outbound target. ponytail: no HMAC check, fine while the server only listens on loopback;
  // set a `secret` in config.yaml and verify X-Hermes-Signature if it ever listens elsewhere.
  if (url.pathname === '/api/webhook/hermes' && req.method === 'POST') {
    const payload = await readJson(req);
    if (!payload || !payload.hook_event_name) return send(res, 400, {error: 'Invalid webhook payload'});
    const extra = payload.extra || {};
    broadcast({
      event: payload.hook_event_name,
      profile: memberOf(extra.assignee || extra.profile_name || payload.profile),
      tool: payload.tool_name || undefined,
      taskId: extra.task_id || undefined,
      board: extra.board || undefined,
      note: extra.summary || extra.reason || undefined
    });
    return send(res, 200, {status: 'ok', event: payload.hook_event_name});
  }

  const board = url.searchParams.get('board') || '';
  if (url.pathname === '/api/tasks' && req.method === 'GET') {
    try {
      const data = await apiFetch('GET', kanban('/board', board));
      const allTasks = (data?.columns || []).flatMap(col => col.tasks || []);
      // Pre-fetch uncached done/review tasks so the board shows full, untruncated summaries.
      const uncached = allTasks.filter(t => ['done', 'review'].includes(STATUS[t.status]) && !taskSummaryCache.has(`${board}:${t.id}`));
      await Promise.all(uncached.slice(0, 15).map(t => taskDetail(t.id, board).catch(() => null)));
      const mapped = await Promise.all(allTasks.map(async t => {
        const cached = taskSummaryCache.get(`${board}:${t.id}`);
        return toUiTask(t, {summary: cached?.summary, runs: cached?.runs, workerLog: await workerLogOf(t, board)});
      }));
      return send(res, 200, mapped);
    } catch (e) {
      return send(res, 200, []);
    }
  }

  if (url.pathname === '/api/tasks' && req.method === 'POST') {
    const input = await readJson(req);
    if (typeof input.title !== 'string' || !input.title.trim()) return send(res, 400, {error: 'A task needs a title.'});
    try {
      const payload = {
        title: input.title.trim(),
        body: input.brief || null,
        assignee: input.assignee || null,
        triage: !input.assignee
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
      const data = await apiFetch('POST', kanban('/tasks', board), payload);
      return send(res, 201, toUiTask(data.task));
    } catch (e) {
      return send(res, 500, {error: e.message});
    }
  }

  const match = url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)$/);
  if (match && req.method === 'GET') {
    try {
      const task = await taskDetail(match[1], board);
      return task ? send(res, 200, task) : send(res, 404, {error: 'Task not found'});
    } catch (e) {
      return send(res, 500, {error: e.message});
    }
  }
  if (match && req.method === 'PATCH') {
    const input = await readJson(req);
    const taskId = match[1];
    const patch = body => apiFetch('PATCH', kanban(`/tasks/${taskId}`, board), body);
    try {
      if (input.action === 'answer') {
        const answerText = typeof input.answer === 'string' ? input.answer.trim() : '';
        if (answerText) await apiFetch('POST', kanban(`/tasks/${taskId}/comments`, board), {text: answerText, author: 'user'});
        await patch({status: 'ready'});
      } else if (input.action === 'revise') {
        await patch({status: 'todo', body: typeof input.feedback === 'string' ? input.feedback.trim() : 'Please revise.'});
      } else if (input.action === 'approve') {
        await patch({status: 'done', result: 'Approved'});
      } else if (input.action === 'archive') {
        await patch({status: 'archived'});
        return send(res, 200, {id: taskId, archived: true});
      }
      if (input.assignee !== undefined) await patch({assignee: input.assignee});
      if (input.status === 'done') await patch({status: 'done', result: input.result || 'done'});
      else if (input.status === 'queued') await patch({status: 'ready'});
      else if (input.status === 'review') await patch({status: 'review'});
      return send(res, 200, await taskDetail(taskId, board) || {id: taskId});
    } catch (e) {
      return send(res, 500, {error: e.message});
    }
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
  console.log(`AI agents: Hermes dashboard at ${HERMES_URL}`);
  try {
    await rebuildTeam();
    console.log('Profiles initialized.');
  } catch (e) {
    console.log('Could not load profiles (dashboard might not be running yet).');
  }
});
