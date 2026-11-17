/* Adaptateur : fait fonctionner l'app hors de Claude avec les Functions Netlify (/api). */
(function(){
  var online=location.protocol!=='file:';
  var TK='padel-admin-token';
  function token(){try{return localStorage.getItem(TK)||''}catch(e){return ''}}
  function api(path,opt){
    opt=opt||{};var h={'content-type':'application/json'};var t=token();if(t)h.Authorization='Bearer '+t;
    return fetch('/api/'+path,{method:opt.method||'GET',headers:h,body:opt.body?JSON.stringify(opt.body):undefined,cache:'no-store'})
      .then(function(r){if(!r.ok){var e=new Error('http '+r.status);e.status=r.status;throw e}return r.json()});
  }
  function collection(name){
    var table=name==='public'?'pub':name;
    return {
      doc:function(id){return {set:function(d){return api('doc/'+table+'/'+id,{method:'PUT',body:{json:d.json==null?'':d.json,up:d.up||0,deleted:!!d.deleted}})}}},
      onSnapshot:function(ok,ko){
        var stopped=false,busy=false;
        function snap(list){return {docs:list.map(function(x){return {id:x.id,data:function(){return {json:x.json,up:x.up,deleted:x.deleted}}}}),metadata:{fromCache:false}}}
        function refresh(){
          if(busy)return;busy=true;
          api('list/'+table).then(function(l){if(!stopped)ok(snap(l))},function(e){if(!stopped&&ko)ko(e)}).then(function(){busy=false});
        }
        refresh();
        var iv=setInterval(refresh,8000);
        document.addEventListener('visibilitychange',function(){if(!document.hidden)refresh()});
        return function(){stopped=true;clearInterval(iv)};
      }
    };
  }
  var admin=function(){return online?!!token():true};
  if(online)window.padelApi=api;
  window.claude={use:function(name){
    return Promise.resolve().then(function(){
      if(name==='user')return {canEdit:admin,isOwner:admin,can:admin};
      if(name==='db')return online?{collection:collection}:null;
      if(name==='downloads')return {save:function(o){
        var blob=o.data instanceof Blob?o.data:new Blob([o.data]);var a=document.createElement('a');
        a.href=URL.createObjectURL(blob);a.download=o.filename||'fichier';document.body.appendChild(a);a.click();
        setTimeout(function(){URL.revokeObjectURL(a.href);a.remove()},500);return Promise.resolve()}};
      return null;
    });
  }};
  if(!online)return;

  document.addEventListener('DOMContentLoaded',function(){
    var st=document.createElement('style');
    st.textContent='.adm-l{position:fixed;top:8px;z-index:50;font:600 13px system-ui;color:#9b1d36;background:#fff;border:1px solid #9b1d36;border-radius:6px;padding:5px 10px;cursor:pointer}.adm-l:hover{background:#9b1d36;color:#fff}@media(max-width:700px){.adm-l{top:auto;bottom:10px}}'+
    '#adm-bg{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:100;display:flex;align-items:center;justify-content:center}#adm-box{background:#fff;border-radius:10px;padding:18px;width:min(320px,90vw);font:14px system-ui;display:grid;gap:10px}#adm-box input{padding:8px;border:1px solid #ccc;border-radius:6px;font:inherit}#adm-box button{padding:8px;border-radius:6px;border:0;background:#9b1d36;color:#fff;font:inherit;cursor:pointer}#adm-err{color:#b00;font-size:12px;min-height:1em}';
    document.head.appendChild(st);
    var b=document.createElement('button');b.className='adm-l';b.style.right='10px';b.textContent=token()?'Déconnexion admin':'Admin';document.body.appendChild(b);
    if(token()){
      var im=document.createElement('button');im.className='adm-l';im.style.right='150px';im.textContent='Importer des tournois';document.body.appendChild(im);
      var fi=document.createElement('input');fi.type='file';fi.accept='.json';fi.hidden=true;document.body.appendChild(fi);
      im.onclick=function(){fi.click()};
      fi.onchange=function(){var f=fi.files[0];if(!f)return;f.text().then(function(t){
        var rows=JSON.parse(t);return rows.reduce(function(p,r){return p.then(function(){return api('doc/'+r.table+'/'+r.id,{method:'PUT',body:{json:r.json,up:r.up,deleted:false}})})},Promise.resolve()).then(function(){location.reload()})
      }).catch(function(){alert("Fichier d'import invalide.")})};
    }
    b.onclick=function(){
      if(token()){try{localStorage.removeItem(TK)}catch(e){}location.reload();return}
      var bg=document.createElement('div');bg.id='adm-bg';
      bg.innerHTML='<form id="adm-box"><b>Connexion administrateur</b><input type="password" id="adm-p" placeholder="Mot de passe" autocomplete="current-password" required><div id="adm-err"></div><button type="submit">Se connecter</button><button type="button" id="adm-x" style="background:#999">Annuler</button></form>';
      document.body.appendChild(bg);bg.querySelector('#adm-p').focus();
      bg.querySelector('#adm-x').onclick=function(){bg.remove()};
      bg.querySelector('#adm-box').onsubmit=function(e){e.preventDefault();
        api('login',{method:'POST',body:{password:bg.querySelector('#adm-p').value}}).then(function(r){
          try{localStorage.setItem(TK,r.token)}catch(e){}location.reload()
        },function(e){var m=e&&e.status===401?'Mot de passe incorrect.':e&&e.status===500?"Le mot de passe ADMIN_PASSWORD n'est pas reçu par le site : vérifie la variable (scopes : Functions) puis relance un déploiement.":e&&e.status===404?"API introuvable : le dossier netlify n'est pas déployé.":'Erreur '+(e&&e.status||'réseau');bg.querySelector('#adm-err').textContent=m})};
    };
  });
})();
