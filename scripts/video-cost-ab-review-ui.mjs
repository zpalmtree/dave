export const REVIEW_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Blinded video cost review</title>
  <style>
    :root { color-scheme: dark; --bg:#090a0c; --panel:#14171c; --panel2:#1b1f26; --text:#f5f7fa; --muted:#9ca6b5; --line:#303743; --blue:#71a7ff; --green:#5ed6a0; --red:#ff7b83; --amber:#ffc66d; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
    button,textarea { font:inherit; }
    button { color:inherit; }
    header { position:sticky; top:0; z-index:10; display:flex; align-items:center; gap:18px; padding:14px 22px; background:rgba(9,10,12,.96); border-bottom:1px solid var(--line); backdrop-filter:blur(12px); }
    h1 { margin:0; font-size:17px; letter-spacing:.01em; }
    .privacy { color:var(--green); font-size:12px; margin-left:auto; }
    .save-status { min-width:90px; color:var(--muted); text-align:right; font-size:12px; }
    main { max-width:1600px; margin:0 auto; padding:24px; }
    .tabs,.toolbar,.choices,.actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .tabs { margin-bottom:14px; }
    button { border:1px solid var(--line); background:var(--panel); border-radius:10px; padding:9px 14px; cursor:pointer; }
    button:hover:not(:disabled) { border-color:#667085; background:#202630; }
    button:focus-visible,textarea:focus-visible,summary:focus-visible { outline:2px solid var(--blue); outline-offset:2px; }
    button:disabled { opacity:.42; cursor:not-allowed; }
    button.active { border-color:var(--blue); background:#193154; }
    button.good.active { border-color:var(--green); background:#123b2d; }
    button.bad.active { border-color:var(--red); background:#491f25; }
    button.warn.active { border-color:var(--amber); background:#493719; }
    .tab { font-weight:650; }
    .count { margin-left:6px; color:var(--muted); font-weight:400; }
    .progress-track { height:6px; overflow:hidden; border-radius:10px; background:#252a33; margin-bottom:18px; }
    .progress-bar { height:100%; background:linear-gradient(90deg,var(--blue),var(--green)); transition:width .2s; }
    .toolbar { justify-content:space-between; margin-bottom:18px; }
    .case-position { color:var(--muted); }
    .card { border:1px solid var(--line); background:var(--panel); border-radius:16px; overflow:hidden; }
    .prompt { padding:18px 22px; background:var(--panel2); border-bottom:1px solid var(--line); }
    .eyebrow { color:var(--muted); font-size:11px; letter-spacing:.1em; text-transform:uppercase; margin-bottom:5px; }
    .prompt-text { font-size:18px; font-weight:650; }
    .reviewer-grid { display:grid; grid-template-columns:minmax(0,1.6fr) minmax(320px,.75fr); min-height:630px; }
    .image-wrap { display:flex; align-items:center; justify-content:center; padding:20px; min-height:520px; background:#050608; }
    .image-wrap img { display:block; max-width:100%; max-height:72vh; object-fit:contain; border-radius:8px; }
    .decision { padding:22px; border-left:1px solid var(--line); }
    .decision h2 { margin:0 0 6px; font-size:16px; }
    .hint { color:var(--muted); font-size:13px; margin:0 0 18px; }
    .field { margin:20px 0; }
    .field-label { display:block; margin-bottom:8px; font-weight:650; }
    textarea { width:100%; min-height:90px; resize:vertical; color:var(--text); background:#0d0f13; border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
    .primary { border-color:var(--blue); background:#235391; font-weight:700; }
    .primary:hover:not(:disabled) { background:#2b63ab; }
    .actions { margin-top:22px; }
    .plans { display:grid; grid-template-columns:1fr 1fr; gap:1px; background:var(--line); }
    .plan { min-width:0; background:var(--panel); padding:20px; }
    .plan-head { position:sticky; top:59px; z-index:4; display:flex; justify-content:space-between; align-items:center; margin:-20px -20px 16px; padding:13px 20px; background:rgba(27,31,38,.97); border-bottom:1px solid var(--line); }
    .plan-label { display:inline-grid; place-items:center; width:34px; height:34px; border-radius:50%; background:#2a3445; color:var(--blue); font-size:18px; font-weight:800; }
    .section { margin:0 0 18px; }
    .section h3 { margin:0 0 7px; color:#cdd8e8; font-size:13px; letter-spacing:.04em; text-transform:uppercase; }
    .section p,.section pre { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; }
    details { margin:12px 0; border:1px solid var(--line); border-radius:10px; background:#101318; }
    summary { padding:10px 12px; cursor:pointer; font-weight:650; }
    details > div,details > pre { padding:0 12px 12px; }
    pre { font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace; color:#cbd5e1; overflow:auto; }
    .planner-decision { padding:22px; border-top:1px solid var(--line); background:var(--panel2); }
    .failure-row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    .completion { margin:26px 0 0; padding:20px; text-align:center; border:1px solid #285943; border-radius:14px; background:#0e291f; color:#b9f4d9; }
    .error { max-width:900px; margin:70px auto; padding:20px; border:1px solid var(--red); border-radius:12px; background:#34181d; }
    .read-only { color:var(--amber); }
    @media (max-width:900px) { main{padding:14px}.reviewer-grid,.plans{grid-template-columns:1fr}.decision{border-left:0;border-top:1px solid var(--line)}.plan-head{top:59px}.privacy{display:none} }
  </style>
</head>
<body>
  <header><h1>Blinded video cost review</h1><span class="privacy">Local only · identities and keys hidden</span><span class="save-status" id="save-status">Loading…</span></header>
  <main id="app" aria-live="polite"></main>
  <script>
    const params = new URLSearchParams(location.search);
    const token = params.get('token') || '';
    const app = document.querySelector('#app');
    const saveStatus = document.querySelector('#save-status');
    const state = { reviewer:null, planner:null, status:null, kind:'reviewer', index:0, dirty:false, saving:false };

    function node(tag, attrs={}, children=[]) {
      const element = document.createElement(tag);
      for (const [key,value] of Object.entries(attrs)) {
        if (key === 'class') element.className = value;
        else if (key === 'text') element.textContent = value;
        else if (key === 'onclick') element.addEventListener('click', value);
        else if (key === 'oninput') element.addEventListener('input', value);
        else if (key === 'disabled') element.disabled = Boolean(value);
        else if (key === 'checked') element.checked = Boolean(value);
        else element.setAttribute(key, value);
      }
      for (const child of [].concat(children)) if (child !== null && child !== undefined) element.append(child.nodeType ? child : document.createTextNode(String(child)));
      return element;
    }

    function endpoint(path) {
      const url = new URL(path, location.origin);
      url.searchParams.set('token', token);
      return url.toString();
    }

    async function api(path, options={}) {
      const response = await fetch(endpoint(path), { ...options, headers:{ 'content-type':'application/json', 'x-review-token':token, ...(options.headers||{}) } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || ('Request failed (' + response.status + ')'));
      return body;
    }

    function isComplete(kind, entry) {
      return kind === 'reviewer'
        ? typeof entry.human_acceptable === 'boolean' && typeof entry.material_failure === 'boolean'
        : entry.review_complete === true && ['A','B','tie'].includes(entry.human_winner);
    }

    function progress(kind) {
      const cases = state[kind]?.cases || [];
      return { complete:cases.filter(entry => isComplete(kind, entry)).length, total:cases.length };
    }

    function nextIncomplete(kind) {
      const cases = state[kind]?.cases || [];
      const index = cases.findIndex(entry => !isComplete(kind, entry));
      return index < 0 ? Math.max(0, cases.length - 1) : index;
    }

    function choice(label, selected, set, tone='') {
      return node('button', { type:'button', class:(selected ? 'active ' : '') + tone, 'aria-pressed':String(selected), onclick:set, text:label });
    }

    function markDirty() {
      state.dirty = true;
      saveStatus.textContent = 'Unsaved';
    }

    function setValue(entry, key, value) {
      entry[key] = value;
      markDirty();
      render();
    }

    function tabs() {
      const wrap = node('div', { class:'tabs', role:'tablist' });
      for (const kind of ['reviewer','planner']) {
        const p = progress(kind);
        const title = kind === 'reviewer' ? 'Image review' : 'Planner A/B';
        const button = node('button', { type:'button', role:'tab', class:'tab ' + (state.kind === kind ? 'active' : ''), 'aria-selected':String(state.kind === kind), onclick:() => { state.kind=kind; state.index=nextIncomplete(kind); render(); } }, [title, node('span',{class:'count',text:p.complete + '/' + p.total})]);
        wrap.append(button);
      }
      return wrap;
    }

    function navigation(total) {
      return node('div', { class:'toolbar' }, [
        node('button',{type:'button',disabled:state.index===0,onclick:()=>{state.index--;render();},text:'← Previous'}),
        node('span',{class:'case-position',text:'Case ' + (state.index+1) + ' of ' + total}),
        node('button',{type:'button',disabled:state.index>=total-1,onclick:()=>{state.index++;render();},text:'Next →'})
      ]);
    }

    function promptBlock(prompt) {
      return node('div',{class:'prompt'},[
        node('div',{class:'eyebrow',text:'Original video request'}),
        node('div',{class:'prompt-text',text:prompt})
      ]);
    }

    function reviewerView(entry) {
      const decisions = node('aside',{class:'decision'},[
        node('h2',{text:'Evaluate the starting frame'}),
        node('p',{class:'hint',text:'Judge the image against the request and whether it can continue into a coherent video. Automated opinions are hidden to avoid anchoring.'}),
        node('div',{class:'field'},[
          node('span',{class:'field-label',text:'Can this frame safely continue into the requested video?'}),
          node('div',{class:'choices'},[
            choice('Yes',entry.human_acceptable===true,()=>setValue(entry,'human_acceptable',true),'good'),
            choice('No',entry.human_acceptable===false,()=>setValue(entry,'human_acceptable',false),'bad')
          ])
        ]),
        node('div',{class:'field'},[
          node('span',{class:'field-label',text:'Is there a material failure?'}),
          node('div',{class:'choices'},[
            choice('No material failure',entry.material_failure===false,()=>setValue(entry,'material_failure',false),'good'),
            choice('Material failure',entry.material_failure===true,()=>setValue(entry,'material_failure',true),'bad')
          ])
        ]),
        notesField(entry),
        saveAction(entry)
      ]);
      const image = node('img',{src:endpoint(entry.image_url),alt:'Candidate starting frame for blinded human review'});
      image.addEventListener('error',()=>{ image.alt='The review image failed to load.'; });
      return node('div',{class:'card'},[promptBlock(entry.prompt),node('div',{class:'reviewer-grid'},[node('div',{class:'image-wrap'},[image]),decisions])]);
    }

    function notesField(entry) {
      const area = node('textarea',{placeholder:'Optional concise reason or concern…','aria-label':'Review notes'});
      area.value = entry.notes || '';
      area.addEventListener('input',event=>{ entry.notes=event.target.value; markDirty(); });
      return node('div',{class:'field'},[node('label',{class:'field-label',text:'Notes (optional)'}),area]);
    }

    function textSection(title, value) {
      if (!value) return null;
      return node('section',{class:'section'},[node('h3',{text:title}),node('p',{text:typeof value === 'string' ? value : JSON.stringify(value,null,2)})]);
    }

    function planView(option) {
      const plan = option.plan || {};
      const keyframe = plan.keyframe || {};
      const outline = node('div',{},[
        textSection('Intent',plan.intent),
        textSection('Continuity bible',plan.continuity_bible),
        textSection('Keyframe rationale',keyframe.reason),
        textSection('Keyframe prompt',keyframe.prompt),
        textSection('Motion contract',keyframe.motion_contract)
      ].filter(Boolean));
      const segments = node('div',{});
      (plan.segments || []).forEach((segment,index)=>{
        const detail=node('details',{},[node('summary',{text:'Segment ' + (index+1) + ': ' + (segment.title || 'Untitled')}),node('pre',{text:JSON.stringify(segment,null,2)})]);
        segments.append(detail);
      });
      const raw = node('details',{},[node('summary',{text:'Full plan JSON'}),node('pre',{text:JSON.stringify(plan,null,2)})]);
      return node('article',{class:'plan'},[
        node('div',{class:'plan-head'},[node('span',{text:'Candidate plan'}),node('span',{class:'plan-label',text:option.label})]),
        outline,
        segments,
        raw
      ]);
    }

    function plannerView(entry) {
      const optionA = entry.options.find(option=>option.label==='A');
      const optionB = entry.options.find(option=>option.label==='B');
      const failures = entry.material_failures || [];
      const decision = node('div',{class:'planner-decision'},[
        node('div',{class:'eyebrow',text:'Your blinded decision'}),
        node('div',{class:'field'},[
          node('span',{class:'field-label',text:'Which plan would produce the better video?'}),
          node('div',{class:'choices'},[
            choice('Plan A',entry.human_winner==='A',()=>setValue(entry,'human_winner','A')),
            choice('Plan B',entry.human_winner==='B',()=>setValue(entry,'human_winner','B')),
            choice('Tie',entry.human_winner==='tie',()=>setValue(entry,'human_winner','tie'),'warn')
          ])
        ]),
        node('div',{class:'field'},[
          node('span',{class:'field-label',text:'Does either plan have a material failure?'}),
          node('div',{class:'failure-row'},[
            choice('Failure in A',failures.includes('A'),()=>toggleFailure(entry,'A'),'bad'),
            choice('Failure in B',failures.includes('B'),()=>toggleFailure(entry,'B'),'bad'),
            node('span',{class:'hint',text:failures.length ? 'Selected labels are material failures.' : 'Neither selected.'})
          ])
        ]),
        notesField(entry),
        saveAction(entry)
      ]);
      return node('div',{class:'card'},[promptBlock(entry.prompt),node('div',{class:'plans'},[planView(optionA),planView(optionB)]),decision]);
    }

    function toggleFailure(entry,label) {
      const values = new Set(entry.material_failures || []);
      values.has(label) ? values.delete(label) : values.add(label);
      entry.material_failures = [...values].sort();
      markDirty();
      render();
    }

    function saveAction(entry) {
      const ready = state.kind === 'reviewer'
        ? typeof entry.human_acceptable === 'boolean' && typeof entry.material_failure === 'boolean'
        : ['A','B','tie'].includes(entry.human_winner);
      return node('div',{class:'actions'},[
        node('button',{type:'button',class:'primary',disabled:!ready || state.saving || state.status.read_only,onclick:saveAndNext,text:state.status.read_only ? 'Read-only verification' : 'Save decision & next'}),
        isComplete(state.kind,entry) ? node('span',{class:'hint',text:'Saved decision'}) : null
      ]);
    }

    function ratingsPayload(kind) {
      return {
        fingerprint:state[kind].fingerprint,
        cases:state[kind].cases.map(entry=>kind==='reviewer' ? {
          public_id:entry.public_id,human_acceptable:entry.human_acceptable,material_failure:entry.material_failure,notes:entry.notes
        } : {
          public_id:entry.public_id,human_winner:entry.human_winner,material_failures:entry.material_failures,review_complete:['A','B','tie'].includes(entry.human_winner),notes:entry.notes
        })
      };
    }

    async function saveAndNext() {
      state.saving=true; saveStatus.textContent='Saving…'; render();
      try {
        state[state.kind]=await api('/api/' + state.kind,{method:'POST',body:JSON.stringify(ratingsPayload(state.kind))});
        state.dirty=false; saveStatus.textContent='Saved locally';
        const cases=state[state.kind].cases;
        const after=cases.findIndex((entry,index)=>index>state.index && !isComplete(state.kind,entry));
        const anywhere=cases.findIndex(entry=>!isComplete(state.kind,entry));
        if (after>=0) state.index=after;
        else if (anywhere>=0) state.index=anywhere;
        else if (state.kind==='reviewer' && progress('planner').complete<progress('planner').total) { state.kind='planner'; state.index=nextIncomplete('planner'); }
      } catch (error) {
        saveStatus.textContent='Save failed';
        alert(error.message);
      } finally { state.saving=false; render(); }
    }

    function render() {
      if (!state.reviewer || !state.planner) return;
      const cases=state[state.kind].cases;
      state.index=Math.max(0,Math.min(state.index,cases.length-1));
      const p=progress(state.kind);
      app.replaceChildren();
      app.append(tabs());
      app.append(node('div',{class:'progress-track','aria-label':'Review progress'},[node('div',{class:'progress-bar',style:'width:' + (p.total ? p.complete/p.total*100 : 100) + '%'})]));
      if (cases.length) {
        app.append(navigation(cases.length));
        app.append(state.kind==='reviewer' ? reviewerView(cases[state.index]) : plannerView(cases[state.index]));
      }
      const all=progress('reviewer').complete===progress('reviewer').total && progress('planner').complete===progress('planner').total;
      if (all) app.append(node('div',{class:'completion',text:'All 24 blinded decisions are saved. Return to Codex and say “review complete” so the gates can be evaluated.'}));
      if (state.status.read_only) app.prepend(node('p',{class:'read-only',text:'Verification mode: decisions cannot be saved.'}));
    }

    addEventListener('beforeunload',event=>{ if(state.dirty){ event.preventDefault(); event.returnValue=''; } });
    Promise.all([api('/api/status'),api('/api/reviewer'),api('/api/planner')]).then(([status,reviewer,planner])=>{
      state.status=status; state.reviewer=reviewer; state.planner=planner;
      if (progress('reviewer').complete===progress('reviewer').total) state.kind='planner';
      state.index=nextIncomplete(state.kind); saveStatus.textContent=status.read_only?'Read-only':'Ready'; render();
    }).catch(error=>{ saveStatus.textContent='Error'; app.replaceChildren(node('div',{class:'error',text:error.message})); });
  </script>
</body>
</html>`;
