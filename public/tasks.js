(() => {
  const storageKey = 'kantor-ai.tasks.v1';
  const states = {queued: 'Queued', active: 'In progress', blocked: 'Needs decision', review: 'Needs review', done: 'Done'};
  const el = id => document.getElementById(id);
  let tasks = [], team = [], changed, locate;
  let storageHealthy = true;
  let mutation=0,polling=false,writing=0;
  const drafts=new Map();
  const draftKey=(task,kind)=>`${kind}:${task.id}:${kind==='result'?'result':(task.version||0)}`;
  function draftRead(key){if(drafts.has(key))return drafts.get(key);try{return sessionStorage.getItem('kantor-draft:'+key)||'';}catch{return '';}}
  function draftWrite(key,value){drafts.set(key,value);try{sessionStorage.setItem('kantor-draft:'+key,value);}catch{feedback('Draft is kept in this tab only; browser storage is unavailable.');}}
  function draftClear(key){drafts.delete(key);try{sessionStorage.removeItem('kantor-draft:'+key);}catch{}}

  // With the server running, tasks live there and some members are AI agents; without it, tasks stay in this browser.
  let server = null;
  const displayName = name => team.find(person => person.n === name)?.initials || name;
  const agentFor = name => server?.members[name] ? {...server.members[name], mode: server.mode} : null;

  function humanTime(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    const now = new Date();
    const diffMin = Math.floor((now - date) / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
    const diffDay = Math.floor(diffMin / 1440);
    if (diffDay < 7) return `${diffDay}d ago`;
    const options = { month: 'short', day: 'numeric' };
    if (date.getFullYear() !== now.getFullYear()) options.year = 'numeric';
    return date.toLocaleDateString('en-GB', options);
  }

  function feedback(message) { el('taskFeedback').textContent = message; }
  function persist(next) {
    if (!storageHealthy) {
      feedback('Saved data cannot be read. Changes are blocked so the old data is not overwritten.');
      return false;
    }
    try { localStorage.setItem(storageKey, JSON.stringify(next)); }
    catch { feedback('Could not save. Check browser storage; the change was not applied.'); return false; }
    tasks = next;
    return true;
  }
  async function call(method, path, body) {
    const write=method!=='GET';if(write){mutation++;writing++;}
    try{
      const board = document.getElementById('boardSelect')?.value;
      if (board) {
        path += (path.includes('?') ? '&' : '?') + 'board=' + encodeURIComponent(board);
      }
      const response=await fetch(path,{method,headers:{'content-type':'application/json'},body:body&&JSON.stringify(body)});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.error||`Server error ${response.status}`);
      return data;
    }finally{if(write){writing--;mutation++;}}
  }
  // Server changes arrive as whole task lists; report each status change once so the office log and characters follow.
  function apply(list) {
    const before = new Map(tasks.map(t => [t.id, t]));
    tasks = list;
    for (const task of list) {
      const old = before.get(task.id);
      // A fast agent can go from queued to done between two polls; still log that it started.
      if (old && old.status === 'queued' && ['blocked','review','done'].includes(task.status)) changed(task.assignee, 'active', task.title);
      if (old && old.status !== task.status) changed(task.assignee, task.status, task.title);
      if (old && old.assignee !== task.assignee) changed(old.assignee);
    }
  }
  function validTask(task) {
    return task && typeof task.id === 'string' && typeof task.title === 'string' && task.title.trim() &&
      task.title.length <= 160 && typeof task.assignee === 'string' && task.assignee.trim() &&
      Object.hasOwn(states, task.status) && typeof task.brief === 'string' && task.brief.length <= 5000 &&
      typeof task.result === 'string' && task.result.length <= 10000 &&
      (!['review','done'].includes(task.status) || task.result.trim()) && typeof task.createdAt === 'string';
  }
  function node(tag, text, className) {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    return item;
  }
  function action(text, handler) {
    const button = node('button', text);
    button.type = 'button'; button.onclick = handler;
    return button;
  }
  async function archiveTask(task) {
    if(!confirm('Archive this task?'))return;
    try {
      if (server) {
        await call('PATCH', `/api/tasks/${task.id}`, {action: 'archive'});
      }
      const next = tasks.filter(t => t.id !== task.id);
      if (!server && !persist(next)) return;
      if (server) tasks = next;
      expandedTaskId = null;
      render();
      feedback('Task archived.');
    } catch (error) { feedback(error.message); }
  }

  async function update(id, status, result = '') {
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    if (status === 'active' && tasks.some(t => t.id !== id && t.assignee === task.assignee && t.status === 'active')) {
      feedback(`${displayName(task.assignee)} already has an active task. Move it back to the queue or finish it first.`);
      return;
    }
    if (server) {
      try { const saved = await call('PATCH', `/api/tasks/${id}`, {status, result}); apply(tasks.map(t => t.id === id ? saved : t)); }
      catch (error) { feedback(error.message); return; }
    } else {
      const next = tasks.map(t => t.id === id ? {...t, status, result, updatedAt: new Date().toISOString()} : t);
      if (!persist(next)) return;
      changed(task.assignee, status, task.title);
    }
    if(status==='done')draftClear(draftKey(task,'result'));
    render(); feedback(`Task status: ${states[status]}.`);
    el('taskFilter').focus();
  }
  async function reassign(id, assignee) {
    if (!team.some(person => person.n === assignee)) return;
    if (server) {
      try { const saved = await call('PATCH', `/api/tasks/${id}`, {assignee}); apply(tasks.map(t => t.id === id ? saved : t)); }
      catch (error) { feedback(error.message); return; }
    } else {
      const next = tasks.map(task => task.id === id ? {...task, assignee, status: task.status === 'done' ? 'done' : 'queued'} : task);
      if (!persist(next)) return;
    }
    render(); feedback(`Task moved to ${displayName(assignee)}.`);
  }
  async function reviewTask(task,action,comments=''){
    try{
      if(server){const saved=await call('PATCH',`/api/tasks/${task.id}`,{action,feedback:comments,version:task.version||0});apply(tasks.map(t=>t.id===task.id?saved:t));}
      else{
        const next=tasks.map(t=>t.id===task.id?{...t,status:action==='approve'?'done':'queued',feedback:comments,version:(t.version||0)+1,updatedAt:new Date().toISOString()}:t);
        if(!persist(next))return;
        changed(task.assignee,action==='approve'?'done':'queued',task.title);
      }
      draftClear(draftKey(task,'review'));render();feedback(action==='approve'?'Draft approved.':'Revision requested. The previous draft stays in history.');
    }catch(error){feedback(error.message);}
  }
  function reviewControls(task,article){
    article.append(node('div',task.result,'task-result'));
    const approve=action('Approve & finish',()=>reviewTask(task,'approve'));approve.className='task-primary';article.append(approve);
    const form=node('form'),label=node('label','Revision comments'),input=node('textarea'),key=draftKey(task,'review');
    input.id=`review-${task.id}`;label.htmlFor=input.id;input.required=true;input.maxLength=5000;input.rows=3;input.value=draftRead(key);
    input.oninput=()=>{input.setCustomValidity('');draftWrite(key,input.value);};
    const submit=node('button','Request revision');submit.type='submit';
    form.append(label,input,submit);form.onsubmit=e=>{e.preventDefault();if(!input.value.trim()){input.setCustomValidity('Describe the changes needed.');input.reportValidity();return;}reviewTask(task,'revise',input.value.trim());};article.append(form);
  }
  // An agent that asked instead of guessing: show its questions and take the answers.
  async function answerTask(task,answer){
    try{const saved=await call('PATCH',`/api/tasks/${task.id}`,{action:'answer',answer,version:task.version||0});apply(tasks.map(t=>t.id===task.id?saved:t));draftClear(draftKey(task,'answer'));render();feedback(`Answer sent. ${displayName(task.assignee)} picks the task up again.`);}
    catch(error){feedback(error.message);}
  }
  function answerControls(task,article){
    article.append(node('p',`${displayName(task.assignee)} needs more information before drafting:`,'task-agent'),node('div',task.questions,'task-result task-questions'));
    const form=node('form'),label=node('label','Your answer'),input=node('textarea'),key=draftKey(task,'answer');
    input.id=`answer-${task.id}`;label.htmlFor=input.id;input.required=true;input.maxLength=3000;input.rows=3;input.value=draftRead(key);
    input.oninput=()=>{input.setCustomValidity('');draftWrite(key,input.value);};
    const submit=node('button','Send answer');submit.type='submit';submit.className='task-primary';submit.style.marginTop='12px';
    form.append(label,input,submit);form.onsubmit=e=>{e.preventDefault();if(!input.value.trim()){input.setCustomValidity('Write an answer first.');input.reportValidity();return;}answerTask(task,input.value.trim());};
    article.append(form);
  }
  function agentActions(task, article, actions) {
    const agent = agentFor(task.assignee);
    if (task.status === 'blocked') {
      answerControls(task, article);
      actions.append(action('Mark done', () => update(task.id, 'done', 'Marked done by user (bypassed questions).')));
    }
    else if (task.status === 'queued' && task.error) {
      article.append(node('p', `The agent could not finish: ${task.error}`, 'task-error'));
      actions.append(action('Try again', () => update(task.id, 'queued')));
    } else if (task.status === 'queued') article.append(node('p', 'Waiting for the AI agent to pick this up.', 'task-agent'));
    else if (task.status === 'active') {
      const logText = task.workerLog ? task.workerLog.trim() : '';
      if (logText) {
        const details = node('details');
        const summary = node('summary', agent.mode === 'claude' ? 'The AI agent is working on this…' : 'Dry run in progress…');
        summary.className = 'task-agent task-agent-summary';
        const logBox = node('div', logText, 'task-worker-log');
        details.append(summary, logBox);
        article.append(details);
      } else {
        const details = node('details');
        const summary = node('summary', agent.mode === 'claude' ? 'The AI agent is working on this…' : 'Dry run in progress…');
        summary.className = 'task-agent task-agent-summary';
        const logBox = node('div', 'Initializing worker...', 'task-worker-log');
        details.append(summary, logBox);
        article.append(details);
      }
    }
    else {
      article.append(node('p', task.by === 'dry-run' ? 'Dry run result, not AI output. Review before use.' : task.by ? `Draft by Claude (${task.by}). Review before use.` : 'Result', 'task-agent'));
      if(task.status==='review')reviewControls(task,article);else article.append(node('div', task.result, 'task-result'));
    }
    actions.append(action('Archive', () => archiveTask(task)));
    article.append(actions);
  }
  const announce = () => document.dispatchEvent(new CustomEvent('officetasks:change'));
  let expandedTaskId = null;
  function render() {
    const focused=el('taskList').contains(document.activeElement)&&document.activeElement.tagName==='TEXTAREA'?{id:document.activeElement.id,start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd}:null;
    announce();
    const list = el('taskList'); list.replaceChildren();
    const done = tasks.filter(t => t.status === 'done').length;
    el('taskCount').textContent = tasks.length - done;
    el('taskSummary').textContent = `${tasks.length} tasks · ${done} done`;
    el('exportTasks').disabled = tasks.length === 0;

    const cols = {
      queued: node('div', undefined, 'kanban-column'),
      active: node('div', undefined, 'kanban-column'),
      blocked: node('div', undefined, 'kanban-column'),
      review: node('div', undefined, 'kanban-column'),
      done: node('div', undefined, 'kanban-column')
    };
    Object.keys(cols).forEach(s => {
      cols[s].append(node('h3', states[s], 'kanban-col-title'));
      list.append(cols[s]);
    });

    const visible = tasks.filter(t => (el('taskFilter').value === 'all' || t.status === el('taskFilter').value) &&
      (el('agentFilter').value === 'all' || t.assignee === el('agentFilter').value))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    
    for (const task of visible) {
      const agent = agentFor(task.assignee);
      const card = node('div', undefined, 'kanban-card');
      card.onclick = (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT' || e.target.closest('form') || e.target.tagName === 'SUMMARY' || e.target.closest('details')) return;
        expandedTaskId = expandedTaskId === task.id ? null : task.id;
        render();
      };
      const timeStr = task.updatedAt ? humanTime(task.updatedAt) : (task.createdAt ? humanTime(task.createdAt) : '');
      const metaText = `${displayName(task.assignee)}${agent ? ` · AI agent` : ''}${timeStr ? ` · ${timeStr}` : ''}`;
      card.append(node('h4', task.title), node('div', metaText, 'task-meta'));
      
      if (expandedTaskId === task.id) {
        const article = node('article', undefined, 'task-item');
        article.onclick = e => e.stopPropagation();
        if (task.brief) article.append(node('p', task.brief));
        if(task.history?.length){const history=node('details'),summary=node('summary',`Draft history (${task.history.length})`);history.append(summary);task.history.forEach((draft,i)=>{history.append(node('h4',`Draft ${i+1} · ${draft.by||'Saved'}`));if(draft.feedback)history.append(node('p',`Revision brief: ${draft.feedback}`));history.append(node('div',draft.result,'task-result'));});article.append(history);}
        const actions = node('div', undefined, 'task-actions');
        if (!team.some(person => person.n === task.assignee)) {
          article.append(node('p', 'This assignee comes from an old prototype. Pick a team member to continue.'));
          const select = node('select'); select.setAttribute('aria-label', `New assignee for ${task.title}`);
          for (const person of team) { const option = node('option', displayName(person.n)); option.value = person.n; select.append(option); }
          actions.append(action('Move task', () => reassign(task.id, select.value)));
          if (task.result) article.append(node('div', task.result, 'task-result'));
          article.append(select, actions); card.append(article);
          if(cols[task.status]) cols[task.status].append(card); continue;
        }
        actions.append(action('Show character', () => { el('taskDialog').close(); locate(task.assignee); }));
        if (agent) { agentActions(task, article, actions); card.append(article); if(cols[task.status]) cols[task.status].append(card); continue; }
        if(task.status==='review'){reviewControls(task,article); actions.append(action('Archive', () => archiveTask(task))); article.append(actions);card.append(article); if(cols[task.status]) cols[task.status].append(card); continue;}
        if (task.status === 'queued') actions.append(action('Start task', () => update(task.id, 'active')));
        if (task.status === 'active') {
          actions.append(action('Back to queue', () => update(task.id, 'queued')));
          const form = node('form');
          const label = node('label', 'Result'); label.htmlFor = `result-${task.id}`;
          const input = node('textarea'); input.id = label.htmlFor; input.required = true; input.maxLength = 10000; input.rows = 3;
          const key=draftKey(task,'result');input.value=draftRead(key);
          input.placeholder = 'Write the result or a document link before finishing the task';
          const submit = node('button', 'Save result & finish'); submit.type = 'submit'; submit.className = 'task-primary';
          const footer = node('div', undefined, 'task-actions'); footer.append(submit);
          form.append(label, input, footer);
          form.onsubmit = event => {
            event.preventDefault();
            if (!input.value.trim()) { input.setCustomValidity('Fill in the result first.'); input.reportValidity(); return; }
            update(task.id, 'done', input.value.trim());
          };
          input.oninput = () => {input.setCustomValidity('');draftWrite(key,input.value);};
          actions.append(action('Archive', () => archiveTask(task)));
          article.append(actions, form);
        } else {
          if (task.status === 'done') article.append(node('div', task.result, 'task-result'));
          actions.append(action('Archive', () => archiveTask(task)));
          article.append(actions);
        }
        card.append(article);
      }
      if(cols[task.status]) cols[task.status].append(card);
    }
    if(focused){const input=document.getElementById(focused.id);if(input){input.focus({preventScroll:true});input.setSelectionRange(focused.start,focused.end);}}
  }

  // Look for the server once at start. A static host (or no server) keeps the browser-only behaviour.
  async function connect() {
    let info;
    try {
      const response = await fetch('/api/agents', {cache: 'no-store'});
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return;
      info = await response.json();
      
      const boardsRes = await fetch('/api/boards', {cache: 'no-store'}).catch(() => null);
      if (boardsRes && boardsRes.ok) {
        const boards = await boardsRes.json();
        const select = document.getElementById('boardSelect');
        if (select) {
          select.innerHTML = '<option value="">Local Only (No Hermes)</option>';
          boards.forEach(b => {
            const option = document.createElement('option');
            option.value = b.slug;
            option.textContent = b.name + (b.is_current ? ' (Current)' : '');
            if (b.is_current) option.selected = true;
            select.append(option);
          });
        }
      }
    } catch { return; }
    let list = await call('GET', '/api/tasks').catch(() => null);
    if (!list) return;
    // First visit with the server: carry over tasks this browser saved before, if the server has none.
    if (!list.length && storageHealthy && tasks.length) {
      list = await call('POST', '/api/tasks/import', tasks).then(imported => { feedback(`${imported.length} tasks from this browser moved to the server.`); return imported; }).catch(() => list);
    }
    server = info;
    tasks = list;
    const names = Object.keys(info.members).map(displayName).join(', ');
    el('taskNote').textContent = info.mode === 'claude'
      ? `${names} works with Claude and submits drafts for your review. Everyone else is a simulation; change their status by hand.`
      : `${names} is connected in dry-run mode (no API key yet), so results are placeholders. Everyone else is a simulation; change their status by hand.`;
    el('saveNote').textContent = 'Saved on the Kantor Kita server. Export tasks to keep a copy.';
    render();
    tasks.filter(t => t.status === 'active' && team.some(person => person.n === t.assignee)).forEach(t => changed(t.assignee));
    document.dispatchEvent(new CustomEvent('officetasks:server', {detail: info}));
    setInterval(async () => {
      if(polling||writing)return;polling=true;const ticket=mutation;
      const latest = await call('GET', '/api/tasks').catch(() => null);
      polling=false;if(ticket!==mutation)return;
      if (!latest || JSON.stringify(latest) === JSON.stringify(tasks)) return;
      apply(latest);render();
    }, 2500);
  }
  window.officeTasks = {
    activeFor: name => tasks.find(t => t.assignee === name && t.status === 'active'),
    list: () => tasks.map(t => ({...t})),
    agentFor,
    open(name, status = 'all') {
      if (name) el('taskAssignee').value = name;
      el('agentFilter').value = name || 'all';
      el('taskFilter').value = status; render();
      el('taskDialog').showModal();
      el('taskTitle').focus();
    },
    init(people, onChange, onLocate) {
      team = people; changed = onChange; locate = onLocate;
      for (const person of team) {
        for (const id of ['taskAssignee', 'agentFilter']) {
          const option = node('option', `${displayName(person.n)} · ${person.role}`); option.value = person.n; el(id).append(option);
        }
      }
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (!Array.isArray(parsed) || !parsed.every(validTask) || new Set(parsed.map(t => t.id)).size !== parsed.length ||
            new Set(parsed.filter(t => t.status === 'active').map(t => t.assignee)).size !== parsed.filter(t => t.status === 'active').length) throw new Error('Invalid task data');
          tasks = parsed;
        }
      } catch { storageHealthy = false; feedback('Task data cannot be read. The old data is kept; changes are blocked.'); }
      for (const name of new Set(tasks.filter(task => !team.some(person => person.n === task.assignee)).map(task => task.assignee))) {
        const option = node('option', `${name} (old prototype)`); option.value = name; el('agentFilter').append(option);
      }
      el('closeTasks').onclick = () => el('taskDialog').close();
      el('taskFilter').onchange = render; el('agentFilter').onchange = render;
      const bs = document.getElementById('boardSelect');
      if (bs) bs.onchange = async () => { tasks = []; render(); const latest = await call('GET', '/api/tasks').catch(()=>[]); apply(latest); render(); };
      el('taskForm').onsubmit = async event => {
        event.preventDefault();
        const title = el('taskTitle').value.trim();
        if (!title) { el('taskTitle').setCustomValidity('Enter a task name.'); el('taskTitle').reportValidity(); return; }
        
        const assignee = el('taskAssignee').value;
        const workspace = el('taskWorkspace').value;
        const board = document.getElementById('boardSelect')?.value;
        
        if (!board && !assignee) {
          el('taskAssignee').setCustomValidity('Local tasks require an assignee.');
          el('taskAssignee').reportValidity();
          return;
        } else {
          el('taskAssignee').setCustomValidity('');
        }
        
        const draft = {title, assignee, workspace, brief: el('taskBrief').value.trim(), status: 'queued', result: ''};
        let task;
        if (server) {
          try { task = await call('POST', '/api/tasks', draft); tasks = [task, ...tasks]; if (task.status !== 'queued') changed(task.assignee, task.status, task.title); }
          catch (error) { feedback(error.message); return; }
        } else {
          task = {id: crypto.randomUUID(), ...draft, createdAt: new Date().toISOString()};
          if (!persist([task, ...tasks])) return;
        }
        el('taskTitle').value = ''; el('taskBrief').value = '';
        el('agentFilter').value = 'all'; el('taskFilter').value = 'all';
        render(); 
        const msgName = task.assignee ? displayName(task.assignee) : 'dispatcher';
        feedback(`Task added for ${msgName}${agentFor(task.assignee) ? '. The AI agent will pick it up.' : '.'}`); 
        el('taskTitle').focus();
      };
      el('taskTitle').oninput = () => el('taskTitle').setCustomValidity('');
      el('taskAssignee').oninput = () => el('taskAssignee').setCustomValidity('');
      el('exportTasks').onclick = () => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(tasks, null, 2)], {type: 'application/json'}));
        const link = node('a'); link.href = url; link.download = 'kantor-ai-tasks.json'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000); feedback('Task copy exported.');
      };
      render();
      tasks.filter(t => t.status === 'active' && team.some(person => person.n === t.assignee)).forEach(t => changed(t.assignee));
      connect();
    }
  };
})();
