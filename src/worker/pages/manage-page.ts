/**
 * GET /w/:id/manage — the author's control panel for one work.
 *
 * The manage secret arrives in the URL FRAGMENT (never path or query, so it
 * never reaches server logs); inline JS reads it and talks to the API with
 * the X-Manage-Secret header. The page itself is static and identical for
 * every caller — it leaks nothing about whether the work exists.
 */

import { escapeHtml, htmlResponse, pageShell } from '../../html';

const MANAGE_CSS = `
.rows{display:grid;gap:.55rem;margin:1rem 0}
.row{display:flex;justify-content:space-between;gap:1rem;font-size:.95rem}
.row .k{color:var(--muted)}
.actions{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1.4rem}
.status{min-height:1.4rem;font-size:.85rem;color:var(--muted);margin-top:.8rem}
.work-link{word-break:break-all;font-size:.9rem}
`;

export function managePage(id: string): Response {
  const safeId = escapeHtml(id); // already shape-checked by WORK_ID_RE, escaped anyway
  const body = `<div class="page">
<h1>Manage this work</h1>
<p class="muted small">This page needs the manage link you saved when publishing —
the secret after the <code>#</code> stays in your browser and is never sent in a URL.</p>

<div class="card" id="loading"><p class="muted">Checking your manage secret…</p></div>

<div class="card" id="error" hidden>
<h2 style="margin-top:0">Can&#39;t open this work</h2>
<p class="muted" id="err-text"></p>
</div>

<div class="card" id="panel" hidden>
<h2 style="margin-top:0" id="m-title"></h2>
<p class="work-link"><a id="m-link" href="#"></a></p>
<div class="rows">
<div class="row"><span class="k">Opens</span><span class="nums" id="m-views"></span></div>
<div class="row"><span class="k">Published</span><span id="m-created"></span></div>
<div class="row"><span class="k">Updated</span><span id="m-updated"></span></div>
<div class="row"><span class="k">Expires</span><span id="m-expires"></span></div>
</div>
<div class="actions">
<button class="btn" id="btn-copy" type="button">Copy reading link</button>
<button class="btn" id="btn-renew" type="button">Renew (+30 days)</button>
<button class="btn btn-danger" id="btn-delete" type="button">Unpublish</button>
</div>
<p class="status" id="status"></p>
</div>

<p class="muted small"><a href="/">The Shelf</a> · <a href="/rules">House rules</a></p>
</div>
<script>
(function(){
'use strict';
var ID='${safeId}';
var secret=location.hash.length>1?location.hash.slice(1):'';
function $(x){return document.getElementById(x);}
function fmt(iso){
  var d=new Date(iso);
  return isNaN(d.getTime())?iso:d.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
}
function fail(msg){$('err-text').textContent=msg;$('error').hidden=false;$('panel').hidden=true;$('loading').hidden=true;}
function note(msg){$('status').textContent=msg;}
function api(path,method){
  return fetch(path,{method:method||'GET',headers:{'X-Manage-Secret':secret}}).then(function(r){
    if(r.status===404)throw new Error('That secret does not open this work. Check that you used the complete manage link.');
    if(r.status===429)throw new Error('Too many requests — wait a minute and try again.');
    if(!r.ok)throw new Error('Something went wrong ('+r.status+'). Try again in a moment.');
    return r.json();
  });
}
if(!secret){fail('The manage link is incomplete: the secret after the # is missing. Use the full link you saved when you published.');return;}
api('/api/works/'+ID).then(function(m){
  $('m-title').textContent=m.title;
  var a=$('m-link');a.textContent=m.url;a.href=m.url;
  $('m-views').textContent=String(m.views);
  $('m-created').textContent=fmt(m.created_at);
  $('m-updated').textContent=fmt(m.updated_at);
  $('m-expires').textContent=fmt(m.expires_at);
  $('loading').hidden=true;$('panel').hidden=false;
}).catch(function(e){fail(e.message);});
$('btn-copy').addEventListener('click',function(){
  var url=$('m-link').href;
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(url).then(function(){note('Reading link copied.');},function(){note(url);});
  }else{note(url);}
});
$('btn-renew').addEventListener('click',function(){
  api('/api/works/'+ID+'/renew','POST').then(function(r){
    $('m-expires').textContent=fmt(r.expires_at);
    note('Renewed — this work now expires '+fmt(r.expires_at)+'.');
  }).catch(function(e){note(e.message);});
});
$('btn-delete').addEventListener('click',function(){
  if(!confirm('Unpublish this work? The reading link stops working immediately. This cannot be undone.'))return;
  api('/api/works/'+ID,'DELETE').then(function(){
    $('panel').hidden=true;
    fail('This work has been unpublished. Readers with the link now see an empty shelf.');
    $('error').querySelector('h2').textContent='Unpublished';
  }).catch(function(e){note(e.message);});
});
})();
</script>`;

  return htmlResponse(
    pageShell({ title: 'Manage — The Shelf', css: MANAGE_CSS, body }),
  );
}
