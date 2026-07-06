/**
 * GET /admin — the operator console.
 *
 * Same trust model as the manage page: the admin secret arrives in the URL
 * FRAGMENT, is read into JS memory, and travels only in the X-Admin-Secret
 * header to /api/admin/*. The page itself is static and identical for every
 * caller — a visitor without the secret sees a friendly error, nothing more.
 * All user-controlled strings are inserted via textContent, never innerHTML.
 */

import { RATINGS, WARNING_TAGS } from '../../format';
import { htmlResponse, pageShell } from '../../html';

const ADMIN_CSS = `
.page{max-width:52rem}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr));gap:.7rem;margin:1.2rem 0}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:.8rem 1rem}
.stat .v{font-family:var(--sans);font-size:1.5rem;font-weight:600;font-variant-numeric:tabular-nums}
.stat .k{color:var(--muted);font-size:.78rem;letter-spacing:.08em;text-transform:uppercase}
.paused-banner{border:1px solid color-mix(in srgb,var(--ember) 45%,transparent);
  background:color-mix(in srgb,var(--ember) 10%,transparent);color:var(--ember);
  border-radius:12px;padding:.7rem 1rem;font-weight:600;margin:1rem 0}
.wcard{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:1rem 1.1rem;margin:.7rem 0}
.wcard.removed{opacity:.65;border-style:dashed}
.wtitle{font-family:var(--serif);font-weight:600;font-size:1.05rem;margin:0}
.wmeta{display:flex;flex-wrap:wrap;gap:.35rem .9rem;color:var(--muted);font-size:.82rem;margin:.35rem 0 .6rem}
.wmeta .nums{font-variant-numeric:tabular-nums}
.tag{display:inline-block;font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;
  padding:3px 8px;border-radius:999px;border:1px solid var(--line)}
.tag-explicit{color:var(--ember)}
.tag-mature{color:var(--amber)}
.tag-removed{color:var(--ember);border-color:color-mix(in srgb,var(--ember) 45%,transparent)}
.tag-held{color:var(--amber)}
.tag-reports{color:var(--ember);font-weight:700}
.tag-mod-hold{color:var(--ember);border-color:color-mix(in srgb,var(--ember) 45%,transparent)}
.tag-mod-tag-fix{color:var(--amber)}
.tag-mod-pass{color:var(--muted)}
.tag-mod-error{color:var(--muted);font-style:italic}
.tag-mod-skipped{color:var(--muted);font-style:italic}
.tag-shelf-listed{color:var(--violet);border-color:color-mix(in srgb,var(--violet) 45%,transparent)}
.tag-shelf-pending{color:var(--muted)}
.tag-shelf-held{color:var(--ember);border-color:color-mix(in srgb,var(--ember) 45%,transparent)}
.tag-shelf-refused{color:var(--amber)}
.hcard{background:var(--surface);border:1px solid color-mix(in srgb,var(--ember) 45%,transparent);
  border-radius:12px;padding:1rem 1.1rem;margin:.7rem 0;display:flex;flex-wrap:wrap;
  justify-content:space-between;gap:.6rem 1rem;align-items:baseline}
.hcard .hmeta{color:var(--muted);font-size:.82rem;margin:.25rem 0 0}
.acts{display:flex;flex-wrap:wrap;gap:.45rem;align-items:center}
.btn-sm{font:600 .78rem/1 var(--sans);padding:.45rem .7rem;border-radius:8px;cursor:pointer;
  border:1px solid var(--line);background:var(--surface);color:var(--ink)}
.btn-sm:disabled{opacity:.5;cursor:default}
.inline-form{display:flex;flex-wrap:wrap;gap:.45rem;align-items:center;margin:.6rem 0 0;
  padding:.6rem;border:1px dashed var(--line);border-radius:8px}
.inline-form select,.inline-form input[type=number]{
  font:inherit;font-size:.85rem;color:var(--ink);background:var(--surface);
  border:1px solid var(--line);border-radius:6px;padding:.3rem .45rem}
.inline-form input[type=number]{width:5rem}
.warnbox{display:flex;flex-wrap:wrap;gap:.25rem .8rem;font-size:.8rem}
.warnbox label{display:inline-flex;gap:.3rem;align-items:center;white-space:nowrap}
.rcard{border-left:3px solid var(--ember);padding:.5rem .9rem;margin:.6rem 0;font-size:.9rem}
.rcard .rmsg{white-space:pre-wrap;overflow-wrap:break-word;margin:.25rem 0 0}
.rcard .rmeta{color:var(--muted);font-size:.8rem}
.tcard{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.5rem;align-items:baseline;
  border:1px solid var(--line);border-radius:10px;padding:.6rem .9rem;margin:.5rem 0;font-size:.85rem}
.thash{font-family:ui-monospace,monospace;font-size:.75rem;color:var(--muted);word-break:break-all}
.status{min-height:1.3rem;font-size:.85rem;color:var(--muted);margin-top:.6rem}
.empty{color:var(--muted);font-size:.9rem}
@media (min-width: 40rem){
  .wcard{display:grid;grid-template-columns:1fr auto;gap:.2rem 1rem}
  .wcard .acts{justify-self:end;align-self:start}
  .wcard .inline-form,.wcard .wfull{grid-column:1/-1}
}
`;

