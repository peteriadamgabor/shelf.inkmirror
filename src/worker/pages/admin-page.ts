/**
 * GET /admin — the operator console.
 *
 * Same trust model as the manage page: the admin secret arrives in the URL
 * FRAGMENT, is read into JS memory, and travels only in the X-Admin-Secret
 * header to /api/admin/*. The page itself is static and identical for every
 * caller — a visitor without the secret sees a friendly error, nothing more.
 * All user-controlled strings are inserted via textContent, never innerHTML.
 *
 * This is a tool, not a document: a control-room layout (sticky toolbar, KPI
 * tiles with semantic color, a needs-decision queue, dense work rows), a
 * deliberate step away from the reading surface's quiet vocabulary.
 */

import { RATINGS, WARNING_TAGS } from '../../format';
import { htmlResponse, pageShell } from '../../html';

const ADMIN_CSS = `
:root{
  --op-good:var(--teal);
  --op-warn:var(--amber);
  --op-crit:var(--ember);
  --op-elev:0 1px 2px rgba(0,0,0,.06), 0 8px 24px -12px rgba(0,0,0,.18);
  --op-elev-hi:0 2px 6px rgba(0,0,0,.08), 0 18px 40px -14px rgba(0,0,0,.28);
}
@media (prefers-color-scheme: dark){
  :root{
    --op-elev:0 1px 2px rgba(0,0,0,.4), 0 10px 28px -14px rgba(0,0,0,.6);
    --op-elev-hi:0 2px 8px rgba(0,0,0,.5), 0 20px 46px -14px rgba(0,0,0,.7);
  }
}
/* Break out of the narrow reading column — an operator scans wide. */
.page{max-width:68rem;padding-top:0}

/* ---- sticky toolbar ---- */
.op-bar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:1rem;
  padding:.85rem 0;margin-bottom:1.4rem;
  background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);
  border-bottom:1px solid var(--line)}
.op-brand{display:flex;align-items:baseline;gap:.55rem;font-family:var(--serif);font-size:1.35rem;font-weight:600}
.op-brand .dot{width:.5rem;height:.5rem;border-radius:999px;background:var(--muted);align-self:center;transition:background .3s}
.op-brand.live .dot{background:var(--op-good);box-shadow:0 0 0 3px color-mix(in srgb,var(--op-good) 22%,transparent)}
.op-chip{font-family:var(--sans);font-size:.62rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;
  color:var(--violet);background:color-mix(in srgb,var(--violet) 14%,transparent);
  padding:.2rem .5rem;border-radius:999px;align-self:center}
.op-actions{margin-left:auto;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}

/* ---- buttons ---- */
.btn-sm{font:600 .8rem/1 var(--sans);padding:.5rem .8rem;border-radius:9px;cursor:pointer;
  border:1px solid var(--line);background:var(--surface);color:var(--ink);
  transition:border-color .15s,background .15s,transform .05s}
.btn-sm:hover{border-color:color-mix(in srgb,var(--violet) 55%,var(--line))}
.btn-sm:active{transform:translateY(1px)}
.btn-sm:disabled{opacity:.5;cursor:default}
.btn-sm:focus-visible{outline:2px solid var(--violet);outline-offset:2px}
.btn-primary{background:var(--violet);border-color:var(--violet);color:#fff}
.btn-primary:hover{filter:brightness(1.08);border-color:var(--violet)}
.btn-danger{color:var(--op-crit);border-color:color-mix(in srgb,var(--op-crit) 40%,transparent)}
.btn-danger:hover{background:color-mix(in srgb,var(--op-crit) 10%,transparent);border-color:var(--op-crit)}
.btn-good{color:var(--op-good);border-color:color-mix(in srgb,var(--op-good) 45%,transparent)}
.btn-good:hover{background:color-mix(in srgb,var(--op-good) 10%,transparent);border-color:var(--op-good)}

/* ---- KPI tiles ---- */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr));gap:.8rem;margin:0 0 1.1rem}
.stat{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:14px;
  padding:1rem 1.1rem .9rem;box-shadow:var(--op-elev);overflow:hidden}
.stat::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--muted);opacity:.5}
.stat.accent::before{background:var(--violet);opacity:1}
.stat.warn::before{background:var(--op-warn);opacity:1}
.stat.crit::before{background:var(--op-crit);opacity:1}
.stat .v{font-family:var(--sans);font-size:1.7rem;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.stat .k{color:var(--muted);font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;margin-top:.45rem}
.stat.warn .v{color:var(--op-warn)}
.stat.crit .v{color:var(--op-crit)}
/* chain meter */
.meter{height:5px;border-radius:999px;background:var(--line);margin-top:.55rem;overflow:hidden}
.meter>i{display:block;height:100%;border-radius:999px;background:var(--violet);transition:width .4s ease}
.meter.hot>i{background:var(--op-warn)}

/* ---- paused banner ---- */
.paused-banner{display:flex;align-items:center;gap:.6rem;
  border:1px solid color-mix(in srgb,var(--op-crit) 45%,transparent);
  background:color-mix(in srgb,var(--op-crit) 12%,transparent);color:var(--op-crit);
  border-radius:12px;padding:.7rem 1rem;font-weight:600;margin:0 0 1.1rem;box-shadow:var(--op-elev)}
.paused-banner::before{content:"⏸";font-size:1.1rem}

/* ---- section headers ---- */
.op-h{display:flex;align-items:center;gap:.6rem;margin:2rem 0 .3rem}
.op-h h2{font-family:var(--serif);font-size:1.25rem;font-weight:600;margin:0}
.op-h .count{font:700 .72rem/1 var(--sans);color:var(--muted);background:var(--line);
  padding:.25rem .5rem;border-radius:999px;font-variant-numeric:tabular-nums}
.op-h.alert .count{color:var(--op-warn);background:color-mix(in srgb,var(--op-warn) 16%,transparent)}
.op-h .rule{flex:1;height:1px;background:var(--line)}
.op-sub{color:var(--muted);font-size:.84rem;margin:.15rem 0 .8rem}

/* ---- needs-decision cards ---- */
.hcard{position:relative;background:var(--surface);
  border:1px solid color-mix(in srgb,var(--op-warn) 40%,var(--line));
  border-radius:13px;padding:1rem 1.1rem;margin:.7rem 0;display:flex;flex-wrap:wrap;
  justify-content:space-between;gap:.6rem 1rem;align-items:center;box-shadow:var(--op-elev)}
.hcard::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;border-radius:13px 0 0 13px;background:var(--op-warn)}
.hcard .hmeta{color:var(--muted);font-size:.82rem;margin:.25rem 0 0}

/* ---- work rows ---- */
.wcard{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:13px;
  padding:1rem 1.1rem 1rem 1.3rem;margin:.7rem 0;box-shadow:var(--op-elev);transition:box-shadow .15s,transform .05s}
.wcard:hover{box-shadow:var(--op-elev-hi)}
.wcard::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;border-radius:13px 0 0 13px;background:var(--muted);opacity:.4}
.wcard.st-listed::before{background:var(--violet);opacity:1}
.wcard.st-held::before,.wcard.st-pending::before{background:var(--op-warn);opacity:1}
.wcard.removed::before{background:var(--op-crit);opacity:1}
.wcard.removed{opacity:.72}
.wcard.flag::after{content:"";position:absolute;right:1rem;top:1rem;width:.5rem;height:.5rem;border-radius:999px;background:var(--op-crit)}
.wtitle{font-family:var(--serif);font-weight:600;font-size:1.08rem;margin:0}
.wtitle a{color:var(--ink);text-decoration:none}
.wtitle a:hover{color:var(--violet)}
.wmeta{display:flex;flex-wrap:wrap;gap:.35rem .8rem;color:var(--muted);font-size:.8rem;margin:.45rem 0 .7rem;align-items:center}
.wmeta .nums{font-variant-numeric:tabular-nums}
.wid{font-family:ui-monospace,monospace;font-size:.72rem;color:var(--muted);opacity:.7}

/* ---- pills ---- */
.tag{display:inline-block;font-size:9.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;
  padding:3px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.tag-explicit{color:var(--op-crit);border-color:color-mix(in srgb,var(--op-crit) 35%,transparent)}
.tag-mature{color:var(--op-warn);border-color:color-mix(in srgb,var(--op-warn) 35%,transparent)}
.tag-general{color:var(--muted)}
.tag-removed{color:var(--op-crit);border-color:color-mix(in srgb,var(--op-crit) 45%,transparent)}
.tag-reports{color:#fff;background:var(--op-crit);border-color:var(--op-crit)}
.tag-locked{color:var(--op-good);border-color:color-mix(in srgb,var(--op-good) 40%,transparent)}
.tag-mod-hold{color:var(--op-crit);border-color:color-mix(in srgb,var(--op-crit) 45%,transparent)}
.tag-mod-tag-fix{color:var(--op-warn);border-color:color-mix(in srgb,var(--op-warn) 40%,transparent)}
.tag-mod-pass{color:var(--op-good);border-color:color-mix(in srgb,var(--op-good) 35%,transparent)}
.tag-mod-error,.tag-mod-skipped{color:var(--muted);font-style:italic}
.tag-shelf-listed{color:var(--violet);border-color:color-mix(in srgb,var(--violet) 45%,transparent)}
.tag-shelf-pending{color:var(--op-warn)}
.tag-shelf-held{color:var(--op-crit);border-color:color-mix(in srgb,var(--op-crit) 45%,transparent)}
.tag-shelf-refused{color:var(--op-warn)}

/* ---- actions + inline forms ---- */
.acts{display:flex;flex-wrap:wrap;gap:.45rem;align-items:center}
.inline-form{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:.7rem 0 0;
  padding:.7rem .8rem;border:1px solid var(--line);border-radius:10px;
  background:color-mix(in srgb,var(--bg) 55%,var(--surface))}
.inline-form select,.inline-form input[type=number]{
  font:inherit;font-size:.85rem;color:var(--ink);background:var(--surface);
  border:1px solid var(--line);border-radius:7px;padding:.35rem .5rem}
.inline-form input[type=number]{width:5rem}
.warnbox{display:flex;flex-wrap:wrap;gap:.3rem .8rem;font-size:.8rem}
.warnbox label{display:inline-flex;gap:.3rem;align-items:center;white-space:nowrap;color:var(--muted)}

/* ---- reports + tombstones ---- */
.rcard{position:relative;background:var(--surface);border:1px solid var(--line);
  border-left:3px solid var(--op-crit);border-radius:10px;padding:.7rem 1rem;margin:.6rem 0;font-size:.9rem;box-shadow:var(--op-elev)}
.rcard .rmsg{white-space:pre-wrap;overflow-wrap:break-word;margin:.3rem 0 0}
.rcard .rmeta{color:var(--muted);font-size:.78rem;margin-top:.3rem}
.tcard{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.5rem;align-items:center;
  border:1px solid var(--line);border-radius:11px;padding:.7rem 1rem;margin:.5rem 0;font-size:.85rem;background:var(--surface)}
.thash{font-family:ui-monospace,monospace;font-size:.72rem;color:var(--muted);word-break:break-all}
.status{min-height:1.3rem;font-size:.85rem;color:var(--violet);margin:.5rem 0 0;font-weight:500}
.empty{color:var(--muted);font-size:.9rem;padding:.6rem 0}

@media (min-width: 44rem){
  .wcard{display:grid;grid-template-columns:1fr auto;gap:.2rem 1rem}
  .wcard .acts{justify-self:end;align-self:start}
  .wcard .inline-form,.wcard .wfull{grid-column:1/-1}
}
@media (prefers-reduced-motion: reduce){
  .btn-sm:active,.wcard{transition:none}
}
`;

