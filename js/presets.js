/*
 * Preset encoding, built-in presets and the /api/presets client.
 * A preset's key data is 3 bytes per key (actuation, RT press, RT release) × 10, base64url-encoded,
 * so it fits into a share link even without the community backend.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- base64url
  function bytesToB64u(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64uToBytes(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  }
  const textToB64u = (t) => bytesToB64u(new TextEncoder().encode(t));
  const b64uToText = (s) => new TextDecoder().decode(b64uToBytes(s));

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ---------------------------------------------------------------- key data
  function encodeKeys(keysArray) {
    const out = new Uint8Array(keysArray.length * 3);
    keysArray.forEach((k, i) => {
      out[i * 3] = clamp(Math.round((k.action_point || 2) * 10), 2, 38);
      out[i * 3 + 1] = clamp(Math.round((k.downstroke || 0) * 10), 0, 36);
      out[i * 3 + 2] = clamp(Math.round((k.upstroke || 0) * 10), 0, 36);
    });
    return bytesToB64u(out);
  }
  function decodeKeys(str) {
    const b = b64uToBytes(str);
    const keys = [];
    // Same limits the server checks: a hand-made link must not carry values the keyboard can't take.
    for (let i = 0; i + 2 < b.length && keys.length < 140; i += 3) keys.push({ ap: clamp(b[i], 2, 38) / 10, ds: clamp(b[i + 1], 0, 36) / 10, us: clamp(b[i + 2], 0, 36) / 10 });
    return keys;
  }

  // ---------------------------------------------------------------- per-key colours
  // Only painted keys are stored: 4 bytes each (key index, R, G, B), base64url-encoded.
  function encodeColors(map) {
    const list = [...map].filter(([i, hex]) => i >= 0 && i < 256 && /^[0-9a-f]{6}$/i.test(hex)).sort((a, b) => a[0] - b[0]);
    if (!list.length) return '';
    const out = new Uint8Array(list.length * 4);
    list.forEach(([i, hex], n) => {
      out[n * 4] = i;
      for (let c = 0; c < 3; c++) out[n * 4 + 1 + c] = parseInt(hex.slice(c * 2, c * 2 + 2), 16);
    });
    return bytesToB64u(out);
  }
  function decodeColors(str) {
    const map = new Map();
    if (!str) return map;
    const b = b64uToBytes(str);
    for (let i = 0; i + 3 < b.length && map.size < 140; i += 4) map.set(b[i], [b[i + 1], b[i + 2], b[i + 3]].map((v) => v.toString(16).padStart(2, '0')).join(''));
    return map;
  }

  // Stats over the keys that exist on the given layout (indices list).
  function stats(keys, indices) {
    const list = (indices || keys.map((_, i) => i)).map((i) => keys[i]).filter(Boolean);
    if (!list.length) return { ap: 0, apMin: 0, apMax: 0, ds: 0, us: 0 };
    const avg = (f) => list.reduce((s, k) => s + f(k), 0) / list.length;
    return {
      ap: avg((k) => k.ap),
      apMin: Math.min(...list.map((k) => k.ap)),
      apMax: Math.max(...list.map((k) => k.ap)),
      ds: avg((k) => k.ds),
      us: avg((k) => k.us),
    };
  }

  // ---------------------------------------------------------------- built-ins
  // Generated for the connected layout so they always match its key indices.
  function builtins(model, type, keyCount) {
    const keys = [];
    for (const row of model.layout.rows) for (const k of row) if (k.i !== undefined) keys.push(k);
    const label = new Map(keys.map((k) => [k.i, k.label]));
    const is = (i, re) => re.test(label.get(i) || '');
    const make = (id, name, note, rt, fn) => {
      const arr = [];
      for (let i = 0; i < keyCount; i++) {
        const [ap, ds, us] = fn(i);
        arr.push({ action_point: ap, downstroke: ds, upstroke: us });
      }
      return { id: 'builtin:' + id, builtin: true, name, author: 'DrunkDeer Control', note, model: type, family: model.family, rt, keys: encodeKeys(arr), created: 0, uses: 0 };
    };
    const MOVE = /^(w|a|s|d|Space|Shift|Ctrl|CapsLk)$/;
    const GAME = /^(w|a|s|d|q|e|r|f|c|x|z|g|v|1|2|3|4|5|Space|Shift|Ctrl|Tab|CapsLk)$/;
    return [
      make('fps', 'FPS Precision', 'Hair-trigger movement keys (WASD, Space, Shift, Ctrl) with 0.1 mm Rapid Trigger; everything else stays relaxed to avoid accidental presses.', 1,
        (i) => (is(i, MOVE) ? [0.3, 0.1, 0.1] : [1.5, 0.5, 0.5])),
      make('esports', 'Esports All-in', 'Every key at 0.4 mm with the tightest Rapid Trigger. Maximum speed, demands a light touch.', 1,
        () => [0.4, 0.1, 0.1]),
      make('moba', 'MOBA / MMO', 'Ability and movement cluster at 0.8 mm with 0.2 mm RT, the rest at a comfortable 1.6 mm.', 1,
        (i) => (is(i, GAME) ? [0.8, 0.2, 0.2] : [1.6, 0.4, 0.4])),
      make('balanced', 'Balanced', 'A safe all-rounder: 1.2 mm actuation, 0.3 mm Rapid Trigger on every key.', 1,
        () => [1.2, 0.3, 0.3]),
      make('typing', 'Typing', 'Classic 2.0 mm actuation for fewer typos. Rapid Trigger off.', 0,
        () => [2.0, 0.5, 0.5]),
      make('heavy', 'Heavy Hands', 'Deep 3.0 mm actuation for people who rest their fingers on the keys.', 0,
        () => [3.0, 0.8, 0.8]),
    ];
  }

  // ---------------------------------------------------------------- share links
  function shareData(p) {
    return textToB64u(JSON.stringify({ v: 1, n: p.name, a: p.author, o: p.note || '', m: p.model, f: p.family, r: p.rt ? 1 : 0, k: p.keys, ...(p.colors ? { c: p.colors } : {}) }));
  }
  function linkFor(p) {
    const base = location.origin + location.pathname;
    return p.id && !String(p.id).startsWith('builtin:') && !String(p.id).startsWith('link:') && !p.local
      ? `${base}?p=${encodeURIComponent(p.id)}`
      : `${base}#share=${shareData(p)}`;
  }
  function fromShareData(str) {
    if (str.length > 4000) throw new Error('bad');
    const o = JSON.parse(b64uToText(str));
    if (!o || typeof o.k !== 'string' || o.k.length > 600 || !/^[A-Za-z0-9_-]+$/.test(o.k)) throw new Error('bad');
    decodeKeys(o.k); // validates base64
    let colors = '';
    if (typeof o.c === 'string' && o.c.length <= 760 && /^[A-Za-z0-9_-]+$/.test(o.c)) { try { decodeColors(o.c); colors = o.c; } catch { colors = ''; } }
    return { id: 'link:' + o.k.slice(0, 10), linked: true, name: String(o.n || 'Shared preset').slice(0, 40), author: String(o.a || 'Anonymous').slice(0, 24), note: String(o.o || '').slice(0, 160), model: Number(o.m) || 0, family: String(o.f || ''), rt: o.r ? 1 : 0, keys: o.k, colors, created: 0, uses: 0 };
  }
  // ?p=<id>  or  #share=<data>
  function readIncoming() {
    const q = new URLSearchParams(location.search);
    if (q.get('p')) return { id: q.get('p') };
    const m = location.hash.match(/^#share=([A-Za-z0-9_-]+)$/);
    if (m) { try { return { preset: fromShareData(m[1]) }; } catch { return { error: true }; } }
    return null;
  }

  // ---------------------------------------------------------------- API client
  const API = 'api/presets';
  async function call(method, query = '', body, headers = {}) {
    const r = await fetch(API + query, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await r.json(); } catch { /* not JSON: static host without the function */ }
    if (!r.ok || !data) {
      const err = new Error((data && data.error) || (r.status === 404 ? 'Community library is not available on this host' : 'Request failed (' + r.status + ')'));
      err.status = r.status;
      throw err;
    }
    return data;
  }
  const api = {
    list: () => call('GET').then((d) => d.items || []),
    get: (id) => call('GET', '?id=' + encodeURIComponent(id)).then((d) => d.item),
    publish: (p) => call('POST', '', p),
    use: (id) => call('POST', '?use=1&id=' + encodeURIComponent(id)).catch(() => null),
    // The delete token goes in a header so it never lands in URLs, server logs or history.
    remove: (id, token) => call('DELETE', '?id=' + encodeURIComponent(id), undefined, { 'X-Delete-Token': token || '' }),
  };

  // Presets this browser published: { id: token }
  const MINE = 'nui.mine';
  const mine = {
    all() { try { return JSON.parse(localStorage.getItem(MINE) || '{}'); } catch { return {}; } },
    add(id, token) { const m = mine.all(); m[id] = token; try { localStorage.setItem(MINE, JSON.stringify(m)); } catch { /* ignore */ } },
    drop(id) { const m = mine.all(); delete m[id]; try { localStorage.setItem(MINE, JSON.stringify(m)); } catch { /* ignore */ } },
  };

  window.DDPresets = { encodeKeys, decodeKeys, encodeColors, decodeColors, stats, builtins, linkFor, readIncoming, api, mine };
})();
