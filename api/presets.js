// Shared preset library — Vercel Serverless Function (Node.js, no dependencies).
//
// Storage:
//  * On Vercel: Upstash Redis (Vercel Marketplace → "Upstash for Redis"), via its REST API.
//    Uses [PREFIX_]KV_REST_API_URL / _TOKEN or [PREFIX_]UPSTASH_REDIS_REST_URL / _TOKEN (any prefix).
//  * Locally (node serve.js): a JSON file in .data/ so publishing can be tried without deploying.
//
// GET    /api/presets              → { items: [...] }   newest first (max 200)
// GET    /api/presets?id=ID        → { item }
// POST   /api/presets              → { item, token }    body: { name, author, note, model, family, rt, keys, colors? }
// POST   /api/presets?id=ID&use=1  → { uses }           counts an apply
// DELETE /api/presets?id=ID&token=T                     author-only delete (token returned on publish)

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MODELS = [75, 750, 751, 752, 753, 754, 755, 65, 650, 60, 82];
const FAMILIES = ['A75', 'A75 ISO', 'G75', 'G75 JP', 'G65', 'G60'];
const MAX_LIST = 200;
const RATE_LIMIT = 20; // publishes per IP per hour

// ---------------------------------------------------------------- storage
// The Marketplace integration may add a custom prefix (e.g. DDSTORAGE_KV_REST_API_URL), so match any
// prefix, taking the URL and the token from the same pair. Never the *_READ_ONLY_TOKEN: publishing writes.
function redisConfig() {
  const env = process.env;
  for (const [urlSuffix, tokenSuffix] of [['KV_REST_API_URL', 'KV_REST_API_TOKEN'], ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']]) {
    for (const key of Object.keys(env).filter((k) => k.endsWith(urlSuffix)).sort((a, b) => a.length - b.length)) {
      const url = env[key];
      const token = env[key.slice(0, -urlSuffix.length) + tokenSuffix];
      if (url && token) return { url: url.replace(/\/$/, ''), token };
    }
  }
  return null;
}

function redisStore({ url, token }) {
  async function pipe(cmds) {
    const r = await fetch(url + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
    });
    if (!r.ok) throw new Error('storage error ' + r.status);
    const out = await r.json();
    return out.map((x) => { if (x.error) throw new Error(x.error); return x.result; });
  }
  return {
    async list() {
      const [ids] = await pipe([['ZRANGE', 'presets:all', '0', String(MAX_LIST - 1), 'REV']]);
      if (!ids || !ids.length) return [];
      const [raw, uses] = await pipe([['MGET', ...ids.map((id) => 'preset:' + id)], ['HMGET', 'presets:uses', ...ids]]);
      // One damaged record must not take the whole library down.
      return raw.map((s, i) => { try { return s ? { ...JSON.parse(s), uses: Number(uses[i]) || 0 } : null; } catch { return null; } }).filter(Boolean);
    },
    async get(id) {
      const [s, u] = await pipe([['GET', 'preset:' + id], ['HGET', 'presets:uses', id]]);
      return s ? { ...JSON.parse(s), uses: Number(u) || 0 } : null;
    },
    async add(item) {
      await pipe([['SET', 'preset:' + item.id, JSON.stringify(item)], ['ZADD', 'presets:all', String(item.created), item.id]]);
    },
    async remove(id) { await pipe([['DEL', 'preset:' + id], ['ZREM', 'presets:all', id], ['HDEL', 'presets:uses', id]]); },
    async use(id) { const [n] = await pipe([['HINCRBY', 'presets:uses', id, '1']]); return n; },
    async hit(key) { const [n] = await pipe([['INCR', key], ['EXPIRE', key, '3600']]); return n; },
  };
}

function fileStore() {
  const dir = path.join(__dirname, '..', '.data');
  const file = path.join(dir, 'presets.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { items: [], uses: {} }; } };
  const save = (db) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(db, null, 1)); };
  const hits = new Map();
  return {
    async list() { const db = load(); return db.items.slice().sort((a, b) => b.created - a.created).slice(0, MAX_LIST).map((x) => ({ ...x, uses: db.uses[x.id] || 0 })); },
    async get(id) { const db = load(); const x = db.items.find((p) => p.id === id); return x ? { ...x, uses: db.uses[id] || 0 } : null; },
    async add(item) { const db = load(); db.items.push(item); save(db); },
    async remove(id) { const db = load(); db.items = db.items.filter((p) => p.id !== id); delete db.uses[id]; save(db); },
    async use(id) { const db = load(); db.uses[id] = (db.uses[id] || 0) + 1; save(db); return db.uses[id]; },
    async hit(key) { const n = (hits.get(key) || 0) + 1; hits.set(key, n); return n; },
  };
}