export function adminPage(): Response {
  const ratingsJson = JSON.stringify(RATINGS);
  const warningsJson = JSON.stringify(WARNING_TAGS);

  const body = `<div class="page">
<h1>The Shelf — operator</h1>
<p class="muted small">This console needs the admin link with the secret after the <code>#</code>.
The secret stays in this tab&#39;s memory and travels only as a header.</p>

<div class="card" id="loading"><p class="muted">Opening the back room&hellip;</p></div>

<div class="card" id="error" hidden>
<h2 style="margin-top:0">Nothing here</h2>
<p class="muted" id="err-text"></p>
</div>

<div id="panel" hidden>
<div id="paused-banner" class="paused-banner" hidden>Publishing is PAUSED — new works are being turned away.</div>
<div class="stats" id="stats"></div>
<div class="acts">
<button class="btn-sm" id="btn-pause" type="button"></button>
<button class="btn-sm" id="btn-refresh" type="button">Refresh</button>
</div>
<p class="status" id="status"></p>

<div id="held-section" hidden>
<h2>Needs decision</h2>
<p class="muted small">Listing requests waiting on a human. The works stay readable by link — nothing is listed until you decide.</p>
<div id="held"></div>
</div>

<h2>Recent works</h2>
<div id="works"></div>

<h2>Recent reports</h2>
<div id="reports"></div>

<h2>Tombstones</h2>
<p class="muted small">Content hashes of removed works that cannot be republished. Deleting one forgives the content.</p>
<div id="tombstones"></div>
</div>

<p class="muted small"><a href="/">The Shelf</a> · <a href="/rules">House rules</a></p>
</div>
<script>
(function(){
'use strict';
var RATINGS=${ratingsJson};
var WARNINGS=${warningsJson};
var secret=location.hash.length>1?location.hash.slice(1):'';
var state=null;
function $(x){return document.getElementById(x);}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function fmt(iso){var d=new Date(iso);return isNaN(d.getTime())?String(iso):d.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});}
function fail(msg){$('err-text').textContent=msg;$('error').hidden=false;$('panel').hidden=true;$('loading').hidden=true;}
function note(msg){$('status').textContent=msg;}
function api(path,method,body){
  var opts={method:method||'GET',headers:{'X-Admin-Secret':secret}};
  if(body!==undefined){opts.headers['content-type']='application/json';opts.body=JSON.stringify(body);}
  return fetch(path,opts).then(function(r){
    if(r.status===404)throw new Error('That secret does not open the back room. Check the full admin link.');
    if(r.status===429)throw new Error('Too many requests - wait a minute and try again.');
    var ct=r.headers.get('content-type')||'';
    if(!r.ok)return r.json().catch(function(){throw new Error('Request failed ('+r.status+').');}).then(function(b){throw new Error(b.error?'Request failed: '+b.error:'Request failed ('+r.status+').');});
    return ct.indexOf('json')>=0?r.json():r.text();
  });
}
function refresh(){
  return api('/api/admin/overview').then(function(o){
    state=o;render(o);
    $('loading').hidden=true;$('error').hidden=true;$('panel').hidden=false;
  });
}
function act(promise,okMsg){
  promise.then(function(){note(okMsg);return refresh();}).catch(function(e){note(e.message);});
}
function render(o){
  $('paused-banner').hidden=!o.publishingPaused;
  var pauseBtn=$('btn-pause');
  pauseBtn.textContent=o.publishingPaused?'Resume publishing':'Pause publishing (panic)';
  var stats=$('stats');stats.textContent='';
  var cb=o.chainBudget||{cap:0,usedToday:0};
  var pairs=[['Active',o.works.active||0],['Held',o.works.held||0],['Removed',o.works.removed||0],['Total opens',o.totalViews],['Chain today',cb.usedToday+'/'+cb.cap]];
  pairs.forEach(function(p){
    var s=el('div','stat');s.appendChild(el('div','v nums',String(p[1])));s.appendChild(el('div','k',p[0]));stats.appendChild(s);
  });
  renderHeld(o.heldListings||[]);
  renderWorks(o.recentWorks||[]);
  renderReports(o.recentReports||[]);
  renderTombstones(o.tombstones||[]);
}
function heldReasonText(l){
  if(!l||!l.reason)return 'needs review';
  if(l.reason==='manual')return 'manual review — the gate has no API key';
  if(l.reason==='review')return 'hard-line suspicion from the chain';
  if(l.reason==='error')return 'the moderation chain failed — fail-safe hold';
  return l.reason;
}
function renderHeld(list){
  $('held-section').hidden=list.length===0;
  var box=$('held');box.textContent='';
  list.forEach(function(w){
    var c=el('div','hcard');
    var left=el('div');
    var t=el('p','wtitle');
    var link=el('a',null,w.title);link.href='/w/'+w.id;link.target='_blank';link.rel='noopener';
    t.appendChild(link);
    left.appendChild(t);
    left.appendChild(el('p','hmeta','by '+w.pen_name+' · rated '+w.rating+' · '+heldReasonText(w.listing)));
    c.appendChild(left);
    var acts=el('div','acts');
    var approve=el('button','btn-sm','Approve — list it');approve.type='button';
    approve.addEventListener('click',function(){
      act(api('/api/admin/works/'+w.id+'/listing','POST',{action:'approve'}),'Listed "'+w.title+'" on the shelf.');
    });
    var deny=el('button','btn-sm','Deny');deny.type='button';
    deny.addEventListener('click',function(){
      if(!confirm('Deny the listing of "'+w.title+'"? The author sees an operator refusal; the link keeps working.'))return;
      act(api('/api/admin/works/'+w.id+'/listing','POST',{action:'deny'}),'Denied the listing of "'+w.title+'".');
    });
    acts.appendChild(approve);acts.appendChild(deny);
    c.appendChild(acts);
    box.appendChild(c);
  });
}
function renderWorks(list){
  var box=$('works');box.textContent='';
  if(list.length===0){box.appendChild(el('p','empty','No works yet.'));return;}
  list.forEach(function(w){box.appendChild(workCard(w));});
}
function workCard(w){
  var card=el('div','wcard'+(w.status==='removed'?' removed':''));
  card.id='work-'+w.id;
  var head=el('div');
  var t=el('p','wtitle');
  var link=el('a',null,w.title);link.href='/w/'+w.id;link.target='_blank';link.rel='noopener';
  t.appendChild(link);
  head.appendChild(t);
  var meta=el('div','wmeta');
  var rt=el('span','tag tag-'+w.rating,w.rating);meta.appendChild(rt);
  if(w.status!=='active')meta.appendChild(el('span','tag tag-'+w.status,w.status));
  if(w.moderation_outcome)meta.appendChild(el('span','tag tag-mod-'+w.moderation_outcome,'mod: '+w.moderation_outcome));
  if(w.listing_state)meta.appendChild(el('span','tag tag-shelf-'+w.listing_state,'shelf: '+w.listing_state));
  if(w.password_protected)meta.appendChild(el('span','tag','locked'));
  meta.appendChild(el('span',null,'by '+w.pen_name));
  meta.appendChild(el('span','nums',Number(w.word_count).toLocaleString()+' words'));
  meta.appendChild(el('span','nums',w.views+' opens'));
  if(w.report_count>0)meta.appendChild(el('span','tag tag-reports',w.report_count+' reports'));
  meta.appendChild(el('span',null,'published '+fmt(w.created_at)));
  meta.appendChild(el('span',null,'expires '+fmt(w.expires_at)));
  head.appendChild(meta);
  card.appendChild(head);

  var acts=el('div','acts');
  if(w.status==='removed'){
    var restore=el('button','btn-sm','Restore');restore.type='button';
    restore.addEventListener('click',function(){
      act(api('/api/admin/works/'+w.id+'/restore','POST'),'Restored "'+w.title+'".');
    });
    acts.appendChild(restore);
  }else{
    var remove=el('button','btn-sm','Remove');remove.type='button';
    remove.addEventListener('click',function(){
      if(!confirm('Remove "'+w.title+'"? Readers get a 404 immediately. It can be restored for 30 days.'))return;
      var tomb=confirm('Also tombstone the content so this exact text can never be republished?\\n\\nOK = tombstone, Cancel = just remove.');
      var note_=tomb?(prompt('Tombstone note (why):','')||''):'';
      act(api('/api/admin/works/'+w.id+'/remove','POST',{tombstone:tomb,note:note_}),'Removed "'+w.title+'".');
    });
    acts.appendChild(remove);
  }
  var relabelBtn=el('button','btn-sm','Re-label');relabelBtn.type='button';
  var expiryBtn=el('button','btn-sm','Expiry');expiryBtn.type='button';
  acts.appendChild(relabelBtn);acts.appendChild(expiryBtn);
  card.appendChild(acts);

  var relabelForm=el('div','inline-form');relabelForm.hidden=true;
  var sel=document.createElement('select');
  RATINGS.forEach(function(r){var o=document.createElement('option');o.value=r;o.textContent=r;if(r===w.rating)o.selected=true;sel.appendChild(o);});
  relabelForm.appendChild(sel);
  var warnbox=el('div','warnbox');
  var checks=[];
  WARNINGS.forEach(function(tag){
    var lab=el('label');var cb=document.createElement('input');cb.type='checkbox';cb.value=tag;
    lab.appendChild(cb);lab.appendChild(document.createTextNode(tag));
    warnbox.appendChild(lab);checks.push(cb);
  });
  relabelForm.appendChild(warnbox);
  var applyRl=el('button','btn-sm','Apply labels');applyRl.type='button';
  applyRl.addEventListener('click',function(){
    var warnings=checks.filter(function(c){return c.checked;}).map(function(c){return c.value;});
    act(api('/api/admin/works/'+w.id+'/relabel','POST',{rating:sel.value,warnings:warnings}),
      'Re-labeled "'+w.title+'" as '+sel.value+' and re-baked the page.');
  });
  relabelForm.appendChild(applyRl);
  relabelBtn.addEventListener('click',function(){relabelForm.hidden=!relabelForm.hidden;});
  card.appendChild(relabelForm);

  var expiryForm=el('div','inline-form');expiryForm.hidden=true;
  var days=document.createElement('input');days.type='number';days.min='1';days.max='365';days.value='30';
  expiryForm.appendChild(days);
  expiryForm.appendChild(el('span','muted small','days from now'));
  var applyEx=el('button','btn-sm','Set expiry');applyEx.type='button';
  applyEx.addEventListener('click',function(){
    var n=parseInt(days.value,10);
    if(!(n>=1&&n<=365)){note('Days must be 1-365.');return;}
    act(api('/api/admin/works/'+w.id+'/expiry','POST',{days:n}),'Expiry of "'+w.title+'" set to +'+n+' days.');
  });
  expiryForm.appendChild(applyEx);
  expiryBtn.addEventListener('click',function(){expiryForm.hidden=!expiryForm.hidden;});
  card.appendChild(expiryForm);

  return card;
}
function renderReports(list){
  var box=$('reports');box.textContent='';
  if(list.length===0){box.appendChild(el('p','empty','No reports. Quiet shelf.'));return;}
  list.forEach(function(r){
    var c=el('div','rcard');
    var head=el('div');
    head.appendChild(el('strong',null,r.reason));
    head.appendChild(document.createTextNode(' — '));
    if(r.work_title){
      var a=el('a',null,r.work_title);a.href='#work-'+r.work_id;head.appendChild(a);
    }else{
      head.appendChild(el('em','muted','(work gone)'));
    }
    c.appendChild(head);
    if(r.message)c.appendChild(el('p','rmsg',r.message));
    c.appendChild(el('div','rmeta',fmt(r.created_at)+' · work '+r.work_id));
    box.appendChild(c);
  });
}
function renderTombstones(list){
  var box=$('tombstones');box.textContent='';
  if(list.length===0){box.appendChild(el('p','empty','No tombstones.'));return;}
  list.forEach(function(t){
    var c=el('div','tcard');
    var left=el('div');
    left.appendChild(el('div',null,t.work_title+(t.note?' — '+t.note:'')));
    left.appendChild(el('div','thash',t.content_hash));
    left.appendChild(el('div','muted small',fmt(t.created_at)));
    c.appendChild(left);
    var del=el('button','btn-sm','Delete');del.type='button';
    del.addEventListener('click',function(){
      if(!confirm('Delete this tombstone? The content becomes publishable again.'))return;
      act(api('/api/admin/tombstones/'+t.content_hash,'DELETE'),'Tombstone deleted.');
    });
    c.appendChild(del);
    box.appendChild(c);
  });
}
$('btn-pause').addEventListener('click',function(){
  if(!state)return;
  var target=!state.publishingPaused;
  if(target&&!confirm('PAUSE all publishing? New works and updates will be rejected with a "temporarily closed" message until you resume.'))return;
  act(api('/api/admin/pause','POST',{paused:target}),target?'Publishing paused.':'Publishing resumed.');
});
$('btn-refresh').addEventListener('click',function(){refresh().catch(function(e){note(e.message);});});
if(!secret){fail('The admin link is incomplete: the secret after the # is missing.');return;}
refresh().catch(function(e){fail(e.message);});
})();
</script>`;

  return htmlResponse(pageShell({ title: 'Operator — The Shelf', css: ADMIN_CSS, body }));
}
