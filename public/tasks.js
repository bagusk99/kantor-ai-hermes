(() => {
  const states = {queued: 'Queued', active: 'In progress', blocked: 'Needs decision', review: 'Needs review', done: 'Done'};
  const el = id => document.getElementById(id);
  let tasks = [], team = [], changed, locate;
  let mutation=0,polling=false,writing=0;
  // What each agent is doing right now, from Hermes tool-call events.
  const activity = new Map();
  const drafts=new Map();
  const draftKey=(task,kind)=>`${kind}:${task.id}:${kind==='result'?'result':(task.version||0)}`;
  function draftRead(key){if(drafts.has(key))return drafts.get(key);try{return sessionStorage.getItem('kantor-draft:'+key)||'';}catch{return '';}}
  function draftWrite(key,value){drafts.set(key,value);try{sessionStorage.setItem('kantor-draft:'+key,value);}catch{feedback('Draft is kept in this tab only; browser storage is unavailable.');}}
  function draftClear(key){drafts.delete(key);try{sessionStorage.removeItem('kantor-draft:'+key);}catch{}}

  // Tasks live on the Hermes kanban board; every member is a Hermes profile.
  let server = null;
  let loadedBoards = [];
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
      await call('PATCH', `/api/tasks/${task.id}`, {action: 'archive'});
      tasks = tasks.filter(t => t.id !== task.id);
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
    try { const saved = await call('PATCH', `/api/tasks/${id}`, {status, result}); apply(tasks.map(t => t.id === id ? saved : t)); }
    catch (error) { feedback(error.message); return; }
    if(status==='done')draftClear(draftKey(task,'result'));
    render(); feedback(`Task status: ${states[status]}.`);
    el('taskFilter').focus();
  }
  async function reassign(id, assignee) {
    if (!team.some(person => person.n === assignee)) return;
    try { const saved = await call('PATCH', `/api/tasks/${id}`, {assignee}); apply(tasks.map(t => t.id === id ? saved : t)); }
    catch (error) { feedback(error.message); return; }
    render(); feedback(`Task moved to ${displayName(assignee)}.`);
  }
  async function reviewTask(task,action,comments=''){
    try{
      const saved=await call('PATCH',`/api/tasks/${task.id}`,{action,feedback:comments,version:task.version||0});apply(tasks.map(t=>t.id===task.id?saved:t));
      draftClear(draftKey(task,'review'));render();feedback(action==='approve'?'Draft approved.':'Revision requested. The previous draft stays in history.');
    }catch(error){feedback(error.message);}
  }
  function reviewControls(task,article){
    article.append(node('div',task.result,'task-result'));
    const approve=action('Approve & finish',()=>reviewTask(task,'approve'));approve.className='task-primary';article.append(approve);
    const form=node('form'),label=node('label','Revision comments'),input=node('textarea'),key=draftKey(task,'review');
    input.id=`review-${task.id}`;label.htmlFor=input.id;input.required=true;input.rows=3;input.value=draftRead(key);
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
    input.id=`answer-${task.id}`;label.htmlFor=input.id;input.required=true;input.rows=3;input.value=draftRead(key);
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
      const details = node('details');
      const summary = node('summary', activity.get(task.assignee) || 'The AI agent is working on this…');
      summary.className = 'task-agent task-agent-summary';
      const logBox = node('div', logText ? logText : 'Initializing worker...', 'task-worker-log');
      logBox.id = `log-box-${task.id}`;
      
      if (expandedTaskLogs.has(task.id)) details.open = true;
      
      details.ontoggle = () => {
        if (details.open) {
          expandedTaskLogs.add(task.id);
          setTimeout(() => {
            const box = document.getElementById(`log-box-${task.id}`);
            if (box) box.scrollTop = box.scrollHeight;
          }, 0);
        } else {
          expandedTaskLogs.delete(task.id);
        }
      };
      
      details.append(summary, logBox);
      article.append(details);
    }
    else {
      article.append(node('p', task.status === 'review' ? `Draft by ${displayName(task.assignee)} (${agent.model}). Review before use.` : 'Result', 'task-agent'));
      if(task.status==='review')reviewControls(task,article);else article.append(node('div', task.result, 'task-result'));
      if (task.metadata?.commit || task.metadata?.changed_files?.length) {
        const meta = node('div', undefined, 'task-meta');
        meta.style.marginTop = '8px';
        const parts = [];
        if (task.metadata.commit) parts.push(`Commit: ${task.metadata.commit}`);
        if (task.metadata.changed_files?.length) parts.push(`${task.metadata.changed_files.length} file(s) changed`);
        if (task.metadata.tests_run) parts.push(`${task.metadata.tests_run} tests run`);
        meta.textContent = parts.join(' · ');
        article.append(meta);
      }
    }
    actions.append(action('Archive', () => archiveTask(task)));
    article.append(actions);
  }
  const announce = () => document.dispatchEvent(new CustomEvent('officetasks:change'));
  let expandedTaskId = null;
  let expandedTaskLogs = new Set();
  let expandedTaskHistory = new Set();

  async function loadTaskDetail(id) {
    if (!server) return;
    try {
      const fullTask = await call('GET', `/api/tasks/${id}`);
      if (fullTask && fullTask.id === id) {
        const idx = tasks.findIndex(t => t.id === id);
        if (idx !== -1) {
          tasks[idx] = { ...tasks[idx], ...fullTask, fullLoaded: true };
          if (expandedTaskId === id) render();
        }
      }
    } catch(e) {}
  }

  function render() {
    const focused=el('taskList').contains(document.activeElement)&&document.activeElement.tagName==='TEXTAREA'?{id:document.activeElement.id,start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd}:null;
    announce();
    const list = el('taskList');
    if (!list) return;

    // Snapshot scroll positions before DOM manipulation
    const colScrolls = {};
    for (const col of list.querySelectorAll('.kanban-column')) {
      const s = col.dataset.status;
      if (s) colScrolls[s] = col.scrollTop;
    }
    const boardScrollLeft = list.scrollLeft;
    const dialog = el('taskDialog');
    const dialogScrollTop = dialog ? dialog.scrollTop : 0;

    const logBoxStates = new Map();
    for (const taskId of expandedTaskLogs) {
      const box = document.getElementById(`log-box-${taskId}`);
      if (box) {
        const isNearBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 40;
        logBoxStates.set(taskId, { scrollTop: box.scrollTop, isNearBottom });
      }
    }

    const done = tasks.filter(t => t.status === 'done').length;
    el('taskCount').textContent = tasks.length - done;
    el('taskSummary').textContent = `${tasks.length} tasks · ${done} done`;
    el('exportTasks').disabled = tasks.length === 0;

    const cols = {};
    const existingCols = list.querySelectorAll('.kanban-column');
    if (existingCols.length === Object.keys(states).length) {
      existingCols.forEach(col => {
        const s = col.dataset.status;
        if (s) {
          cols[s] = col;
          while (col.children.length > 1) {
            col.lastChild.remove();
          }
        }
      });
    } else {
      list.replaceChildren();
      Object.keys(states).forEach(s => {
        const col = node('div', undefined, 'kanban-column');
        col.dataset.status = s;
        col.append(node('h3', states[s], 'kanban-col-title'));
        cols[s] = col;
        list.append(col);
      });
    }

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
        if (expandedTaskId === task.id && server && (!task.fullLoaded || !task.result || task.result.length <= 200)) {
          loadTaskDetail(task.id);
        }
      };
      const timeStr = task.updatedAt ? humanTime(task.updatedAt) : (task.createdAt ? humanTime(task.createdAt) : '');
      const metaText = `${displayName(task.assignee)}${agent ? ` · AI agent` : ''}${timeStr ? ` · ${timeStr}` : ''}`;
      card.append(node('h4', task.title), node('div', metaText, 'task-meta'));
      
      if (expandedTaskId === task.id) {
        const article = node('article', undefined, 'task-item');
        article.onclick = e => e.stopPropagation();
        
        let wsText = task.workspace ? `Workspace: ${task.workspace}` : '';
        if (task.absolutePath) wsText += wsText ? ` — ${task.absolutePath}` : `Path: ${task.absolutePath}`;
        if (wsText) article.append(node('div', wsText, 'task-meta'));
        
        if (task.brief) article.append(node('p', task.brief));
        if(task.history?.length) {
          const history = node('details'), summary = node('summary', `Draft history (${task.history.length})`);
          if (expandedTaskHistory.has(task.id)) history.open = true;
          history.ontoggle = () => {
            if (history.open) expandedTaskHistory.add(task.id);
            else expandedTaskHistory.delete(task.id);
          };
          history.append(summary);
          task.history.forEach((draft, i) => {
            history.append(node('h4', `Draft ${i+1} · ${draft.by || 'Saved'}`));
            if (draft.feedback) history.append(node('p', `Revision brief: ${draft.feedback}`));
            history.append(node('div', draft.result, 'task-result'));
          });
          article.append(history);
        }
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
          const input = node('textarea'); input.id = label.htmlFor; input.required = true; input.rows = 3;
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
          if (task.status === 'done') {
            article.append(node('div', task.result, 'task-result'));
            if (task.metadata?.commit || task.metadata?.changed_files?.length) {
              const meta = node('div', undefined, 'task-meta');
              meta.style.marginTop = '8px';
              const parts = [];
              if (task.metadata.commit) parts.push(`Commit: ${task.metadata.commit}`);
              if (task.metadata.changed_files?.length) parts.push(`${task.metadata.changed_files.length} file(s) changed`);
              if (task.metadata.tests_run) parts.push(`${task.metadata.tests_run} tests run`);
              meta.textContent = parts.join(' · ');
              article.append(meta);
            }
          }
          actions.append(action('Archive', () => archiveTask(task)));
          article.append(actions);
        }
        card.append(article);
      }
      if(cols[task.status]) cols[task.status].append(card);
    }
    if(focused){const input=document.getElementById(focused.id);if(input){input.focus({preventScroll:true});input.setSelectionRange(focused.start,focused.end);}}
    
    // Restore column vertical scroll positions
    Object.keys(cols).forEach(s => {
      if (colScrolls[s] !== undefined && cols[s]) {
        cols[s].scrollTop = colScrolls[s];
      }
    });

    // Restore board horizontal scroll
    if (boardScrollLeft) list.scrollLeft = boardScrollLeft;

    // Restore dialog scroll
    if (dialog && dialogScrollTop) dialog.scrollTop = dialogScrollTop;

    // Restore worker log scroll
    for (const taskId of expandedTaskLogs) {
      const box = document.getElementById(`log-box-${taskId}`);
      if (box) {
        const state = logBoxStates.get(taskId);
        if (!state || state.isNearBottom) {
          box.scrollTop = box.scrollHeight;
        } else {
          box.scrollTop = state.scrollTop;
        }
      }
    }
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
        loadedBoards = boards;
        const select = document.getElementById('boardSelect');
        if (select) {
          select.replaceChildren();
          boards.forEach(b => {
            const option = document.createElement('option');
            option.value = b.slug;
            option.dataset.workdir = b.default_workdir || '';
            option.textContent = (b.icon ? b.icon + ' ' : '') + b.name + (b.is_current ? ' (Current)' : '');
            if (b.is_current) option.selected = true;
            select.append(option);
          });
          if (el('btnBoardOptions')) el('btnBoardOptions').style.display = select.value ? 'flex' : 'none';
        }
      }
    } catch { return; }
    const list = await call('GET', '/api/tasks').catch(() => null);
    if (!list) return;
    const first = !server;
    server = info;
    tasks = list;
    const names = Object.keys(info.members).map(displayName).join(', ');
    el('taskNote').textContent = names
      ? `${names} work as Hermes agents and submit drafts for your review.`
      : 'No Hermes profiles yet. Add one with + New profile.';
    el('saveNote').textContent = 'Saved on the Hermes kanban board. Export tasks to keep a copy.';
    render();
    tasks.filter(t => t.status === 'active' && team.some(person => person.n === t.assignee)).forEach(t => changed(t.assignee));
    document.dispatchEvent(new CustomEvent('officetasks:server', {detail: info}));
    // connect() runs again after board edits; the poll and the event stream start once.
    if (!first) return;
    function isOnlyLogUpdate(prevList, nextList) {
      if (!prevList || !nextList || prevList.length !== nextList.length) return false;
      for (let i = 0; i < prevList.length; i++) {
        const a = prevList[i], b = nextList[i];
        if (a.id !== b.id || a.status !== b.status || a.assignee !== b.assignee || a.title !== b.title || a.error !== b.error) {
          return false;
        }
      }
      return true;
    }

    async function refresh() {
      if(polling||writing)return;polling=true;const ticket=mutation;
      const latest = await call('GET', '/api/tasks').catch(() => null);
      polling=false;if(ticket!==mutation)return;
      if (!latest || JSON.stringify(latest) === JSON.stringify(tasks)) return;

      if (isOnlyLogUpdate(tasks, latest)) {
        tasks = latest;
        for (const t of latest) {
          if (t.status === 'active' && t.workerLog) {
            const box = document.getElementById(`log-box-${t.id}`);
            if (box) {
              const isNearBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 40;
              const logText = t.workerLog.trim() || 'Initializing worker...';
              if (box.textContent !== logText) {
                box.textContent = logText;
                if (isNearBottom) {
                  box.scrollTop = box.scrollHeight;
                }
              }
            }
          }
        }
        return;
      }

      apply(latest);render();
    }
    setInterval(refresh, 2500);
    // Hermes webhook events, relayed by the server: refresh at once instead of waiting for the next poll.
    new EventSource('/api/events').onmessage = message => {
      const event = JSON.parse(message.data);
      if (event.event === 'pre_tool_call' && event.profile && event.tool) activity.set(event.profile, `Using ${event.tool}…`);
      if (event.event.startsWith('kanban_task_')) {
        if (event.event !== 'kanban_task_claimed') activity.delete(event.profile);
        refresh();
      }
    };
  }
  window.officeTasks = {
    activeFor: name => { const task = tasks.find(t => t.assignee === name && t.status === 'active'); return task && activity.has(name) ? {...task, activity_message: activity.get(name)} : task; },
    list: () => tasks.map(t => ({...t})),
    agentFor,
    open(name, status = 'all') {
      if (name) el('taskAssignee').value = name;
      el('agentFilter').value = name || 'all';
      el('taskFilter').value = status; render();
      const bs = el('boardSelect');
      const info = el('activeBoardInfo');
      if (bs && bs.value) {
        const board = loadedBoards.find(b => b.slug === bs.value);
        if (board && info) {
          info.style.display = 'block';
          el('activeBoardName').textContent = board.name || board.slug;
        } else if (info) {
          info.style.display = 'none';
        }
      } else if (info) {
        info.style.display = 'none';
      }
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
      el('closeTasks').onclick = () => el('taskDialog').close();
      el('taskFilter').onchange = render; el('agentFilter').onchange = render;

      if (el('btnBoardOptions')) {
        el('btnBoardOptions').onclick = (e) => {
          e.stopPropagation();
          const menu = el('boardOptionsMenu');
          if (menu) menu.style.display = menu.style.display === 'flex' ? 'none' : 'flex';
        };
        document.addEventListener('click', () => {
          if (el('boardOptionsMenu')) el('boardOptionsMenu').style.display = 'none';
        });
      }

      if (el('btnCreateBoard')) el('btnCreateBoard').onclick = () => { 
        el('createBoardHeading').textContent = 'Create New Board';
        document.querySelector('#createBoardForm button[type="submit"]').textContent = 'Create Board';
        el('createBoardForm').dataset.mode = 'create';
        el('createBoardForm').reset();
        el('cbSlug').readOnly = false;
        el('cbSlug').style.opacity = '1';
        el('cbName').dataset.auto = 'true';
        el('createBoardFeedback').textContent = ''; 
        el('createBoardDialog').showModal(); 
      };

      if (el('btnEditBoard')) el('btnEditBoard').onclick = () => {
        if (!bs || !bs.value) return;
        const board = loadedBoards.find(b => b.slug === bs.value);
        if (!board) return;
        
        el('createBoardHeading').textContent = 'Edit Board';
        document.querySelector('#createBoardForm button[type="submit"]').textContent = 'Save Changes';
        el('createBoardForm').dataset.mode = 'edit';
        
        el('cbSlug').value = board.slug;
        el('cbSlug').readOnly = true;
        el('cbSlug').style.opacity = '0.6';
        
        el('cbName').value = board.name || '';
        el('cbName').dataset.auto = 'false';
        
        el('cbDesc').value = board.description || '';
        el('cbProjectDir').value = board.default_workdir || '';
        el('cbIcon').value = board.icon || '';
        
        el('createBoardFeedback').textContent = '';
        el('createBoardDialog').showModal();
      };

      if (el('btnDeleteBoard')) el('btnDeleteBoard').onclick = async () => {
        if (!bs || !bs.value) return;
        const board = loadedBoards.find(b => b.slug === bs.value);
        if (!board) return;
        if (!confirm(`Are you sure you want to delete/archive the board "${board.name}"?`)) return;
        
        try {
           const res = await fetch(`/api/boards/${encodeURIComponent(board.slug)}`, { method: 'DELETE' }).then(r => r.json());
           if (res && res.error) throw new Error(res.error);
           await connect();
           if (bs) bs.onchange();
        } catch (e) {
           alert('Failed to delete board: ' + e.message);
        }
      };

      if (el('closeCreateBoard')) el('closeCreateBoard').onclick = () => el('createBoardDialog').close();
      if (el('cbSlug')) el('cbSlug').oninput = () => {
        if (!el('cbName').value || el('cbName').dataset.auto !== 'false') {
          let str = el('cbSlug').value.replace(/-/g, ' ');
          el('cbName').value = str.replace(/\b\w/g, c => c.toUpperCase());
          el('cbName').dataset.auto = 'true';
        }
      };
      if (el('cbName')) el('cbName').oninput = () => { el('cbName').dataset.auto = el('cbName').value ? 'false' : 'true'; };
      
      if (el('createBoardForm')) el('createBoardForm').onsubmit = async (event) => {
        event.preventDefault();
        const mode = el('createBoardForm').dataset.mode || 'create';
        const payload = {
          slug: el('cbSlug').value,
          name: el('cbName').value || el('cbSlug').value,
          description: el('cbDesc').value,
          default_workdir: el('cbProjectDir').value,
          icon: el('cbIcon').value
        };
        el('createBoardFeedback').style.color = 'var(--ink)';
        el('createBoardFeedback').textContent = mode === 'edit' ? 'Saving...' : 'Creating...';
        try {
          let res;
          if (mode === 'edit') {
            res = await fetch(`/api/boards/${encodeURIComponent(payload.slug)}`, {
              method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
            }).then(r => r.json());
          } else {
            res = await call('POST', '/api/boards', payload);
          }
          if (res && res.error) throw new Error(res.error);
          el('createBoardDialog').close();
          el('createBoardForm').reset();
          el('cbName').dataset.auto = 'true';
          await connect();
          if (bs) { bs.value = payload.slug; bs.onchange(); }
        } catch (e) {
          el('createBoardFeedback').style.color = '#a33a24';
          el('createBoardFeedback').textContent = 'Failed: ' + e.message;
        }
      };

      const bs = document.getElementById('boardSelect');
      if (bs) bs.onchange = async () => { 
        if (bs.value) {
          await fetch(`/api/boards/${encodeURIComponent(bs.value)}/switch`, { method: 'POST', headers: {'content-type': 'application/json'} }).catch(() => {});
        }
        tasks = []; render(); 
        const latest = await call('GET', '/api/tasks').catch(()=>[]); apply(latest); render(); 
        if (el('btnBoardOptions')) {
          el('btnBoardOptions').style.display = bs.value ? 'flex' : 'none';
        }
      };
      
      el('taskWorkspace').onchange = () => {
        const ws = el('taskWorkspace').value;
        const req = ws !== 'scratch';
        el('taskAbsPathContainer').style.display = req ? 'block' : 'none';
        const absInput = el('taskAbsPath');
        absInput.required = req;
        if (req && !absInput.value) {
            if (bs && bs.selectedIndex >= 0) {
               const opt = bs.options[bs.selectedIndex];
               if (opt && opt.dataset.workdir) absInput.value = opt.dataset.workdir;
            }
        }
      };

      el('taskForm').onsubmit = async event => {
        event.preventDefault();
        const title = el('taskTitle').value.trim();
        if (!title) { el('taskTitle').setCustomValidity('Enter a task name.'); el('taskTitle').reportValidity(); return; }
        
        const assignee = el('taskAssignee').value;
        const workspace = el('taskWorkspace').value;
        const absolutePath = el('taskAbsPath').value.trim();
        if (!server) { feedback('Hermes dashboard is not reachable. Start it with `hermes dashboard`, then reload.'); return; }
        const draft = {title, assignee, workspace, absolutePath, brief: el('taskBrief').value.trim()};
        let task;
        try { task = await call('POST', '/api/tasks', draft); tasks = [task, ...tasks]; if (task.status !== 'queued') changed(task.assignee, task.status, task.title); }
        catch (error) { feedback(error.message); return; }
        el('taskTitle').value = ''; el('taskBrief').value = '';
        el('taskAbsPath').value = '';
        el('taskWorkspace').value = 'scratch';
        if (el('taskWorkspace').onchange) el('taskWorkspace').onchange();
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
