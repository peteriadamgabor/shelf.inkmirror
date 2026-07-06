/**
 * GET /w/:id/manage — the author's control panel for one work.
 *
 * The manage secret arrives in the URL FRAGMENT (never path or query, so it
 * never reaches server logs); inline JS reads it and talks to the API with
 * the X-Manage-Secret header. The page itself is static and identical for
 * every caller — it leaks nothing about whether the work exists.
 *
 * Sections: work meta + lifecycle actions · Password (set/change/remove the
 * reading password) · Letters (open/close the mailbox, read + delete the
 * inbox). All user-controlled strings are inserted via textContent.
 */

import { escapeHtml, htmlResponse, pageShell } from '../../html';

const MANAGE_CSS = `
.rows{display:grid;gap:.55rem;margin:1rem 0}
.row{display:flex;justify-content:space-between;gap:1rem;font-size:.95rem}
.row .k{color:var(--muted)}
.actions{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1.4rem}
.status{min-height:1.4rem;font-size:.85rem;color:var(--muted);margin-top:.8rem}
.work-link{word-break:break-all;font-size:.9rem}
.field-row{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center;margin:.8rem 0 0}
.field-row input[type=password]{
  font:inherit;color:var(--ink);background:var(--surface);
  border:1px solid var(--line);border-radius:10px;padding:.55rem .7rem;
  flex:1;min-width:12rem;
}
.section-note{font-size:.85rem;color:var(--muted);margin:.8rem 0 0}
.lcard{border:1px solid var(--line);border-radius:10px;padding:.7rem .9rem;margin:.6rem 0}
.lmeta{display:flex;flex-wrap:wrap;gap:.3rem .9rem;color:var(--muted);font-size:.8rem;margin:0 0 .3rem}
.lbody{font-family:var(--serif);font-size:.95rem;white-space:pre-wrap;overflow-wrap:break-word;margin:0 0 .5rem}
.btn-sm{font:600 .78rem/1 var(--sans);padding:.4rem .65rem;border-radius:8px;cursor:pointer;
  border:1px solid var(--line);background:var(--surface);color:var(--ink)}
.btn-sm.danger{color:var(--ember);border-color:color-mix(in srgb,var(--ember) 45%,transparent)}
.empty{color:var(--muted);font-size:.9rem;margin:.8rem 0 0}
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

<div class="card" id="pw-card" hidden>
<h2 style="margin-top:0">Password</h2>
<p class="muted" id="pw-status"></p>
<div class="field-row">
<input type="password" id="pw-input" maxlength="128" placeholder="4&ndash;128 characters" autocomplete="new-password">
<button class="btn" id="btn-pw-save" type="button">Set password</button>
</div>
<div class="actions">
<button class="btn btn-danger" id="btn-pw-remove" type="button" hidden>Remove password</button>
</div>
<p class="section-note">Changing or removing the password signs every reader out.</p>
<p class="status" id="pw-note"></p>
</div>

<div class="card" id="lt-card" hidden>
<h2 style="margin-top:0">Letters</h2>
<p class="muted" id="lt-status"></p>
<div class="actions" style="margin-top:.8rem">
<button class="btn" id="btn-lt-toggle" type="button"></button>
</div>
<div id="lt-list"></div>
<p class="status" id="lt-note"></p>
</div>

<p class="muted small"><a href="/">The Shelf</a> · <a href="/rules">House rules</a></p>
</div>
<script>
(function(){
'use strict';
var ID='${safeId}';
var secret=location.hash.length>1?location.hash.slice(1):'';
var pwProtected=false;
var lettersOpen=true;
function $(x){return document.getElementById(x);}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function fmt(iso){
  var d=new Date(iso);
  return isNaN(d.getTime())?iso:d.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
}
function fail(msg){$('err-text').textContent=msg;$('error').hidden=false;$('panel').hidden=true;$('pw-card').hidden=true;$('lt-card').hidden=true;$('loading').hidden=true;}
function note(msg){$('status').textContent=msg;}
function pwNote(msg){$('pw-note').textContent=msg;}
function ltNote(msg){$('lt-note').textContent=msg;}
function api(path,method,body){
  var opts={method:method||'GET',headers:{'X-Manage-Secret':secret}};
  if(body!==undefined){opts.headers['content-type']='application/json';opts.body=JSON.stringify(body);}
  return fetch(path,opts).then(function(r){
    if(r.status===404)throw new Error('That secret does not open this work. Check that you used the complete manage link.');
    if(r.status===429)throw new Error('Too many requests — wait a minute and try again.');
    if(!r.ok)throw new Error('Something went wrong ('+r.status+'). Try again in a moment.');
    return r.json();
  });
}
function renderPw(){
  $('pw-status').textContent=pwProtected
    ?'Locked — readers need the password you share with them personally.'
    :'Open — anyone with the link can read.';
  $('btn-pw-save').textContent=pwProtected?'Change password':'Set password';
  $('btn-pw-remove').hidden=!pwProtected;
}
function renderLetters(letters){
  $('lt-status').textContent=lettersOpen
    ?"Accepting letters — readers can write to you from the work's pages."
    :'Closed — the letter page answers as if it never existed.';
  $('btn-lt-toggle').textContent=lettersOpen?'Close letters':'Accept letters';
  var box=$('lt-list');box.textContent='';
  if(letters.length===0){box.appendChild(el('p','empty','No letters yet.'));return;}
  letters.forEach(function(l){
    var c=el('div','lcard');
    var meta=el('div','lmeta');
    meta.appendChild(el('span',null,fmt(l.created_at)));
    if(l.contact)meta.appendChild(el('span',null,'answer: '+l.contact));
    c.appendChild(meta);
    c.appendChild(el('p','lbody',l.body));
    var del=el('button','btn-sm danger','Delete');del.type='button';
    del.addEventListener('click',function(){
      if(!confirm('Delete this letter? It cannot be recovered.'))return;
      api('/api/works/'+ID+'/letters/'+l.id,'DELETE').then(function(){
        ltNote('Letter deleted.');return loadLetters();
      }).catch(function(e){ltNote(e.message);});
    });
    c.appendChild(del);
    box.appendChild(c);
  });
}
function loadLetters(){
  return api('/api/works/'+ID+'/letters').then(function(r){
    lettersOpen=r.lettersOpen;renderLetters(r.letters||[]);
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
  pwProtected=m.passwordProtected===true;renderPw();
  $('loading').hidden=true;$('panel').hidden=false;$('pw-card').hidden=false;$('lt-card').hidden=false;
  loadLetters().catch(function(e){ltNote(e.message);});
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
    $('panel').hidden=true;$('pw-card').hidden=true;$('lt-card').hidden=true;
    fail('This work has been unpublished. Readers with the link now see an empty shelf.');
    $('error').querySelector('h2').textContent='Unpublished';
  }).catch(function(e){note(e.message);});
});
$('btn-pw-save').addEventListener('click',function(){
  var v=$('pw-input').value;
  if(v.length<4||v.length>128){pwNote('The password must be 4–128 characters.');return;}
  api('/api/works/'+ID+'/password','PUT',{password:v}).then(function(){
    pwProtected=true;renderPw();$('pw-input').value='';
    pwNote('Password saved. Every reader must unlock again with the new password.');
  }).catch(function(e){pwNote(e.message);});
});
$('btn-pw-remove').addEventListener('click',function(){
  if(!confirm('Remove the password? Anyone with the link can read again.'))return;
  api('/api/works/'+ID+'/password','PUT',{password:null}).then(function(){
    pwProtected=false;renderPw();
    pwNote('Password removed — the work is open to anyone with the link.');
  }).catch(function(e){pwNote(e.message);});
});
$('btn-lt-toggle').addEventListener('click',function(){
  var target=!lettersOpen;
  api('/api/works/'+ID+'/letters-open','PUT',{open:target}).then(function(){
    lettersOpen=target;
    ltNote(target?'Letters are open again.':'Letters closed — the letter page now shows nothing.');
    return loadLetters();
  }).catch(function(e){ltNote(e.message);});
});
})();
</script>`;

  return htmlResponse(
    pageShell({ title: 'Manage — The Shelf', css: MANAGE_CSS, body }),
  );
}