function getStore() {
  const cfg = redisConfig();
  if (cfg) return redisStore(cfg);
  if (!process.env.VERCEL) return fileStore();
  return null;
}

// ---------------------------------------------------------------- validation
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const RATE_LIMIT_USES = 120; // "applied" counts per IP per hour
// Vercel sets x-vercel-forwarded-for / x-real-ip itself; the first x-forwarded-for entry can be forged by the client.
const clientIp = (req) => String(req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim();
const hourKey = (kind, req) => `rl:${kind}:${sha(clientIp(req)).slice(0, 16)}:${Math.floor(Date.now() / 3600000)}`;
function sameHash(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function validate(b) {
  if (!b || typeof b !== 'object') return 'Invalid body';
  const name = clean(b.name, 40);
  if (!name) return 'Name is required';
  const model = Number(b.model);
  if (!MODELS.includes(model)) return 'Unknown keyboard model';
  if (!FAMILIES.includes(b.family)) return 'Unknown layout family';
  if (typeof b.keys !== 'string' || !/^[A-Za-z0-9_-]+$/.test(b.keys) || b.keys.length > 600) return 'Invalid key data';
  const bytes = Buffer.from(b.keys, 'base64url');
  if (!bytes.length || bytes.length % 3 || bytes.length > 3 * 140) return 'Invalid key data';
  for (let i = 0; i < bytes.length; i += 3) {
    if (bytes[i] < 2 || bytes[i] > 38 || bytes[i + 1] > 36 || bytes[i + 2] > 36) return 'Key values out of range';
  }
  let colors = '';
  if (b.colors !== undefined && b.colors !== null && b.colors !== '') {
    if (typeof b.colors !== 'string' || !/^[A-Za-z0-9_-]+$/.test(b.colors) || b.colors.length > 760) return 'Invalid colour data';
    const cb = Buffer.from(b.colors, 'base64url');
    if (!cb.length || cb.length % 4 || cb.length > 4 * 140) return 'Invalid colour data';
    for (let i = 0; i < cb.length; i += 4) if (cb[i] >= 140) return 'Invalid colour data';
    colors = b.colors;
  }
  return {
    name,
    author: clean(b.author, 24) || 'Anonymous',
    note: clean(b.note, 160),
    model,
    family: b.family,
    rt: b.rt ? 1 : 0,
    keys: b.keys,
    ...(colors ? { colors } : {}),
  };
}

// ---------------------------------------------------------------- handler
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const store = getStore();
  if (!store) {
    res.status(503).json({ error: 'Preset storage is not configured. Add Upstash Redis in the Vercel dashboard.' });
    return;
  }
  const q = new URL(req.url, 'http://x').searchParams;
  const id = (q.get('id') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);

  try {
    if (req.method === 'GET') {
      if (id) {
        const item = await store.get(id);
        if (!item) { res.status(404).json({ error: 'Preset not found' }); return; }
        delete item.tokenHash;
        res.status(200).json({ item });
        return;
      }
      const items = (await store.list()).map(({ tokenHash, ...x }) => x);
      res.status(200).json({ items });
      return;
    }

    if (req.method === 'POST' && id && q.get('use')) {
      if ((await store.hit(hourKey('use', req))) > RATE_LIMIT_USES) { res.status(429).json({ error: 'Too many requests' }); return; }
      if (!(await store.get(id))) { res.status(404).json({ error: 'Preset not found' }); return; }
      res.status(200).json({ uses: await store.use(id) });
      return;
    }

    if (req.method === 'POST') {
      const n = await store.hit(hourKey('pub', req));
      if (n > RATE_LIMIT) { res.status(429).json({ error: 'Too many presets published from this network. Try again later.' }); return; }
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
      const v = validate(body);
      if (typeof v === 'string') { res.status(400).json({ error: v }); return; }
      const token = crypto.randomBytes(18).toString('base64url');
      const item = { id: crypto.randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x'), ...v, created: Date.now(), tokenHash: sha(token) };
      await store.add(item);
      delete item.tokenHash;
      res.status(201).json({ item: { ...item, uses: 0 }, token });
      return;
    }

    if (req.method === 'DELETE' && id) {
      const item = await store.get(id);
      if (!item) { res.status(404).json({ error: 'Preset not found' }); return; }
      const token = String(req.headers['x-delete-token'] || q.get('token') || ''); // query: older clients
      if (!token || !item.tokenHash || !sameHash(sha(token), item.tokenHash)) { res.status(403).json({ error: 'Only the author can delete this preset' }); return; }
      await store.remove(id);
      res.status(200).json({ ok: true });
      return;
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    // Details stay in the server log; the browser only learns that something failed.
    console.error('presets api:', e);
    res.status(500).json({ error: 'Preset storage error, try again later' });
  }
};
