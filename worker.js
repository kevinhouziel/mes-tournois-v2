// API Padel pour Cloudflare Workers (appelée seulement pour /api/*).
// Stockage : base D1 (liaison "DB"). Mot de passe admin : variable ADMIN_PASSWORD.
// Version portée de api.mjs (Netlify) : mêmes routes, mêmes formats.

const TABLES = ['tournaments', 'pub'];
const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function sha256Hex(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function tokenFor(pw) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode('padel-admin-v1')));
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function isAdmin(req, pw) {
  if (!pw) return false;
  const h = req.headers.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  return safeEqual(t, await tokenFor(pw));
}

// Petit "magasin" clé/valeur au-dessus de D1 (table kv : key, value)
function makeStore(db) {
  return {
    async get(key) {
      const r = await db.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first();
      return r ? JSON.parse(r.value) : null;
    },
    async setJSON(key, val) {
      await db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind(key, JSON.stringify(val)).run();
    },
    async delete(key) { await db.prepare('DELETE FROM kv WHERE key = ?').bind(key).run(); },
    async listJSON(prefix) {
      const { results } = await db.prepare('SELECT value FROM kv WHERE substr(key, 1, ?) = ?').bind(prefix.length, prefix).all();
      return results.map(r => { try { return JSON.parse(r.value); } catch (e) { return null; } }).filter(Boolean);
    }
  };
}

/* ---- Mes Pronos : pronostics publics (un enregistrement par appareil) ---- */
const hashDev = async (dev) => (await sha256Hex('padel-dev:' + dev)).slice(0, 16);
function cleanPicks(src) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const k of Object.keys(src).slice(0, 400)) {
    if (!/^[\w.]{1,12}$/.test(k)) continue;
    const p = src[k];
    if (k === 'W' || /^G\d{1,2}$/.test(k)) {
      if (p && typeof p.p === 'string' && /^[\w-]{1,24}$/.test(p.p)) out[k] = { p: p.p };
      continue;
    }
    if (!p || (p.w !== 'a' && p.w !== 'b') || typeof p.a !== 'string' || typeof p.b !== 'string' || p.a.length > 24 || p.b.length > 24) continue;
    let s = null;
    if (Array.isArray(p.s) && p.s.length === 2) {
      const x = Number(p.s[0]), y = Number(p.s[1]);
      if (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x <= 99 && y <= 99 && ((p.w === 'a') === (x > y)) && x !== y) s = [x, y];
    }
    out[k] = { w: p.w, a: p.a, b: p.b, s };
  }
  return out;
}
async function lockedIds(store, tid) {
  const locked = new Set();
  try {
    const row = await store.get('pub/' + tid);
    if (row && row.json) {
      const st = JSON.parse(row.json);
      Object.keys(st.starts || {}).forEach(id => { if (st.starts[id]) locked.add(id); });
      Object.keys(st.scores || {}).forEach(id => { const v = st.scores[id]; if (v && (v.a !== '' && v.a != null || v.b !== '' && v.b != null)) locked.add(id); });
      /* vainqueur du tournoi / de poule : fermés dès que le premier match est lancé */
      if (locked.size) { locked.add('W'); for (let g = 1; g <= 40; g++) locked.add('G' + g); }
    }
  } catch (e) { /* pas de verrou si le tournoi n'est pas publié */ }
  return locked;
}

async function handle(req, store, pw) {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  try {
    if (req.method === 'POST' && parts[0] === 'login') {
      const body = await req.json().catch(() => ({}));
      if (!pw) return json({ error: 'no_password_configured' }, 500);
      const given = typeof body.password === 'string' ? body.password.trim() : '';
      if (safeEqual(given, pw)) return json({ token: await tokenFor(pw) });
      return json({ error: 'bad_password' }, 401);
    }
    if (req.method === 'GET' && parts[0] === 'list' && TABLES.includes(parts[1])) {
      if (parts[1] === 'tournaments' && !(await isAdmin(req, pw))) return json({ error: 'unauthorized' }, 401);
      return json(await store.listJSON(parts[1] + '/'));
    }
    if (req.method === 'PUT' && parts[0] === 'doc' && TABLES.includes(parts[1]) && /^[\w-]{1,80}$/.test(parts[2] || '')) {
      if (!(await isAdmin(req, pw))) return json({ error: 'unauthorized' }, 401);
      const b = await req.json();
      const row = { id: parts[2], json: typeof b.json === 'string' ? b.json : '', up: Number(b.up) || 0, deleted: !!b.deleted };
      await store.setJSON(parts[1] + '/' + parts[2], row);
      return json({ ok: true });
    }
    if (parts[0] === 'vote' && /^[\w-]{1,80}$/.test(parts[1] || '') && /^[\w-]{8,64}$/.test(parts[2] || '')) {
      const tid = parts[1];
      if (req.method === 'PUT') {
        const raw = await req.text();
        if (raw.length > 40000) return json({ error: 'too_large' }, 413);
        const b = JSON.parse(raw || '{}');
        const h = await hashDev(parts[2]);
        const key = 'votes/' + tid + '/' + h;
        const name = String(b.name || '').replace(/[<>&"\u0000-\u001f]/g, '').trim().slice(0, 24);
        if (!name) return json({ error: 'name_required' }, 400);
        const prev = await store.get(key).catch(() => null);
        const old = (prev && prev.picks) || {};
        const mine = cleanPicks(b.picks);
        const locked = await lockedIds(store, tid);
        const picks = { ...old };
        for (const id of Object.keys(mine)) {
          const same = old[id] && JSON.stringify(old[id]) === JSON.stringify(mine[id]);
          if (!same && locked.has(id)) continue;
          picks[id] = mine[id];
        }
        for (const id of Object.keys(old)) { if (!(id in mine) && !locked.has(id)) delete picks[id]; }
        await store.setJSON(key, { h, name, picks, up: Date.now() });
        return json({ ok: true, h, picks });
      }
      if (req.method === 'DELETE' && /^[0-9a-f]{16}$/.test(parts[2])) {
        if (!(await isAdmin(req, pw))) return json({ error: 'unauthorized' }, 401);
        await store.delete('votes/' + tid + '/' + parts[2]);
        return json({ ok: true });
      }
    }
    if (req.method === 'GET' && parts[0] === 'votes' && /^[\w-]{1,80}$/.test(parts[1] || '')) {
      const rows = await store.listJSON('votes/' + parts[1] + '/');
      const dev = url.searchParams.get('dev') || '';
      return json({ rows: rows.map(r => ({ h: r.h, name: r.name, picks: r.picks, up: r.up })), me: /^[\w-]{8,64}$/.test(dev) ? await hashDev(dev) : null });
    }
    return json({ error: 'not_found' }, 404);
  } catch (e) {
    return json({ error: 'server', message: String(e && e.message || e) }, 500);
  }
}


export default {
  async fetch(request, env) {
    if (!env.DB) return json({ error: 'server', message: 'Liaison D1 "DB" manquante' }, 500);
    return handle(request, makeStore(env.DB), (env.ADMIN_PASSWORD || '').trim());
  }
};