export function adminPage(): Response {
  const ratingsJson = JSON.stringify(RATINGS);
  const warningsJson = JSON.stringify(WARNING_TAGS);

  const body = `<div class="page">

<div class="card" id="loading"><p class="muted">Opening the back room&hellip;</p></div>

<div class="card" id="error" hidden>
<h2 style="margin-top:0">Nothing here</h2>
<p class="muted" id="err-text"></p>
</div>

<div id="panel" hidden>
<div class="op-bar">
  <span class="op-brand" id="brand"><span class="dot"></span>The Shelf<span class="op-chip">operator</span></span>
  <span class="op-actions">
    <button class="btn-sm" id="btn-backup" type="button">Download backup</button>
    <button class="btn-sm btn-danger" id="btn-pause" type="button"></button>
    <button class="btn-sm" id="btn-refresh" type="button">Refresh</button>
  </span>
</div>

<div id="paused-banner" class="paused-banner" hidden>Publishing is PAUSED — new works are being turned away.</div>
<div class="stats" id="stats"></div>
<p class="status" id="status"></p>

<div id="held-section" hidden>
<div class="op-h alert"><h2>Needs decision</h2><span class="count" id="held-count">0</span><span class="rule"></span></div>
<p class="op-sub">Listing requests waiting on a human. The works stay readable by link — nothing is listed until you decide.</p>
<div id="held"></div>
</div>

<div class="op-h"><h2>Recent works</h2><span class="count" id="works-count">0</span><span class="rule"></span></div>
<div id="works"></div>

<div class="op-h"><h2>Recent reports</h2><span class="count" id="reports-count">0</span><span class="rule"></span></div>
<div id="reports"></div>

<div class="op-h"><h2>Tombstones</h2><span class="count" id="tomb-count">0</span><span class="rule"></span></div>
<p class="op-sub">Content hashes of removed works that cannot be republished. Deleting one forgives the content.</p>
<div id="tombstones"></div>

<p class="muted small" style="margin-top:2rem"><a href="/">The Shelf</a> · <a href="/rules">House rules</a></p>
</div>
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
    $('brand').classList.add('live');
  });
}
function act(promise,okMsg){
  promise.then(function(){note(okMsg);return refresh();}).catch(function(e){note(e.message);});
}
function statTile(value,label,cls,meter){
  var s=el('div','stat'+(cls?' '+cls:''));
  s.appendChild(el('div','v nums',String(value)));
  s.appendChild(el('div','k',label));
  if(meter){
    var m=el('div','meter'+(meter.hot?' hot':''));var i=document.createElement('i');
    i.style.width=Math.max(2,Math.min(100,meter.pct))+'%';m.appendChild(i);s.appendChild(m);
  }
  return s;
}
function render(o){
  $('paused-banner').hidden=!o.publishingPaused;
  var pauseBtn=$('btn-pause');
  pauseBtn.textContent=o.publishingPaused?'Resume publishing':'Pause (panic)';
  pauseBtn.classList.toggle('btn-danger',!o.publishingPaused);
  pauseBtn.classList.toggle('btn-good',!!o.publishingPaused);

  var stats=$('stats');stats.textContent='';
  var cb=o.chainBudget||{cap:0,usedToday:0};
  var held=o.works.held||0, removed=o.works.removed||0;
  stats.appendChild(statTile(o.works.active||0,'Active','accent'));
  stats.appendChild(statTile(held,'Held',held>0?'warn':''));
  stats.appendChild(statTile(removed,'Removed',removed>0?'crit':''));
  stats.appendChild(statTile(Number(o.totalViews).toLocaleString(),'Total opens'));
  var pct=cb.cap>0?(cb.usedToday/cb.cap)*100:0;
  stats.appendChild(statTile(cb.usedToday+' / '+cb.cap,'Chain today',pct>=80?'warn':'',{pct:pct,hot:pct>=80}));

  renderHeld(o.heldListings||[]);
  renderWorks(o.recentWorks||[]);
  renderReports(o.recentReports||[]);
  renderTombstones(o.tombstones||[]);
}
function heldReasonText(l){
  if(!l||!l.reason)return 'needs review';
  if(l.reason==='manual')return 'manual review — the gate has no API key';
  if(l.reason==='review')return 'hard-line suspicion from the chain';
  if(l.reason==='truncated')return 'too long for full automated review';
  if(l.reason==='error')return 'the moderation chain failed — fail-safe hold';
  return l.reason;
}
function renderHeld(list){
  $('held-section').hidden=list.length===0;
  $('held-count').textContent=String(list.length);
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
    var approve=el('button','btn-sm btn-good','Approve — list it');approve.type='button';
    approve.addEventListener('click',function(){
      act(api('/api/admin/works/'+w.id+'/listing','POST',{action:'approve'}),'Listed "'+w.title+'" on the shelf.');
    });
    var deny=el('button','btn-sm btn-danger','Deny');deny.type='button';
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
  $('works-count').textContent=String(list.length);
  var box=$('works');box.textContent='';
  if(list.length===0){box.appendChild(el('p','empty','No works yet.'));return;}
  list.forEach(function(w){box.appendChild(workCard(w));});
}
function workCard(w){
  var st=w.status==='removed'?'removed':(w.listing_state?'st-'+w.listing_state:'');
  var card=el('div','wcard'+(st?' '+st:'')+(w.report_count>0?' flag':''));
  card.id='work-'+w.id;
  var head=el('div');
  var t=el('p','wtitle');
  var link=el('a',null,w.title);link.href='/w/'+w.id;link.target='_blank';link.rel='noopener';
  t.appendChild(link);
  head.appendChild(t);
  var meta=el('div','wmeta');
  meta.appendChild(el('span','tag tag-'+w.rating,w.rating));
  if(w.status!=='active')meta.appendChild(el('span','tag tag-'+w.status,w.status));
  if(w.listing_state)meta.appendChild(el('span','tag tag-shelf-'+w.listing_state,'shelf: '+w.listing_state));
  if(w.moderation_outcome)meta.appendChild(el('span','tag tag-mod-'+w.moderation_outcome,'mod: '+w.moderation_outcome));
  if(w.password_protected)meta.appendChild(el('span','tag tag-locked','locked'));
  if(w.report_count>0)meta.appendChild(el('span','tag tag-reports',w.report_count+' reports'));
  meta.appendChild(el('span',null,'by '+w.pen_name));
  meta.appendChild(el('span','nums',Number(w.word_count).toLocaleString()+' words'));
  meta.appendChild(el('span','nums',w.views+' opens'));
  meta.appendChild(el('span',null,'exp '+fmt(w.expires_at)));
  meta.appendChild(el('span','wid',w.id));
  head.appendChild(meta);
  card.appendChild(head);

  var acts=el('div','acts');
  if(w.status==='removed'){
    var restore=el('button','btn-sm btn-good','Restore');restore.type='button';
    restore.addEventListener('click',function(){
      act(api('/api/admin/works/'+w.id+'/restore','POST'),'Restored "'+w.title+'".');
    });
    acts.appendChild(restore);
  }else{
    var remove=el('button','btn-sm btn-danger','Remove');remove.type='button';
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
  var applyRl=el('button','btn-sm btn-primary','Apply labels');applyRl.type='button';
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
  var applyEx=el('button','btn-sm btn-primary','Set expiry');applyEx.type='button';
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
  $('reports-count').textContent=String(list.length);
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
  $('tomb-count').textContent=String(list.length);
  var box=$('tombstones');box.textContent='';
  if(list.length===0){box.appendChild(el('p','empty','No tombstones.'));return;}
  list.forEach(function(t){
    var c=el('div','tcard');
    var left=el('div');
    left.appendChild(el('div',null,t.work_title+(t.note?' — '+t.note:'')));
    left.appendChild(el('div','thash',t.content_hash));
    left.appendChild(el('div','muted small',fmt(t.created_at)));
    c.appendChild(left);
    var del=el('button','btn-sm btn-danger','Delete');del.type='button';
    del.addEventListener('click',function(){
      if(!confirm('Delete this tombstone? The content becomes publishable again.'))return;
      act(api('/api/admin/tombstones/'+t.content_hash,'DELETE'),'Tombstone deleted.');
    });
    c.appendChild(del);
    box.appendChild(c);
  });
}
function downloadBackup(){
  note('Preparing backup…');
  fetch('/api/admin/backup',{headers:{'X-Admin-Secret':secret}}).then(function(r){
    if(!r.ok)throw new Error('Backup failed ('+r.status+').');
    return r.blob();
  }).then(function(b){
    var url=URL.createObjectURL(b);var a=document.createElement('a');
    a.href=url;a.download='shelf-backup-'+new Date().toISOString().slice(0,10)+'.json';
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(function(){URL.revokeObjectURL(url);},1000);
    note('Backup downloaded.');
  }).catch(function(e){note(e.message);});
}
$('btn-pause').addEventListener('click',function(){
  if(!state)return;
  var target=!state.publishingPaused;
  if(target&&!confirm('PAUSE all publishing? New works and updates will be rejected with a "temporarily closed" message until you resume.'))return;
  act(api('/api/admin/pause','POST',{paused:target}),target?'Publishing paused.':'Publishing resumed.');
});
$('btn-refresh').addEventListener('click',function(){refresh().catch(function(e){note(e.message);});});
$('btn-backup').addEventListener('click',downloadBackup);
if(!secret){fail('The admin link is incomplete: the secret after the # is missing.');return;}
refresh().catch(function(e){fail(e.message);});
})();
</script>`;

  return htmlResponse(pageShell({ title: 'Operator — The Shelf', css: ADMIN_CSS, body }));
}
