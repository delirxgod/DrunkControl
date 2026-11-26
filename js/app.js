/*
 * DrunkDeer Control — new UI on top of the original protocol layer (lib/mini.js).
 * mini.js provides keyboardComm (WebHID transport + packet builders) and the
 * per-model profile / colour / remap classes. This file only drives the UI.
 */
(() => {
  'use strict';

  const { MODELS, DEMO_CODES } = window.DDLayouts;
  const PR = window.DDPresets;
  const LANG = 'English';
  const DRIVER_VERSION = '1.0.0'; // version of this web driver UI
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v) => (Math.round(Number(v || 0) * 10) / 10).toFixed(1);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };
  const mobile = window.matchMedia('(max-width: 760px)');

  // ---------------------------------------------------------------- state
  const S = {
    comm: null,
    demo: false,
    connected: false,
    everConnected: false,
    device: null,
    type: 0,
    model: null,
    tab: 'perf',
    sel: new Set(),
    profile: null,
    turbo: false,
    rt: false,
    tracking: false,
    customDisabled: false,
    importTarget: 'perf',
    light: { mode: 0, paint: new Map(), color: 'ff7979' },
    remap: { name: null, layer: 1, group: 1, dirty: false },
    presets: { builtins: [], community: [], status: 'idle', error: '', filter: 'all', q: '', selected: null, metric: 'ap', incoming: null, loadedAt: 0 },
    keyEls: new Map(),
    U: 0,
    prefs: { vals: 'faint', anim: true, author: '' },
  };
  try { Object.assign(S.prefs, JSON.parse(ls.get('nui.prefs') || '{}')); } catch { /* defaults */ }
  const savePrefs = () => ls.set('nui.prefs', JSON.stringify(S.prefs));
  const applyAnimPref = () => document.documentElement.classList.toggle('no-anim', !S.prefs.anim);
  applyAnimPref();

  // Text for remap targets whose original labels are Chinese.
  const GROUP_NAMES = ['Lighting & tools', 'Letters & symbols', 'Number row', 'Numpad', 'Nav & F-keys', 'Modifiers', 'Media', 'Mouse'];
  const GROUP_TEXT = {
    0: ['Light on/off', 'Effect cycle', 'Colour cycle', 'Effect pause', 'Prev effect', 'Next effect', 'Bright +', 'Bright −', 'Speed +', 'Speed −', 'Win lock', 'RDT', 'LW'],
    6: ['Volume +', 'Volume −', 'Prev track', 'Next track', 'Mute', 'Play/Pause', 'Stop'],
    7: ['Left click', 'Middle click', 'Right click', 'Scroll up', 'Scroll down', 'Scroll left', 'Scroll right'],
  };
  const keyTargetText = (group, index, text) => (GROUP_TEXT[group] && GROUP_TEXT[group][index]) || text || '?';

  // ---------------------------------------------------------------- toasts / dialogs
  function toast(msg, kind = '') {
    if (!msg) return;
    const box = $('#toasts');
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.textContent = msg;
    box.append(t);
    while (box.children.length > 4) box.firstElementChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, kind === 'err' ? 5000 : 2600);
  }

  let dialogDone = null;
  function formDialog({ title, ok = 'OK', cancel = 'Cancel', fields = [], html = '' }) {
    const dlg = $('#modal');
    $('#modal-title').textContent = title;
    const okBtn = $('#modal-ok');
    okBtn.textContent = ok || '';
    okBtn.hidden = !ok;
    $('#modal form .btn:not(.primary)').textContent = cancel;
    const body = $('#modal-body');
    body.innerHTML = html + fields.map((f) => {
      if (f.type === 'checkbox') return `<label class="switch"><input type="checkbox" name="${f.id}" ${f.value ? 'checked' : ''} ${f.disabled ? 'disabled' : ''}> ${esc(f.label)}</label>`;
      if (f.type === 'textarea') return `<label class="f">${esc(f.label)}<textarea name="${f.id}" maxlength="${f.max || 160}" rows="3" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea></label>`;
      return `<label class="f">${esc(f.label)}<input type="text" name="${f.id}" maxlength="${f.max || 40}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''} autocomplete="off"></label>`;
    }).join('');
    // One shared <dialog>: if a new form replaces one that is still open, the old one resolves as
    // cancelled instead of later picking up the new form's answer (and its listener is dropped).
    if (dialogDone) dialogDone(null);
    return new Promise((resolve) => {
      const finish = (v) => { dlg.removeEventListener('close', onClose); dialogDone = null; resolve(v); };
      function onClose() {
        if (dlg.returnValue !== 'ok') { finish(null); return; }
        const out = {};
        for (const f of fields) {
          const el = body.querySelector(`[name="${f.id}"]`);
          out[f.id] = f.type === 'checkbox' ? el.checked : el.value.trim();
        }
        finish(out);
      }
      dialogDone = finish;
      dlg.addEventListener('close', onClose);
      dlg.returnValue = '';
      if (!dlg.open) dlg.showModal();
      const first = body.querySelector('input[type=text]:not([readonly]), textarea');
      if (first) first.select();
    });
  }
  const ask = (title, value) => formDialog({ title, fields: [{ id: 'v', label: 'Name', value, required: true }] }).then((r) => (r ? r.v : null));
  const confirmDialog = (title, text, ok = 'Confirm') => formDialog({ title, ok, html: `<p>${esc(text)}</p>` }).then(Boolean);

  function download(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name.replace(/[\\/:*?"<>|]+/g, '_') + '.json';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function copyText(text, input) {
    try { await navigator.clipboard.writeText(text); toast('Link copied', 'ok'); return true; } catch { /* fall back */ }
    if (input) { input.select(); try { if (document.execCommand('copy')) { toast('Link copied', 'ok'); return true; } } catch { /* ignore */ } }
    return false;
  }

  // ---------------------------------------------------------------- safety layer over mini.js
  // mini.js is DrunkDeer's official protocol code, kept byte-for-byte unchanged. It turns whatever it
  // is given into raw packets without checks. Known traps:
  //  * remap pages: a key with an unknown keyType shifts every later key on that page by 5 bytes,
  //    so command/code bytes land in the "key index" slots of the keyboard's remap table;
  //  * a layer shorter than 126 keys throws half-way through a 14-page upload (partial write);
  //  * NaN key values become 0 mm actuation; colour data from storage is sent unchecked.
  // These wrappers validate right before a packet is built and refuse to send instead.
  const REMAP_KEYS = 126;
  const isByte = (v) => Number.isInteger(v) && v >= 0 && v <= 255;
  const num = (v) => (typeof v === 'string' && v.trim() ? Number(v) : v);
  let remapWhitelist = null;
  // Every cmd:type:code combination mini.js itself can produce for this model.
  function remapAllowed(r) {
    if (remapWhitelist && remapWhitelist.owner === r) return remapWhitelist.set;
    const set = new Set();
    const add = (k) => set.add(k.keyCmd + ':' + k.keyType + ':' + k.keyCode);
    for (let g = 0; g < 8; g++) (r['command_array_group' + g] || []).forEach(add);
    for (const l of [r.keyCodeLayer0, r.keyCodeLayer1, r.keyCodeLayer2]) (l || []).forEach(add);
    remapWhitelist = { owner: r, set };
    return set;
  }
  // '' when the layer is safe to send, otherwise the reason.
  function checkRemapLayer(layer, allowed) {
    if (!Array.isArray(layer) || layer.length < REMAP_KEYS) return 'a key layer has the wrong size';
    for (let i = 0; i < REMAP_KEYS; i++) {
      const k = layer[i];
      if (!k || typeof k !== 'object') return `key #${i} is missing`;
      if (!k.keyCmd) continue; // sent as an empty slot: firmware default
      if (!isByte(k.keyCmd) || !Number.isInteger(k.keyType)) return `key #${i} has a broken command`;
      if (k.keyType === 4) {
        if (![k.rtpNumber, k.groupNumber, k.posInGroup].every(isByte)) return `key #${i} has a broken Dual-Trigger mark`;
        continue;
      }
      if (!allowed.has(k.keyCmd + ':' + k.keyType + ':' + k.keyCode)) return `key #${i} has an unknown command`;
    }
    return '';
  }

  function installSafety() {
    if (typeof keyboardComm === 'undefined' || keyboardComm.prototype.__ddSafe) return;
    const KC = keyboardComm.prototype;
    KC.__ddSafe = true;
    const refuse = (what, why) => { toast(`Not sent to the keyboard: ${what} — ${why}.`, 'err'); console.warn('[safety]', what, why); return false; };

    // Key settings: complete 126-key array, real numbers only.
    const saveKbd = KC.event_start_save_kbd;
    KC.event_start_save_kbd = function (pf) {
      if (!pf || !Array.isArray(pf.keys_array)) return refuse('key settings', 'the profile is damaged');
      for (let i = 0; i < REMAP_KEYS; i++) {
        const k = pf.keys_array[i];
        if (!k || typeof k !== 'object') pf.keys_array[i] = { keyname: '', action_point: 2, downstroke: 0, upstroke: 0 };
      }
      sanitizeProfile(pf);
      return saveKbd.call(this, pf);
    };

    // Turbo / RT switch: strictly 0/1, mode 0..3 (true instead of 1 would skip mini.js's own Turbo guard).
    const sw = KC.event_update_common_switch;
    KC.event_update_common_switch = function (turbo, rt, mode) {
      const t = turbo ? 1 : 0, m = num(mode);
      return sw.call(this, t, rt ? 1 : 0, t ? 0 : (Number.isInteger(m) && m >= 0 && m <= 3 ? m : 0));
    };

    // Lighting mode: existing mode, speed/brightness 0..9, preset colour 0..6.
    const led = KC.event_set_led_mode;
    KC.event_set_led_mode = function (zero, mode, speed, bright, preset) {
      const n = this.colourObject ? this.colourObject.apiGetAllColours().length : 0;
      const [m, s, b, p] = [mode, speed, bright, preset].map(num);
      const in09 = (v) => Number.isInteger(v) && v >= 0 && v <= 9;
      if (!(Number.isInteger(m) && m >= 0 && m < n && in09(s) && in09(b) && Number.isInteger(p) && p >= 0 && p <= 6)) return refuse('lighting', 'a value is out of range');
      return led.call(this, 0, m, s, b, p);
    };

    // Per-key colours: [128+key, rr, gg, bb] groups only.
    const col = KC.transmit_color_report_packet;
    KC.transmit_color_report_packet = function (prefix, list, turbo, modeIndex, bright) {
      const hex = (v) => v === 0 || (typeof v === 'string' && /^[0-9a-f]{1,2}$/i.test(v));
      const b = num(bright);
      let ok = Array.isArray(list) && list.length % 4 === 0 && list.length <= 4 * REMAP_KEYS
        && (turbo === 0 || turbo === 1) && Number.isInteger(modeIndex) && modeIndex >= 0 && modeIndex < 64
        && Number.isInteger(b) && b >= 0 && b <= 9;
      for (let j = 0; ok && j < list.length; j += 4) {
        ok = Number.isInteger(list[j]) && list[j] >= 128 && list[j] < 128 + REMAP_KEYS && hex(list[j + 1]) && hex(list[j + 2]) && hex(list[j + 3]);
      }
      if (!ok) return refuse('key colours', 'the colour data is damaged');
      return col.call(this, prefix, list, turbo, modeIndex, b);
    };

    // Remap upload (3 layers × 14 pages): check everything before the first page goes out.
    if (typeof keyProfileBase !== 'undefined') {
      const KP = keyProfileBase.prototype;
      const remapSave = KP.remapSaveToKeyboard;
      KP.remapSaveToKeyboard = function (name) {
        const p = this.getProfileByName(name);
        if (!p) return false;
        const allowed = remapAllowed(this);
        for (const [layer, label] of [[p.keyCodeDefault, 'base'], [p.keyCodeFn1, 'Fn'], [p.keyCodeFn2, 'Fn2']]) {
          const why = checkRemapLayer(layer, allowed);
          if (why) return refuse(`key remap (${label} layer)`, why);
        }
        return remapSave.call(this, name);
      };
    }

    // Dual-Trigger / Last Win: rewrites the base remap layer, then the RTP slots.
    const rtpSave = KC.rtpSaveToKeyborard;
    KC.rtpSaveToKeyborard = function (first, settings, rtp, turbo) {
      const why = this.remapObject ? checkRemapLayer(first, remapAllowed(this.remapObject)) : 'no remap data';
      if (why) return refuse('Dual-Trigger / Last Win', why);
      if (!Array.isArray(settings) || !settings.every((s) => s && isByte(s.rtpNumber) && s.rtpNumber > 0 && isByte(s.keyCode))) return refuse('Dual-Trigger / Last Win', 'the pair data is damaged');
      rtpSave.call(this, first, settings, rtp || {}, turbo ? 1 : 0);
      return true;
    };
  }

  // Saved data that no longer parses makes mini.js throw while loading, and the driver then can't
  // connect at all ("the keyboard is dead"). Damaged entries are moved to nui.bad.* and defaults used.
  function repairStorage() {
    const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const layerOk = (l) => Array.isArray(l) && l.length >= REMAP_KEYS && l.every((k) => k && typeof k === 'object');
    const groups = [
      [P(), (o) => o && typeof o === 'object' && Array.isArray(o.keys_array)],
      [R(), (o) => o && typeof o === 'object' && layerOk(o.keyCodeDefault) && layerOk(o.keyCodeFn1) && layerOk(o.keyCodeFn2)],
      [C(), (o) => o && typeof o === 'object'],
    ];
    let keys = [];
    try { for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)); } catch { return; }
    let moved = 0;
    for (const [obj, valid] of groups) {
      if (!obj || !obj.storage_prefix) continue;
      const re = new RegExp('^' + reEsc(obj.storage_prefix) + '\\d+$');
      for (const k of keys) {
        const isCount = k === obj.storage_number;
        if (!isCount && !re.test(k)) continue;
        const raw = ls.get(k);
        let o;
        try { o = JSON.parse(raw); } catch { o = undefined; }
        if (isCount ? Number.isFinite(Number(o)) : valid(o)) continue;
        ls.set('nui.bad.' + k, raw ?? '');
        try { localStorage.removeItem(k); } catch { /* ignore */ }
        moved++;
      }
    }
    if (moved) toast(`${moved} damaged saved item${moved === 1 ? ' was' : 's were'} set aside (a backup is kept); defaults are used instead.`, 'err');
  }

  // ---------------------------------------------------------------- demo transport
  // Same surface the profile/colour/remap classes expect from keyboardComm, without hardware.
  // Every model mini.js fully supports (K82 has no lighting/remap classes, so it isn't offered).
  const DEMO_MODELS = {
    750: () => [profileA75Pro, colourA75Pro, keyProfileA75Pro],
    75: () => [profileA75, colourA75, keyProfileA75],
    751: () => [profileA75UK, colourA75UK, keyProfileA75UK],
    752: () => [profileA75FR, colourA75FR, keyProfileA75FR],
    753: () => [profileA75DE, colourA75DE, keyProfileA75DE],
    754: () => [profileG75, colourG75, keyProfileG75],
    755: () => [profileG75JP, colourG75JP, keyProfileG75JP],
    65: () => [profileG65, colourG65, keyProfileG65],
    650: () => [profileG65lite, colourG65lite, keyProfileG65lite],
    60: () => [profileG60, colourG60, keyProfileG60],
  };
  const demoType = (t) => (DEMO_MODELS[t] ? Number(t) : 750);
  const demoOptions = (cur) => [750, 75, 751, 752, 753, 754, 755, 65, 650, 60]
    .map((t) => `<option value="${t}" ${t === cur ? 'selected' : ''}>${esc(MODELS[t].name)}</option>`).join('');

  class DemoComm {
    constructor(type) {
      this.keyboard_type = type;
      this.firmware_version = 8;
      this.firmware_version_string = '0.08';
      this.web_version_string = '0.6';
      this.current_language = LANG;
      this.turbovalue = 0;
      this.rtvalue = 1;
      const [Prof, Col, Remap] = DEMO_MODELS[type]();
      this.profileObject = new Prof(this);
      this.colourObject = new Col(this);
      this.remapObject = new Remap(this);
    }
    getLanguage() { return getFullLanguage(); }
    get_current_language() { return this.current_language; }
    set_current_language(l) { this.current_language = l; }
    getResult(status, message) { return { status, message }; }
    get_show_rdp() { return true; }
    event_start_save_kbd() { return true; }
    event_update_common_switch(t, r) { this.turbovalue = t; this.rtvalue = r; return true; }
    rtpSaveToKeyborard(first, settings) { this.lastRtp = { slots: settings.length, marked: first.filter((k) => k.keyType === 4).length }; }
    event_set_led_mode() { return true; }
    buildPkt_custom_led_mode_select(list, turbo, mode, bright, prefix) {
      const flat = [];
      for (const row of list) for (const k of row) {
        const c = k.color;
        flat.push(128 + k.value, c ? c.slice(1, 3) : 0, c ? c.slice(3, 5) : 0, c ? c.slice(5, 7) : 0);
      }
      keyboardComm.prototype.saveColorStorage.call(this, flat, turbo, mode, bright, prefix);
    }
    transmit_color_report_packet() { }
    buildPkt_remap_key_array() { return new Uint8Array(63); }
    event_save_remap_to_keyboard() { }
    event_control_key_tracking(_e, on) { return this.getResult(true, on ? 'Key tracking enabled' : 'Key tracking disabled'); }
    apiUpdateFirmware() { return keyboardComm.prototype.apiUpdateFirmware.call(this); }
    manualDoc() { return keyboardComm.prototype.manualDoc.call(this); }
  }

  // ---------------------------------------------------------------- callbacks used by mini.js
  window.getLinkMessage = (t, msg) => {
    // After a disconnect mini.js still reports the closed link as an error: nothing to tell the user.
    if (S.demo || S.left) return;
    if (t >= 20) { onConnected(t); return; }
    if (t === 7) { S.customDisabled = true; toast('Firmware is older than required for custom lighting. Update it in Settings → Firmware.', 'err'); return; }
    if (t === 8) return; // G65 Lite notice from the original driver
    setBusy(false);
    toast(msg || 'Keyboard connection error', 'err');
    if (S.connected) onDisconnected();
  };
  window.getMessage = (kind, msg) => toast(msg, kind === 2 ? 'err' : 'ok');
  // Keyboard report (also after Fn-key toggles): keep the Lighting tab in step with the firmware.
  window.setTurboMode = (v) => {
    const on = Boolean(v), changed = on !== S.turbo;
    S.turbo = on;
    if (changed && S.model) syncTurboLight(on, false);
    renderModes();
  };
  window.setRapidTriggerMode = (v) => { S.rt = Boolean(v); renderModes(); };
  window.setRdtMode = () => { };
  window.setLwMode = () => { };
  window._set_keyboard_type = () => { };
  window._set_current_profile_name = () => { };
  window.updateKey = () => { };
  window.updateKeyHeight = (idx, pct) => setTravel(idx, pct);
  window.updateImportResult = (ok) => {
    if (!ok) { toast('Import failed: the file does not belong to this keyboard model.', 'err'); return; }
    toast('Profile imported', 'ok');
    if (S.importTarget === 'remap') {
      const names = R().remapGetProfileNames();
      S.remap.name = names[names.length - 1];
    } else {
      const names = P().apiGetAllProfileNames();
      selectProfile(names[names.length - 1]);
      scheduleSave();
    }
    renderPanel(false);
    paintKeys();
  };

  // ---------------------------------------------------------------- connection
  function setBusy(b) {
    $('#btn-connect').setAttribute('aria-busy', String(b));
    $('#btn-connect .connect-label').textContent = b ? 'Connecting…' : 'Connect Your Keyboard';
  }

  function newRealComm() {
    S.comm = new keyboardComm();
    S.demo = false;
    return S.comm;
  }

  function connect() {
    if (!('hid' in navigator)) { toast('WebHID is not available in this browser. Try desktop Chrome or Edge.', 'err'); return; }
    if (S.everConnected) {
      // A fresh page gives the protocol layer a clean state; the granted device reconnects automatically.
      try { sessionStorage.setItem('nui.reconnect', '1'); } catch { /* ignore */ }
      location.reload();
      return;
    }
    S.customDisabled = false;
    setBusy(true);
    (S.comm && !S.demo ? S.comm : newRealComm()).select_keyboard();
    setTimeout(() => { if (!S.connected) setBusy(false); }, 8000);
  }

  function startDemo(type) {
    type = demoType(type ?? ls.get('nui.demoModel'));
    ls.set('nui.demoModel', String(type));
    S.demo = true;
    S.comm = new DemoComm(type);
    S.type = type;
    S.model = MODELS[type];
    S.sel.clear(); // key indices differ between layouts
    S.connected = true;
    initData();
    showApp();
    toast(`Demo mode (${S.model.name}): settings are simulated, nothing is sent to a keyboard.`);
  }

  function switchDemo(type) {
    if (!S.demo || demoType(type) === S.type) return;
    leave();
    startDemo(type);
    openSettings('device');
  }

  function onConnected(type) {
    if (S.connected) return;
    const c = S.comm;
    if (!c.profileObject || typeof c.profileObject.apiLoadProfiles !== 'function') {
      setBusy(false);
      toast('This keyboard model is not supported by the web driver.', 'err');
      return;
    }
    S.type = type;
    S.model = MODELS[type] || MODELS[750];
    S.connected = true;
    S.everConnected = true;
    S.device = c.m_keyboard_instance;
    setBusy(false);
    initData();
    showApp();
    toast(`DrunkDeer ${S.model.name} connected`, 'ok');
  }

  // closeDelay lets packets already queued (e.g. "stop key tracking") reach the keyboard first.
  function onDisconnected(reason, closeDelay = 0) {
    S.connected = false;
    S.left = true; // reconnecting reloads the page, so this never needs resetting
    S.tracking = false;
    clearTimeout(saveTimer);
    const dev = S.device;
    S.device = null;
    const close = () => { try { if (dev && dev.opened) dev.close().catch(() => { }); } catch { /* ignore */ } };
    if (closeDelay) setTimeout(close, closeDelay); else close();
    if (reason) toast(reason, 'err');
    if ($('#settings').open) $('#settings').close();
    $('#app').hidden = true;
    $('#connect').hidden = false;
  }

  function leave() {
    if ($('#settings').open) $('#settings').close();
    if (S.demo) {
      if (S.tracking) toggleTracking(false); // removes the demo key listeners
      clearTimeout(saveTimer);
      S.demo = false;
      S.connected = false;
      S.comm = null;
      $('#app').hidden = true;
      $('#connect').hidden = false;
      return;
    }
    const wasTracking = S.tracking;
    if (wasTracking) toggleTracking(false);
    onDisconnected(null, wasTracking ? 300 : 0);
  }

  // ---------------------------------------------------------------- data init
  const P = () => S.comm.profileObject;
  const C = () => S.comm.colourObject;
  const R = () => S.comm.remapObject;
  const prof = () => P().getProfileByName(S.profile);

  function initData() {
    const c = S.comm;
    c.set_current_language(LANG);
    S.sel.clear();
    S.tracking = false;
    S.U = 0;

    repairStorage();
    P().apiLoadProfiles(LANG);
    const names = P().apiGetAllProfileNames();
    // Repair profiles damaged in storage (NaN / out of range) before any of them can be sent.
    for (const n of names) { const pf = P().getProfileByName(n); if (sanitizeProfile(pf)) P().writeProfileToStorage(pf); }
    const stored = ls.get('nui.profile.' + P().storage_prefix);
    S.profile = names.includes(stored) ? stored : names[0];

    if (C()) {
      C().apiLoadColours();
      const m = Number(ls.get('nui.light.' + C().storage_prefix));
      S.light.mode = Number.isFinite(m) && m < C().apiGetAllColours().length ? m : 0;
      if (isCustomMode(S.light.mode)) loadPaint();
    }
    if (R()) {
      R().remapLoadProfile(LANG);
      S.remap.name = R().remapGetProfileNames()[0];
      S.remap.dirty = false;
    }
    S.turbo = Boolean(c.turbovalue);
    S.rt = Boolean(c.rtvalue);
    syncTurboLight(S.turbo, false);
    S.presets.builtins = PR.builtins(S.model, S.type, prof().keys_array.length);
    if (!C() && S.tab === 'light') S.tab = 'perf';
    if (!R() && S.tab === 'remap') S.tab = 'perf';
    if (S.presets.incoming) { S.tab = 'presets'; S.presets.selected = S.presets.incoming.id; }
    if (S.tab === 'presets' && !S.presets.selected) S.presets.selected = S.presets.builtins[0].id;
  }

  function showApp() {
    $('#connect').hidden = true;
    $('#app').hidden = false;
    $('[data-tab="light"]').hidden = !C();
    $('[data-tab="remap"]').hidden = !R();
    renderHeader();
    renderAll();
    renderBoard();
    paintKeys();
    requestAnimationFrame(() => moveIndicator(true));
    if (S.tab === 'presets') loadCommunity();
  }

  // ---------------------------------------------------------------- header / nav
  function renderHeader() {
    $('#dev-model').textContent = S.model.name;
    $('#dev-status').textContent = S.demo ? 'Demo mode' : 'Connected';
    const c = S.comm || {};
    $('#ver-driver').textContent = 'v' + DRIVER_VERSION + (c.web_version_string ? ` · core ${c.web_version_string}` : '');
    $('#ver-fw').textContent = c.firmware_version_string ? 'v' + c.firmware_version_string : '—';
  }

  function renderModes() {
    $('#btn-rt').setAttribute('aria-pressed', String(S.rt));
    $('#btn-turbo').setAttribute('aria-pressed', String(S.turbo));
    if (!S.model) return;
    $$('.sl[data-rt]').forEach((el) => el.classList.toggle('dim', !S.rt));
    if (S.tab === 'perf') updatePerf();
    paintKeys();
  }

  function setSwitches(turbo, rt) {
    if (!S.connected) return false;
    const r = P().apiProfileChangeTurboAndRP(S.profile, turbo ? 1 : 0, rt ? 1 : 0);
    if (r && r.status) {
      S.turbo = turbo;
      S.rt = rt;
      if (turbo && S.tracking) toggleTracking(false);
      // The switch packet resets Dual-Trigger / Last Win on the keyboard: Turbo turns them off,
      // otherwise send the profile's mode again.
      const pf = prof(), rtp = pf && rtxSupported() ? rtpOf(pf) : null;
      if (rtp && turbo && (rtp.rdt_open || rtp.lw_open)) {
        rtp.rdt_open = false; rtp.lw_open = false; P().writeProfileToStorage(pf);
        toast('Dual-Trigger / Last Win turned off — they don’t work with Turbo mode', 'err');
      } else if (rtp) applyRtp();
      syncTurboLight(turbo, true);
      if (S.tab === 'perf') updatePerf();
    }
    if (r) toast(r.message, r.status ? 'ok' : 'err');
    renderModes();
    return Boolean(r && r.status);
  }

  // With Turbo on, the firmware drops whatever lighting was running and shows the static
  // "Turbo mode light" paint. Mirror that in the Lighting tab, and go back to the previous
  // mode when Turbo is turned off (send=false only updates the UI, e.g. on connect).
  const turboLightIndex = () => (C() ? C().apiGetAllColours().length - 2 : -1);
  const prevLightKey = () => 'nui.light.prev.' + C().storage_prefix;
  function rememberLight(mode) { if (C() && mode !== turboLightIndex()) ls.set(prevLightKey(), String(mode)); }
  function syncTurboLight(turbo, send) {
    if (!C() || S.customDisabled || S.type === 650) return; // G65 Lite: no per-key light modes (official skips it too)
    const t = turboLightIndex(), n = C().apiGetAllColours().length;
    if (turbo && S.light.mode !== t) {
      rememberLight(S.light.mode);
      S.light.mode = t;
      ls.set('nui.light.' + C().storage_prefix, String(t));
      loadPaint();
    } else if (!turbo && S.light.mode === t) {
      const prev = Number(ls.get(prevLightKey()));
      S.light.mode = Number.isInteger(prev) && prev >= 0 && prev < n && prev !== t ? prev : 0;
      if (isCustomMode(S.light.mode)) loadPaint();
      if (send) applyLightMode(); else ls.set('nui.light.' + C().storage_prefix, String(S.light.mode));
    } else return;
    if ($('#app').hidden) return; // still connecting: the first render picks the mode up
    if (S.tab === 'light') { renderTools(); renderPanel(false); }
    paintKeys();
  }

  function moveIndicator(instant) {
    const ind = $('.side-ind');
    const btn = $(`.side-btn[data-tab="${S.tab}"]`);
    if (!ind) return;
    if (!btn || btn.hidden) { ind.style.opacity = '0'; return; }
    if (instant) ind.style.transition = 'none';
    ind.style.opacity = '1';
    ind.style.transform = `translate(${btn.offsetLeft}px, ${btn.offsetTop}px)`;
    if (instant) { void ind.offsetWidth; ind.style.transition = ''; }
  }

  function setTab(tab) {
    if (S.tab === tab) return;
    S.tab = tab;
    S.sel.clear();
    if (tab === 'light' && isCustomMode(S.light.mode)) loadPaint();
    if (tab === 'presets') { if (!S.presets.selected) S.presets.selected = presetList()[0]?.id || null; loadCommunity(); }
    renderAll();
    moveIndicator();
  }

  // ---------------------------------------------------------------- keyboard rendering
  const ICONS = { '@up': 'ico-up', '@down': 'ico-down', '@left': 'ico-left', '@right': 'ico-right' };
  const ARIA = { '@up': 'Up', '@down': 'Down', '@left': 'Left', '@right': 'Right' };

  function allKeys() {
    const out = [];
    for (const row of S.model.layout.rows) for (const k of row) if (k.i !== undefined) out.push(k);
    return out;
  }
  function uniqueIndices() { return [...new Set(allKeys().map((k) => k.i))]; }

  function renderBoard() {
    const board = $('#board');
    board.textContent = '';
    board.style.width = '';
    S.keyEls.clear();
    S.U = 0;
    const L = S.model.layout;
    L.rows.forEach((row, r) => {
      let x = 0;
      for (const item of row) {
        if (item.gap) { x += item.gap; continue; }
        if (item.knob) {
          const kn = document.createElement('div');
          kn.className = 'knob';
          kn.dataset.x = x; kn.dataset.y = r; kn.dataset.w = 1;
          kn.style.setProperty('--d', Math.round(x * 16 + r * 34) + 'ms');
          board.append(kn);
          x += 1;
          continue;
        }
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'key ' + item.flags + (/^[a-z]$/.test(item.label) ? ' letter' : '');
        b.dataset.i = item.i;
        b.dataset.x = x; b.dataset.y = r; b.dataset.w = item.w;
        b.style.setProperty('--d', Math.round(x * 16 + r * 34) + 'ms');
        const icon = ICONS[item.label];
        b.innerHTML = '<span class="travel"></span><span class="lbl">' +
          (icon ? `<span class="ico ${icon}" aria-hidden="true"></span>` : esc(item.label)) +
          '</span><span class="val" hidden></span>';
        b.setAttribute('aria-label', ARIA[item.label] || item.label);
        board.append(b);
        if (!S.keyEls.has(item.i)) S.keyEls.set(item.i, []);
        S.keyEls.get(item.i).push(b);
        x += item.w;
      }
    });
    board.classList.add('intro');
    setTimeout(() => board.classList.remove('intro'), 1300);
    layoutBoard();
  }

  // Fits the keyboard into the space left by the top bar and the fixed-height panel (no page scroll on desktop).
  function layoutBoard() {
    if (!S.model || $('#app').hidden) return;
    const inner = $('#board-scroll');
    const outer = $('.board-outer');
    const main = $('.main');
    const board = $('#board');
    const cs = getComputedStyle(inner);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const L = S.model.layout;
    const rows = L.rows.length;
    let U = (inner.clientWidth - padX) / L.cols;
    if (!mobile.matches) {
      const chrome = outer.offsetHeight - (inner.clientHeight - padY);
      const availH = main.clientHeight - $('#panel').offsetHeight - parseFloat(getComputedStyle(main).rowGap || 0) - chrome;
      U = Math.min(U, availH / (rows * 0.98));
    }
    U = Math.floor(clamp(U, mobile.matches ? 32 : 34, 84));
    if (U === S.U) return;
    S.U = U;
    const gap = Math.max(3, Math.round(U * 0.07));
    const rowPitch = Math.round(U * 0.98);
    board.style.setProperty('--u', U + 'px');
    board.style.width = L.cols * U - gap + 'px';
    board.style.height = rows * rowPitch - gap + 'px';
    board.classList.toggle('compact', U < 50);
    for (const el of board.children) {
      const x = +el.dataset.x, y = +el.dataset.y, w = +el.dataset.w;
      el.style.left = x * U + 'px';
      el.style.top = y * rowPitch + 'px';
      el.style.width = w * U - gap + 'px';
      el.style.height = rowPitch - gap + 'px';
      if (el.classList.contains('iso-top')) el.style.height = rowPitch + 'px';
      if (el.classList.contains('knob')) {
        const d = rowPitch - gap;
        el.style.width = el.style.height = d + 'px';
        el.style.left = x * U + (U - gap - d) / 2 + 'px';
      }
    }
  }

  function previewPreset() {
    if (S.tab !== 'presets') return null;
    const p = presetList(true).find((x) => x.id === S.presets.selected);
    if (!p) return null;
    if (!p._keys) { try { p._keys = PR.decodeKeys(p.keys); } catch { p._keys = []; } }
    if (!p._colors) { try { p._colors = PR.decodeColors(p.colors); } catch { p._colors = new Map(); } }
    return p;
  }

  function paintKeys() {
    if (!S.model || !S.keyEls.size) return;
    const board = $('#board');
    const tab = S.tab;
    const pf = tab === 'perf' ? prof() : null;
    const custom = tab === 'light' && isCustomMode(S.light.mode);
    const remapKeys = tab === 'remap' && R() ? R().remapGetLayerKeys(S.remap.name, S.remap.layer) : null;
    const pv = previewPreset();
    const showColors = Boolean(pv && presetMetric(pv) === 'c');
    const metric = presetMetric(pv) === 'c' ? 'ap' : S.presets.metric;
    board.classList.toggle('colors', showColors);
    board.dataset.vals = tab === 'presets' ? 'always' : S.prefs.vals;
    board.classList.toggle('rt-off', Boolean((tab === 'perf' && !S.rt) || (pv && !pv.rt && metric === 'ap')));
    board.classList.toggle('heat', Boolean(pv));
    for (const [i, els] of S.keyEls) {
      for (const el of els) {
        el.classList.toggle('sel', S.sel.has(i));
        const val = el.querySelector('.val');
        let html = '';
        let mapped = false;
        let keep = false;
        if (pf) {
          const ks = pf.keys_array[i];
          if (ks) html = `<span class="a">${fmt(ks.action_point)}</span><span class="r">${fmt(ks.downstroke)} ${fmt(ks.upstroke)}</span>`;
        } else if (pv) {
          const k = pv._keys[i];
          if (k) {
            const v = k[metric];
            html = metric === 'ap'
              ? `<span class="a">${fmt(k.ap)}</span><span class="r">${fmt(k.ds)} ${fmt(k.us)}</span>`
              : `<span class="a" style="color:var(--rt)">${fmt(v)}</span>`;
            const t = metric === 'ap' ? 1 - (k.ap - 0.2) / 3.6 : (v > 0 ? 1 - (v - 0.1) / 3.5 : 0);
            el.style.setProperty('--heat', clamp(t, 0, 1).toFixed(3));
          } else el.style.setProperty('--heat', '0');
          keep = true;
        } else if (remapKeys) {
          const d = remapKeys[i];
          if (d && (d.keyMapped || (S.remap.layer > 1 && d.keyText))) {
            mapped = Boolean(d.keyMapped);
            keep = true;
            html = `<span class="m">${esc(d.keyMapped ? keyTargetText(d.groupId, d.groupIndex, d.keyText) : d.keyText)}</span>`;
          }
        }
        if (!pv) el.style.removeProperty('--heat');
        if (val.innerHTML !== html) val.innerHTML = html;
        val.hidden = !html;
        val.classList.toggle('keep', keep);
        el.classList.toggle('mapped', mapped);
        let sw = el.querySelector('.swatch');
        const color = custom ? S.light.paint.get(i) : showColors ? pv._colors.get(i) : null;
        if (color && showColors) el.style.setProperty('--kc', '#' + color); else el.style.removeProperty('--kc');
        if (color) {
          if (!sw) { sw = document.createElement('span'); sw.className = 'swatch'; el.append(sw); }
          sw.style.backgroundColor = '#' + color;
          sw.style.color = '#' + color;
        } else if (sw) sw.remove();
      }
    }
  }

  function setTravel(idx, pct) {
    const els = S.keyEls.get(idx);
    if (!els) return;
    for (const el of els) el.querySelector('.travel').style.height = clamp(pct, 0, 100) + '%';
  }

  function flashKey(i) {
    for (const el of S.keyEls.get(i) || []) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  }

  // ---------------------------------------------------------------- selection
  const canSelect = () => S.tab === 'perf' || S.tab === 'remap' || (S.tab === 'light' && isCustomMode(S.light.mode));

  function setSelected(i, on) {
    if (on) S.sel.add(i); else S.sel.delete(i);
    for (const el of S.keyEls.get(i) || []) el.classList.toggle('sel', on);
  }
  function selectionChanged() {
    if (S.tab === 'perf') updatePerf();
    if (S.tab === 'remap') updateRemapInfo();
  }

  let drag = null;
  let mouseHandled = false;
  function setupBoardEvents() {
    const board = $('#board');
    board.addEventListener('pointerdown', (e) => {
      const key = e.target.closest('.key');
      if (!key || !canSelect() || e.pointerType !== 'mouse' || e.button !== 0) return;
      mouseHandled = true;
      const i = +key.dataset.i;
      if (S.tab === 'remap' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        for (const s of [...S.sel]) setSelected(s, false);
        setSelected(i, true);
        selectionChanged();
        return;
      }
      drag = { add: !S.sel.has(i) };
      setSelected(i, drag.add);
      selectionChanged();
    });
    board.addEventListener('pointerover', (e) => {
      if (!drag) return;
      const key = e.target.closest('.key');
      if (key && S.sel.has(+key.dataset.i) !== drag.add) { setSelected(+key.dataset.i, drag.add); selectionChanged(); }
    });
    window.addEventListener('pointerup', () => { drag = null; });
    board.addEventListener('click', (e) => {
      const key = e.target.closest('.key');
      if (mouseHandled) { mouseHandled = false; return; }
      if (!key || !canSelect()) return;
      const i = +key.dataset.i;
      if (S.tab === 'remap') { for (const s of [...S.sel]) if (s !== i) setSelected(s, false); setSelected(i, true); }
      else setSelected(i, !S.sel.has(i));
      selectionChanged();
    });
  }

  function selectPreset(kind) {
    const keys = allKeys();
    let pick = [];
    if (kind === 'all') pick = keys.map((k) => k.i);
    else if (kind === 'letters') pick = keys.filter((k) => /^[a-z]$/.test(k.label)).map((k) => k.i);
    else if (kind === 'numbers') pick = keys.filter((k) => /^[0-9]$/.test(k.label)).map((k) => k.i);
    else if (kind === 'wasd') pick = keys.filter((k) => ['w', 'a', 's', 'd'].includes(k.label)).map((k) => k.i);
    S.sel = new Set(pick);
    paintKeys();
    selectionChanged();
  }

  // ---------------------------------------------------------------- tools above keyboard
  const QUICK = `<div class="chips" role="group" aria-label="Quick select">
      <button class="chip" type="button" data-pick="all">All</button>
      <button class="chip" type="button" data-pick="wasd">WASD</button>
      <button class="chip" type="button" data-pick="letters">Letters</button>
      <button class="chip" type="button" data-pick="numbers">Numbers</button>
      <button class="chip" type="button" data-pick="none">Clear</button>
    </div>`;

  const presetMetric = (pv) => (S.presets.metric === 'c' && !(pv && pv._colors && pv._colors.size) ? 'ap' : S.presets.metric);

  function renderTools() {
    const t = $('#board-tools');
    if (S.tab === 'remap') {
      t.innerHTML = `<div class="chips" role="group" aria-label="Layer">
          ${['Base layer', 'Fn layer', 'Fn2 layer'].map((n, i) => `<button class="chip" type="button" data-layer="${i + 1}" aria-pressed="${S.remap.layer === i + 1}">${n}</button>`).join('')}
        </div><span class="hint">Pick a key, then choose what it should do below</span>`;
    } else if (S.tab === 'light') {
      t.innerHTML = isCustomMode(S.light.mode)
        ? QUICK + '<span class="hint">Select keys, then pick a colour below</span>'
        : '<span class="hint">Choose “Custom light” or “Turbo mode light” to paint individual keys</span>';
    } else if (S.tab === 'presets') {
      const pv = previewPreset();
      t.innerHTML = `<div class="chips" role="group" aria-label="Preview value">
          <span class="sel-info" style="margin-right:6px">${pv ? `Preview · <b>${esc(pv.name)}</b>` : 'Pick a preset to preview it'}</span>
          ${[...(pv && pv._colors.size ? [['c', 'Colours']] : []), ['ap', 'Actuation'], ['ds', 'RT press'], ['us', 'RT release']].map(([k, n]) => `<button class="chip" type="button" data-metric="${k}" aria-pressed="${presetMetric(pv) === k}">${n}</button>`).join('')}
        </div>
        <div class="chips">${presetMetric(pv) === 'c' ? `<span class="legend">${pv._colors.size} painted key${pv._colors.size === 1 ? '' : 's'}</span>` : '<span class="legend">sensitive <i></i> deep</span>'}
          <button class="btn primary" type="button" data-act="p-share" style="height:30px"><span class="ico ico-share" aria-hidden="true"></span>Share my profile</button></div>`;
    } else {
      t.innerHTML = QUICK;
    }
  }

  // ---------------------------------------------------------------- slider component
  function sliderHTML(id, { min, max, step, value, disabled, lock }) {
    const p = clamp((value - min) / (max - min), 0, 1);
    return `<div class="slider${disabled ? ' off' : ''}" style="--p:${p}${lock ? ';--lk:1' : ''}">
      <input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" ${disabled ? 'disabled' : ''}>
      <span class="track"></span>${lock ? '<span class="lock" aria-hidden="true"></span>' : ''}<span class="fill"></span>${ticksHTML(min, max, step)}<span class="thumb"></span>
    </div>`;
  }
  // Minimal ruler under the track: a tick per unit step (0.1 mm or 1), taller every 0.5 mm / whole number.
  function ticksHTML(min, max, step) {
    const unit = step >= 1 ? 1 : 0.1;
    const major = step >= 1 ? max - min : 0.5;
    const out = [];
    const lo = Math.ceil(min / unit - 1e-6), hi = Math.floor(max / unit + 1e-6);
    for (let n = lo; n <= hi; n++) {
      const v = n * unit;
      const t = (v - min) / (max - min);
      const big = Math.abs(v / major - Math.round(v / major)) < 1e-6;
      out.push(`<i class="${big ? 'mj' : ''}" style="--t:${t.toFixed(4)}"></i>`);
    }
    return `<span class="ticks" aria-hidden="true">${out.join('')}</span>`;
  }
  function syncSlider(input) {
    const min = +input.min, max = +input.max;
    input.closest('.slider').style.setProperty('--p', clamp((+input.value - min) / (max - min), 0, 1));
  }
  function setSlider(id, value, disabled) {
    const input = $('#' + id);
    if (!input) return;
    input.value = value;
    input.disabled = disabled;
    input.closest('.slider').classList.toggle('off', disabled);
    syncSlider(input);
  }

  // ---------------------------------------------------------------- panels
  function renderAll() {
    $$('.side-btn[data-tab]').forEach((b) => {
      if (b.dataset.tab === S.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    renderModes();
    renderTools();
    renderPanel(true);
    paintKeys();
  }

  function renderPanel(animate) {
    const p = $('#panel');
    if (S.tab === 'perf') p.innerHTML = perfPanel();
    else if (S.tab === 'light') p.innerHTML = lightPanel();
    else if (S.tab === 'remap') p.innerHTML = remapPanel();
    else p.innerHTML = presetsPanel();
    p.scrollTop = 0;
    if (S.tab === 'perf') updatePerf();
    if (S.tab === 'remap') updateRemapInfo();
    if (S.tab === 'presets') { renderPresetList(); renderPresetDetail(false); }
    p.classList.remove('enter');
    if (animate) { void p.offsetWidth; p.classList.add('enter'); }
  }

  function profileBar(kind) {
    const names = kind === 'p' ? P().apiGetAllProfileNames() : R().remapGetProfileNames();
    const cur = kind === 'p' ? S.profile : S.remap.name;
    return `<select id="${kind}-profile" class="select" aria-label="${kind === 'p' ? 'Profile' : 'Remap profile'}">
        ${names.map((n) => `<option ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
      <div class="menu-wrap">
        <button class="btn icon" type="button" data-menu aria-haspopup="menu" aria-expanded="false" aria-label="Profile actions"><span class="ico ico-dots" aria-hidden="true"></span></button>
        <div class="menu" role="menu" hidden>
          <button type="button" data-act="${kind}-new">New profile</button>
          <button type="button" data-act="${kind}-rename">Rename</button>
          <button type="button" data-act="${kind}-dup">Duplicate</button>
          <hr>
          <button type="button" data-act="${kind}-export">Export to file</button>
          <button type="button" data-act="${kind}-import">Import from file</button>
          ${kind === 'p' ? '<button type="button" data-act="p-share">Share as preset…</button>' : ''}
          <hr>
          <button type="button" class="danger" data-act="${kind}-del">Delete</button>
        </div>
      </div>`;
  }

  // ---- Performance
  // Rapid Trigger works in the travel left below the actuation point, so its range shrinks as
  // actuation goes deeper (4.0 mm switch: actuation 3.0 → at most 1.0 mm of RT).
  const TRAVEL = 4.0, RT_MIN = 0.1, RT_MAX = 3.6, RT_WARN = 0.1;
  const rtRoom = (ap) => clamp(Math.round((TRAVEL - ap) * 10) / 10, RT_MIN, RT_MAX);
  // Tightest RT room among the selected keys (they can have different actuation points).
  function rtLimit(pf, sel) {
    return sel.length ? Math.min(...sel.map((i) => rtRoom(+pf.keys_array[i].action_point))) : RT_MAX;
  }
  // Pull RT press/release of the selected keys back inside the travel their actuation leaves.
  function clampRt(sel) {
    const pf = prof();
    if (!pf) return;
    for (const [kind, f] of [[1, 'downstroke'], [2, 'upstroke']]) {
      const byRoom = new Map();
      for (const i of sel) {
        const k = pf.keys_array[i];
        if (!k) continue;
        const room = rtRoom(+k.action_point);
        if (k[f] > room + 1e-6) byRoom.set(room, [...(byRoom.get(room) || []), i]);
      }
      for (const [room, idx] of byRoom) P().apiProfileChangeBySlider(kind, S.profile, idx, room);
    }
  }

  // Last line of defence before key settings reach the keyboard. mini.js clamps the ranges but
  // turns NaN into 0 mm actuation (a key that is always pressed), so broken values from storage,
  // files or shared links are replaced here. fitRt also pulls RT inside the travel actuation leaves.
  const KEY_LIM = { action_point: [0.2, 3.8, 2], downstroke: [0, RT_MAX, 0.5], upstroke: [0, RT_MAX, 0.5] };
  function sanitizeKey(k, fitRt) {
    let fixed = 0;
    for (const [f, [lo, hi, d]] of Object.entries(KEY_LIM)) {
      // null / '' / true would become 0 or 1 via Number(): treat anything but a real number as broken.
      const raw = k[f];
      const v = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
      const safe = Number.isFinite(v) ? clamp(Math.round(v * 10) / 10, lo, hi) : d;
      if (safe !== k[f]) { k[f] = safe; fixed++; }
    }
    if (fitRt) {
      const room = rtRoom(k.action_point);
      for (const f of ['downstroke', 'upstroke']) if (k[f] > room) { k[f] = room; fixed++; }
    }
    return fixed;
  }
  function sanitizeProfile(pf, fitRt) {
    let fixed = 0;
    for (const k of (pf && pf.keys_array) || []) if (k && typeof k === 'object') fixed += sanitizeKey(k, fitRt);
    return fixed;
  }

  // ---- Release Dual-Trigger / Last Win (newer firmware, see keyboardComm.get_show_rdp)
  // Stored in profile.rtp in the same shape the official driver uses, so profiles stay compatible.
  const RTX_MAX_LW = 5;
  const rtpDefault = () => ({ rdt_rtpSettings: [], rdt_watch_change: false, lw_temp_list: [], lw_rtpSettings: [], lw_watch_change: false, rtp_model: '', rdt_open: false, lw_open: false });
  const rtxSupported = () => Boolean(S.comm && S.comm.get_show_rdp && S.comm.get_show_rdp() && R());
  const rtpOf = (pf) => (pf.rtp && typeof pf.rtp === 'object' ? pf.rtp : (pf.rtp = rtpDefault()));
  const rtxMode = (rtp) => (rtp.rdt_open ? 'rdt' : rtp.lw_open ? 'lw' : 'off');
  const KEY_GLYPH = { '@up': '↑', '@down': '↓', '@left': '←', '@right': '→' };
  function modelKeys() {
    const seen = new Map();
    for (const row of S.model.layout.rows) for (const k of row) {
      if (k.i === undefined || seen.has(k.i)) continue;
      const l = KEY_GLYPH[k.label] || (k.label.length === 1 ? k.label.toUpperCase() : k.label);
      seen.set(k.i, l);
    }
    return seen;
  }
  const keyRef = (i) => { const n = modelKeys().get(i) || '#' + i; return { value: i, name: n, keyname: n }; };
  const CS2_RDT = [[44, 65], [64, 66], [65, 44], [66, 64]]; // W→S, A→D, S→W, D→A (official "CS2 preset")
  const CS2_LW = [[64, 66], [44, 65]];                       // A+D, W+S

  // Port of the official getRtpSettingParams(): marks keys on the base remap layer and builds the RTP slots.
  function rtpParams(keyCodeDefault, groups) {
    const out = {}; let num = 1, grp = 0;
    const first = JSON.parse(JSON.stringify(keyCodeDefault));
    const put = (k, v) => Object.assign(k, { keyType: 4, rtpNumber: v.rtpNumber, posInGroup: v.posInGroup, groupNumber: v.groupNumber, pos: v.pos, rdtEnabled: v.rdtEnabled });
    for (const { mainKey: a, triggerKey: g, isRdtEnabled: rdt } of groups) {
      const n = first[a.value], l = first[g.value];
      if (!n || !l) continue;
      if (rdt) {
        const slot = out[g.value] ?? { keyType: 4, rtpNumber: num++, posInGroup: 0, groupNumber: grp++, pos: g.value, rdtEnabled: true };
        put(n, { rtpNumber: slot.rtpNumber, posInGroup: 0, groupNumber: slot.groupNumber, pos: a.value, rdtEnabled: true });
        slot.keyCode = l.hotKeyCode || l.keyCode;
        out[g.value] = slot;
      } else {
        const s1 = out[a.value] ?? { keyType: 4, rtpNumber: num++, posInGroup: 0, groupNumber: grp, pos: a.value, rdtEnabled: true };
        const s2 = out[g.value] ?? { keyType: 4, rtpNumber: num++, posInGroup: 1, groupNumber: grp, pos: g.value, rdtEnabled: false };
        put(n, { rtpNumber: 0, posInGroup: s1.posInGroup, groupNumber: s1.groupNumber, pos: a.value, rdtEnabled: false });
        put(l, { rtpNumber: 0, posInGroup: s2.posInGroup, groupNumber: grp, pos: g.value, rdtEnabled: false });
        s1.keyCode = n.hotKeyCode || n.keyCode; s2.keyCode = l.hotKeyCode || l.keyCode;
        out[a.value] = s1; out[g.value] = s2;
        grp++;
      }
    }
    return { first, settings: Object.values(out) };
  }

  // Send the active mode (or "off") to the keyboard. Like the official driver, only while Rapid Trigger is on.
  function applyRtp() {
    if (!rtxSupported() || !S.rt) return false;
    const pf = prof(), remap = R().remapGetProfileByName(S.remap.name);
    if (!pf || !remap) return false;
    const rtp = rtpOf(pf);
    const groups = rtp.rdt_open ? rtp.rdt_rtpSettings : rtp.lw_open ? rtp.lw_rtpSettings : [];
    const { first, settings } = rtpParams(remap.keyCodeDefault, groups);
    return S.comm.rtpSaveToKeyborard(first, settings, rtp, S.turbo) !== false;
  }

  function rtxButtonHTML() {
    if (!S.model) return '';
    if (!rtxSupported()) return `<button class="btn rtx-btn" type="button" disabled title="Needs a newer firmware (Settings → Firmware)">Dual-Trigger · Last Win</button>`;
    const pf = prof(), rtp = pf ? rtpOf(pf) : rtpDefault(), m = rtxMode(rtp);
    const n = m === 'rdt' ? rtp.rdt_rtpSettings.length : m === 'lw' ? rtp.lw_rtpSettings.length : 0;
    const state = m === 'off' ? '<span class="badge">Off</span>' : `<span class="badge ok">${n} pair${n === 1 ? '' : 's'}</span>`;
    return `<button class="btn rtx-btn" type="button" data-act="rtx" aria-haspopup="dialog">${m === 'lw' ? 'Last Win' : m === 'rdt' ? 'Dual-Trigger' : 'Dual-Trigger · Last Win'} ${state}</button>`;
  }

  async function openRtx() {
    const pf = prof();
    if (!pf || !rtxSupported()) return;
    const src = rtpOf(pf);
    const d = { mode: rtxMode(src), rdt: src.rdt_rtpSettings.map((x) => ({ a: x.mainKey.value, b: x.triggerKey.value })), lw: src.lw_rtpSettings.map((x) => ({ a: x.mainKey.value, b: x.triggerKey.value })) };
    const keys = modelKeys();
    const sel = [...S.sel].filter((i) => keys.has(i));
    const opts = (v) => [...keys].map(([i, n]) => `<option value="${i}" ${i === v ? 'selected' : ''}>${esc(n)}</option>`).join('');
    const body = () => $('#modal-body');
    const render = () => {
      const list = d.mode === 'lw' ? d.lw : d.rdt;
      const arrow = d.mode === 'lw' ? '<span class="rtx-op">+</span>' : '<span class="rtx-op" title="release → taps">→</span>';
      const full = d.mode === 'lw' && list.length >= RTX_MAX_LW;
      const help = {
        off: 'Both extras are off. Rapid Trigger works as usual.',
        rdt: '<b>Release Dual-Trigger</b>: when you release the first key, the keyboard instantly taps the second one. Release A → tap D gives a perfect counter-strafe.',
        lw: '<b>Last Win</b>: when both keys of a pair are held, only the one pressed last counts (SOCD). Up to 5 pairs.',
      }[d.mode];
      body().querySelector('.rtx-dyn').innerHTML = `
        <p>${help}</p>
        ${d.mode === 'off' ? '' : `
          <ul class="rtx-list">${list.length ? list.map((p, n) => `<li><b>${esc(keys.get(p.a) || '#' + p.a)}</b>${arrow}<b>${esc(keys.get(p.b) || '#' + p.b)}</b>
            <button class="btn icon" type="button" data-rtx-del="${n}" aria-label="Remove pair"><span class="ico ico-close" aria-hidden="true"></span></button></li>`).join('')
            : '<li class="empty">No pairs yet — add one below or use the CS2 preset.</li>'}</ul>
          <div class="rtx-add">
            <select class="select" id="rtx-a" aria-label="${d.mode === 'lw' ? 'First key' : 'Released key'}" ${full ? 'disabled' : ''}>${opts(sel[0] ?? 64)}</select>${arrow}
            <select class="select" id="rtx-b" aria-label="${d.mode === 'lw' ? 'Second key' : 'Key to tap'}" ${full ? 'disabled' : ''}>${opts(sel[1] ?? 66)}</select>
            <button class="btn" type="button" data-rtx-add ${full ? 'disabled' : ''}>Add</button>
          </div>
          <div class="rtx-foot"><button class="btn" type="button" data-rtx-preset>Use CS2 preset</button>
            ${list.length ? '<button class="btn danger" type="button" data-rtx-clear>Clear all</button>' : ''}</div>
          <p class="rtx-err" id="rtx-err" role="alert"></p>`}
        ${d.mode !== 'off' && (!S.rt || S.turbo) ? `<p class="rtx-note">Saving will ${!S.rt ? 'turn Rapid Trigger on' : ''}${!S.rt && S.turbo ? ' and ' : ''}${S.turbo ? 'turn Turbo mode off' : ''} — ${d.mode === 'lw' ? 'Last Win' : 'Dual-Trigger'} needs it.</p>` : ''}`;
      body().querySelectorAll('[data-rtx-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.rtxMode === d.mode)));
    };
    const onClick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const list = d.mode === 'lw' ? d.lw : d.rdt;
      const err = (t) => { const el = $('#rtx-err'); if (el) el.textContent = t; };
      if (b.dataset.rtxMode) { d.mode = b.dataset.rtxMode; render(); return; }
      if (b.dataset.rtxDel !== undefined) { list.splice(+b.dataset.rtxDel, 1); render(); return; }
      if (b.dataset.rtxClear !== undefined) { list.length = 0; render(); return; }
      if (b.dataset.rtxPreset !== undefined) {
        const p = (d.mode === 'lw' ? CS2_LW : CS2_RDT).filter(([a, c]) => keys.has(a) && keys.has(c)).map(([a, c]) => ({ a, b: c }));
        list.splice(0, list.length, ...p); render(); return;
      }
      if (b.dataset.rtxAdd !== undefined) {
        const a = +$('#rtx-a').value, c = +$('#rtx-b').value;
        if (a === c) return err('Pick two different keys.');
        if (d.mode === 'rdt' && list.some((p) => p.a === a)) return err(`${keys.get(a)} already has a Dual-Trigger key.`);
        if (d.mode === 'lw') {
          if (list.length >= RTX_MAX_LW) return err('Last Win supports up to 5 pairs.');
          const used = list.flatMap((p) => [p.a, p.b]).find((k) => k === a || k === c);
          if (used !== undefined) return err(`${keys.get(used)} is already in a Last Win pair.`);
        }
        list.push({ a, b: c }); render();
      }
    };
    const html = `<div class="chips rtx-modes" role="group" aria-label="Mode">
        <button class="chip" type="button" data-rtx-mode="off">Off</button>
        <button class="chip" type="button" data-rtx-mode="rdt">Release Dual-Trigger</button>
        <button class="chip" type="button" data-rtx-mode="lw">Last Win</button></div><div class="rtx-dyn"></div>`;
    const done = formDialog({ title: 'Rapid Trigger extras', ok: 'Save to keyboard', html });
    $('#modal').classList.add('wide');
    render();
    body().addEventListener('click', onClick);
    const res = await done;
    body().removeEventListener('click', onClick);
    $('#modal').classList.remove('wide');
    if (!res) return;

    // Commit: same structure the official driver writes.
    const toPairs = (list, rdt) => list.map((p) => ({ isRdtEnabled: rdt, mainKey: keyRef(p.a), triggerKey: keyRef(p.b), ...(rdt ? { x2Reset: 0.5, x2Active: 3 } : {}) }));
    Object.assign(src, {
      rdt_rtpSettings: toPairs(d.rdt, true), rdt_watch_change: !src.rdt_watch_change,
      lw_rtpSettings: toPairs(d.lw, false), lw_temp_list: d.lw.map((p) => [keyRef(p.a), keyRef(p.b)]), lw_watch_change: !src.lw_watch_change,
      rdt_open: d.mode === 'rdt', lw_open: d.mode === 'lw', rtp_model: d.mode === 'off' ? src.rtp_model : d.mode,
    });
    P().writeProfileToStorage(pf);
    let ok;
    if (d.mode !== 'off' && (!S.rt || S.turbo)) { ok = setSwitches(false, true); if (!ok) return; } // re-applies RTP itself
    else ok = applyRtp();
    toast(d.mode === 'off' ? 'Dual-Trigger / Last Win turned off' : `${d.mode === 'lw' ? 'Last Win' : 'Dual-Trigger'} saved${S.demo ? ' (demo)' : ' to keyboard'}`, ok || !S.rt ? 'ok' : 'err');
    if (S.tab === 'perf') updatePerf();
    paintKeys();
  }

  function slCard(key, title, sub, cls, min, max, rt) {
    return `<div class="sl" ${rt ? 'data-rt' : ''} id="sl-${key}">
        <div class="sl-head">
          <div><h2 class="title">${title}</h2><p class="subtitle" id="sub-${key}" data-sub="${sub}">${sub}</p></div>
          <div class="sl-val ${cls}" id="v-${key}">—</div>
        </div>
        ${sliderHTML('s-' + key, { min, max, step: 0.1, value: min, disabled: true, lock: rt })}
        <div class="sl-foot"><span>${min.toFixed(1)} mm</span><span id="max-${key}">${max.toFixed(1)} mm</span></div>
      </div>`;
  }

  // Actuation card (Figma "Actuation"): switch render with a vertical travel slider on top.
  // Top of the track = shallow, bottom = deep, so the stem grows down like a pressed key.
  function apCard(min, max) {
    return `<div class="sl ap-card">
        <img class="ap-img" src="assets/switch.png" alt="" draggable="false">
        <h2 class="ap-title">Actuation</h2>
        <div class="slider vslider off" style="--p:0" title="Where the key registers">
          <input id="s-ap" type="range" min="${min}" max="${max}" step="0.1" value="${min}" disabled aria-label="Actuation point, mm">
          <span class="track"></span><span class="fill"></span><span class="thumb"></span>
        </div>
        <div class="ap-val none" id="v-ap">—</div>
      </div>`;
  }

  function perfPanel() {
    return `
      <div class="perf">
        ${apCard(0.2, 3.8)}
        <div class="perf-main">
          <div class="bar">
            ${profileBar('p')}
            <span id="rtx-slot">${rtxButtonHTML()}</span>
            <span id="sel-info" class="sel-info"></span>
            <span class="grow"></span>
            <label class="switch"><input id="tracking" type="checkbox" ${S.tracking ? 'checked' : ''}> Live key travel</label>
            <span id="save-state" class="save-state"></span>
          </div>
          <div class="sliders3">
            ${slCard('ds', 'Rapid Trigger', 'press sensitivity', 'rt', RT_MIN, RT_MAX, true)}
            ${slCard('us', 'RT release', 'release sensitivity', 'rt', RT_MIN, RT_MAX, true)}
          </div>
        </div>
      </div>`;
  }

  function updatePerf() {
    const pf = prof();
    const info = $('#sel-info');
    if (!info || !pf) return;
    const sel = [...S.sel].filter((i) => pf.keys_array[i]);
    info.innerHTML = sel.length ? `<b>${sel.length}</b> key${sel.length === 1 ? '' : 's'} selected` : 'Select keys on the keyboard';
    const first = sel.length ? pf.keys_array[sel[0]] : null;
    const fields = { ap: 'action_point', ds: 'downstroke', us: 'upstroke' };
    for (const [k, f] of Object.entries(fields)) {
      const v = first ? (k === 'ap' ? first[f] : Math.max(0.1, first[f])) : (k === 'ap' ? 2 : 0.5);
      const mixed = first && sel.some((i) => Math.abs(pf.keys_array[i][f] - first[f]) > 0.001);
      const el = $('#v-' + k);
      el.classList.toggle('none', !first);
      el.innerHTML = first ? `${fmt(v)}<small>mm</small>${mixed ? '<span class="mixed">mixed</span>' : ''}` : '—';
      setSlider('s-' + k, v, !first);
    }
    $$('.sl[data-rt]').forEach((el) => el.classList.toggle('dim', !S.rt));
    const slot = $('#rtx-slot');
    if (slot) slot.innerHTML = rtxButtonHTML();

    // Real RT range left after actuation + misclick warning for hair-trigger values.
    const lim = rtLimit(pf, sel);
    for (const k of ['ds', 'us']) {
      const card = $('#sl-' + k), sub = $('#sub-' + k), max = $('#max-' + k), input = $('#s-' + k);
      if (!card) continue;
      const limited = first && lim < RT_MAX - 1e-6;
      input.closest('.slider').style.setProperty('--lk', limited ? (lim - RT_MIN) / (RT_MAX - RT_MIN) : 1);
      max.textContent = limited ? `${fmt(lim)} mm left` : `${fmt(RT_MAX)} mm`;
      max.classList.toggle('limited', !!limited);
      max.title = limited ? `Actuation at ${fmt(first.action_point)} mm leaves ${fmt(lim)} mm of travel for Rapid Trigger` : '';
      const v = first ? +first[k === 'ds' ? 'downstroke' : 'upstroke'] : 1;
      const warn = S.rt && first && v <= RT_WARN + 1e-6;
      card.classList.toggle('warn', !!warn);
      sub.textContent = k === 'ds' && !S.rt ? 'Rapid Trigger is off'
        : warn ? `⚠ ${fmt(RT_WARN)} mm is very sensitive — may cause misclicks` : sub.dataset.sub;
    }
  }

  let saveTimer = null;
  function scheduleSave() {
    const st = $('#save-state');
    if (st) { st.textContent = 'Saving…'; st.className = 'save-state busy'; }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!S.connected) return;
      sanitizeProfile(prof());
      const ok = P().apiSaveProfileSolution(S.profile);
      if (ok) applyRtp(); // the official driver re-sends RTP after every profile save
      const s = $('#save-state');
      if (s) { s.textContent = ok ? (S.demo ? 'Saved (demo)' : 'Saved to keyboard') : 'Save failed'; s.className = 'save-state ' + (ok ? 'done' : ''); }
      if (!ok) toast('Could not send the profile to the keyboard', 'err');
    }, 350);
  }

  function selectProfile(name) {
    S.profile = name;
    ls.set('nui.profile.' + P().storage_prefix, name);
  }

  async function profileAction(act) {
    const p = P();
    switch (act) {
      case 'p-new': { const it = p.apiProfileCreateNew(LANG); selectProfile(it.showname); scheduleSave(); break; }
      case 'p-dup': { const it = p.apiProfileDuplicate(LANG, S.profile); selectProfile(it.showname); toast('Profile duplicated', 'ok'); break; }
      case 'p-rename': {
        const n = await ask('Rename profile', S.profile);
        if (!n || n === S.profile) return;
        if (p.apiProfileChangeName(S.profile, n)) { selectProfile(n); toast('Profile renamed', 'ok'); } else { toast('A profile with this name already exists', 'err'); return; }
        break;
      }
      case 'p-del': {
        if (p.apiGetAllProfileNames().length <= 1) { toast('The last profile cannot be deleted', 'err'); return; }
        if (!(await confirmDialog('Delete profile', `Delete “${S.profile}”? This cannot be undone.`, 'Delete'))) return;
        p.apiProfileDelete(S.profile);
        selectProfile(p.apiGetAllProfileNames()[0]);
        scheduleSave();
        break;
      }
      case 'p-export': download(S.profile, p.getProfileByName(S.profile)); return;
      case 'p-import': S.importTarget = 'perf'; $('#file-import').click(); return;
      case 'p-share': sharePreset(); return;
    }
    if (S.tab === 'perf') { renderPanel(false); paintKeys(); }
  }

  // ---- Lighting
  function isCustomMode(idx) {
    if (!C()) return false;
    const n = C().apiGetAllColours().length;
    return idx === n - 1 || idx === n - 2;
  }
  const customTurboFlag = (idx) => (idx === C().apiGetAllColours().length - 2 ? 1 : 0);
  const paintKey = (idx) => C().storage_prefix + (customTurboFlag(idx) ? 'turbo_custom_color' : 'custom_color');

  function readPaint(mode) {
    const map = new Map();
    let data = null;
    try { data = JSON.parse(ls.get(paintKey(mode)) || 'null'); } catch { data = null; }
    const list = data && data.default_select_color_list;
    if (!Array.isArray(list)) return map;
    for (let j = 0; j + 3 < list.length; j += 4) {
      const idx = Number(list[j]) - 128;
      const [r, g, b] = [list[j + 1], list[j + 2], list[j + 3]];
      if (r === 0 && g === 0 && b === 0) continue;
      const hex = [r, g, b].map((v) => String(v).padStart(2, '0')).join('');
      if (/^[0-9a-f]{6}$/i.test(hex)) map.set(idx, hex.toLowerCase());
    }
    return map;
  }
  function loadPaint() { S.light.paint = readPaint(S.light.mode); }
  // The plain (non-turbo) "Custom light" mode is the last one in the list.
  const customModeIndex = () => C().apiGetAllColours().length - 1;
  // Paint to share: the one on screen if a custom mode is open, else the stored "Custom light" paint.
  function sharePaint() {
    if (!C()) return new Map();
    return isCustomMode(S.light.mode) ? new Map(S.light.paint) : readPaint(customModeIndex());
  }
  // Switch the keyboard to "Custom light" and send a preset's colours.
  function applyPresetColors(p) {
    if (!C() || !p.colors) return false;
    if (S.customDisabled && S.type !== 650) { toast('Key colours need a newer firmware - update it in Settings → Firmware.', 'err'); return false; }
    const map = p._colors || PR.decodeColors(p.colors);
    const keys = new Set(uniqueIndices());
    const idx = customModeIndex();
    S.light.mode = idx;
    ls.set('nui.light.' + C().storage_prefix, String(idx));
    if (S.turbo) setSwitches(false, S.rt);
    S.light.paint = new Map([...map].filter(([i]) => keys.has(i)));
    sendPaint();
    return true;
  }

  function lightPanel() {
    const modes = C().apiGetAllColours();
    const names = C().apiGetColourNames(LANG);
    const m = C().getModeByIndex(S.light.mode) || modes[0];
    const custom = isCustomMode(S.light.mode);
    const rgbs = C().getRGBvalues();
    const lockCustom = S.customDisabled && S.type !== 650;
    const modeChips = names.map((n, i) => {
      const dis = lockCustom && isCustomMode(i);
      return `<button class="chip" type="button" data-mode="${i}" aria-pressed="${i === S.light.mode}" ${dis ? 'disabled title="Requires newer firmware"' : ''}>${esc(n)}</button>`;
    }).join('');

    let colour;
    if (custom) {
      colour = `<p class="section-label">Paint selected keys</p>
          <div class="swatches">
            ${rgbs.map((c) => `<button class="sw" type="button" data-paint="${c}" style="background:#${c}" aria-label="#${c}"></button>`).join('')}
            <label class="sw picker" title="Custom colour"><input id="paint-pick" type="color" value="#${S.light.color}"></label>
          </div>
          <div class="toolbar"><button class="btn" type="button" data-act="erase">Erase selected</button><button class="btn danger" type="button" data-act="erase-all">Clear all</button></div>`;
    } else if (m.use_preset) {
      colour = `<p class="section-label">Colour</p>
          <div class="swatches">
            ${rgbs.map((c, i) => `<button class="sw" type="button" data-preset="${i}" style="background:#${c}" aria-label="#${c}" aria-pressed="${!m.colourful && m.index === i}"></button>`).join('')}
          </div>
          ${m.colour_mode ? `<label class="switch"><input id="rainbow" type="checkbox" ${m.colourful ? 'checked' : ''}> Rainbow</label>` : ''}`;
    } else {
      colour = '<p class="section-label">Colour</p><p class="hint">This effect uses its own colours.</p>';
    }

    const lightCard = (key, title, sub, value, disabled) => `<div class="sl">
        <div class="sl-head"><div><h2 class="title">${title}</h2><p class="subtitle">${sub}</p></div>
          <div class="sl-val ap" id="v-${key}">${value}<small>/ 9</small></div></div>
        ${sliderHTML('s-' + key, { min: 0, max: 9, step: 1, value, disabled })}
      </div>`;

    return `
      <div class="fx" role="group" aria-label="Effect">${modeChips}</div>
      <div class="light-row">
        ${lightCard('bright', 'Brightness', esc(names[S.light.mode] || ''), m.bright, false)}
        ${lightCard('speed', 'Speed', custom ? 'not used here' : 'animation speed', m.speed, custom)}
        <div class="sl" style="justify-content:flex-start;gap:8px">${colour}</div>
      </div>`;
  }

  function applyLightMode(opts = {}) {
    const idx = S.light.mode;
    const m = C().getModeByIndex(idx);
    if (!m) return;
    ls.set('nui.light.' + C().storage_prefix, String(idx));
    if (isCustomMode(idx)) { sendPaint(); return; }
    const colourful = m.colour_mode ? (opts.colourful ?? m.colourful) : 0;
    const index = opts.index ?? m.index;
    const ok = C().apiSaveColourSolution(idx, index, Number(colourful), opts.bright ?? m.bright, opts.speed ?? m.speed);
    if (!ok) { toast('Could not change the lighting', 'err'); return; }
    // mini.js checks a non-existent `preset` field, so the chosen preset colour is never stored — keep it ourselves.
    if (m.use_preset && m.index !== index) { m.index = index; C().updateModeStorage(idx); }
  }

  function sendPaint() {
    const c = S.comm;
    const idx = S.light.mode;
    const turbo = customTurboFlag(idx);
    const m = C().getModeByIndex(idx);
    const bright = m ? m.bright : 9;
    const modeIndex = C().apiGetAllColours().length - 2;
    const list = [uniqueIndices().map((i) => ({ value: i, color: S.light.paint.has(i) ? '#' + S.light.paint.get(i) : '' }))];
    c.buildPkt_custom_led_mode_select(list, turbo, modeIndex, bright, C().storage_prefix);
    let saved = null;
    try { saved = JSON.parse(ls.get(paintKey(idx)) || 'null'); } catch { saved = null; }
    if (saved && saved.default_select_color_list) {
      c.transmit_color_report_packet(C().storage_prefix, saved.default_select_color_list, saved.turbo, saved.modeIndex, bright);
    }
  }

  function chooseLightMode(i) {
    const wasCustom = isCustomMode(S.light.mode);
    if (i === turboLightIndex()) rememberLight(S.light.mode); // what to return to when Turbo goes off
    S.light.mode = i;
    if (isCustomMode(i)) {
      const wantTurbo = customTurboFlag(i) === 1;
      if (S.turbo !== wantTurbo) setSwitches(wantTurbo, S.rt);
      loadPaint();
    } else {
      if (S.turbo) setSwitches(false, S.rt);
      if (wasCustom) S.sel.clear();
    }
    applyLightMode();
    renderTools();
    renderPanel(false);
    paintKeys();
  }

  function paintSelected(hex) {
    if (!S.sel.size) { toast('Select keys on the keyboard first', 'err'); return; }
    for (const i of S.sel) { if (hex) S.light.paint.set(i, hex.toLowerCase()); else S.light.paint.delete(i); }
    sendPaint();
    paintKeys();
  }

  // ---- Remap
  function remapPanel() {
    const r = R();
    const g = S.remap.group;
    const list = r['command_array_group' + g] || [];
    return `
      <div class="bar">
        ${profileBar('r')}
        <span id="r-info" class="sel-info"></span>
        <span class="grow"></span>
        <button id="r-reset-key" class="btn" type="button" data-act="r-reset-key">Reset key</button>
        <button class="btn danger" type="button" data-act="r-reset-all">Reset all</button>
        <button id="r-save" class="btn primary ${S.remap.dirty ? 'dirty' : ''}" type="button" data-act="r-save">Save to keyboard</button>
      </div>
      <div class="chips" role="group" aria-label="Action group">${GROUP_NAMES.map((n, i) => `<button class="chip" type="button" data-group="${i}" aria-pressed="${i === g}">${n}</button>`).join('')}</div>
      <div class="targets">${list.map((d, i) => `<button class="chip" type="button" data-target="${i}" title="${esc(keyTargetText(g, i, d.keyText))}">${esc(keyTargetText(g, i, d.keyText))}</button>`).join('')}</div>`;
  }

  function updateRemapInfo() {
    const info = $('#r-info');
    if (!info) return;
    const sel = [...S.sel][0];
    const keys = R().remapGetLayerKeys(S.remap.name, S.remap.layer) || [];
    const cur = sel !== undefined ? keys[sel] : null;
    const label = sel !== undefined ? ($(`.key[data-i="${sel}"]`)?.getAttribute('aria-label') || '') : '';
    if (cur) {
      const to = cur.keyMapped ? keyTargetText(cur.groupId, cur.groupIndex, cur.keyText) : (cur.keyText || 'default');
      info.innerHTML = `<b>${esc(label.length === 1 ? label.toUpperCase() : label)}</b> → ${esc(to)}`;
    } else info.textContent = 'Select a key on the keyboard';
    $('#r-reset-key').disabled = !cur;
    $('#r-save').classList.toggle('dirty', S.remap.dirty);
  }

  function markRemapDirty() { S.remap.dirty = true; updateRemapInfo(); }

  async function remapAction(act) {
    const r = R();
    switch (act) {
      case 'r-reset-key':
        for (const i of S.sel) { r.remapDeleteMap(S.remap.name, S.remap.layer, i); flashKey(i); }
        markRemapDirty(); paintKeys(); return;
      case 'r-reset-all':
        if (!(await confirmDialog('Reset remap', 'Reset every key on all layers of this remap profile?', 'Reset'))) return;
        r.remapResetAllKeys(S.remap.name); markRemapDirty(); paintKeys(); return;
      case 'r-save': {
        const ok = r.remapSaveToKeyboard(S.remap.name);
        if (ok) applyRtp(); // base-layer remap upload wipes the Dual-Trigger / Last Win key marks
        S.remap.dirty = !ok;
        updateRemapInfo();
        toast(ok ? (S.demo ? 'Remap saved (demo)' : 'Remap sent to keyboard') : 'Could not save remap', ok ? 'ok' : 'err');
        return;
      }
      case 'r-new': { const it = r.remapProfileNew(LANG); S.remap.name = it.showName; S.remap.dirty = true; break; }
      case 'r-dup': { const it = r.remapProfileDuplicate(S.remap.name, LANG); S.remap.name = it.showName; break; }
      case 'r-rename': {
        const n = await ask('Rename remap profile', S.remap.name);
        if (!n || n === S.remap.name) return;
        if (r.remapProfileChangeName(S.remap.name, n)) S.remap.name = n; else { toast('A profile with this name already exists', 'err'); return; }
        break;
      }
      case 'r-del':
        if (r.remapGetProfileNames().length <= 1) { toast('The last profile cannot be deleted', 'err'); return; }
        if (!(await confirmDialog('Delete remap profile', `Delete “${S.remap.name}”?`, 'Delete'))) return;
        r.remapProfileDelete(S.remap.name); S.remap.name = r.remapGetProfileNames()[0]; S.remap.dirty = true; break;
      case 'r-export': download(S.remap.name, r.remapGetProfileByName(S.remap.name)); return;
      case 'r-import': S.importTarget = 'remap'; $('#file-import').click(); return;
    }
    renderPanel(false);
    paintKeys();
  }

  async function assignTarget(t) {
    if (!S.sel.size) { toast('Select a key on the keyboard first', 'err'); return; }
    // Moving Fn / Fn2 off its key removes every Fn combination (lighting keys, layer switch, reset combos).
    const fnKey = [...S.sel].some((i) => { const d = R().getPredefinedKeyDesc(S.remap.layer, i); return d && (d.keyCmd === 255 || d.keyCmd === 254); });
    const target = R().getFuncKeyDescription(S.remap.group, t);
    if (fnKey && !(target && (target.keyCmd === 255 || target.keyCmd === 254))
      && !(await confirmDialog('Remap the Fn key?', 'Without an Fn key the keyboard loses all Fn combinations, including the lighting keys and the hardware reset. You can always undo it here with “Reset key”.', 'Remap anyway'))) return;
    for (const i of S.sel) { R().remapCreateMap(S.remap.name, S.remap.layer, i, S.remap.group, t); flashKey(i); }
    markRemapDirty();
    paintKeys();
  }

  // ---- Presets (built-in + community + shared links)
  const modelName = (t) => (MODELS[t] ? MODELS[t].name : 'Unknown');

  function presetList(unfiltered) {
    const P2 = S.presets;
    const mine = PR.mine.all();
    const all = [...(P2.incoming ? [P2.incoming] : []), ...P2.builtins, ...P2.community.filter((c) => !P2.incoming || c.id !== P2.incoming.id)];
    if (unfiltered) return all;
    const q = P2.q.toLowerCase();
    return all.filter((p) => {
      if (P2.filter === 'builtin' && !p.builtin) return false;
      if (P2.filter === 'community' && (p.builtin || p.linked)) return false;
      if (P2.filter === 'mine' && !mine[p.id]) return false;
      if (P2.filter === 'fits' && p.family !== S.model.family) return false;
      return !q || (p.name + ' ' + p.author + ' ' + (p.note || '') + ' ' + modelName(p.model)).toLowerCase().includes(q);
    });
  }

  async function loadCommunity(force) {
    const P2 = S.presets;
    if (P2.status === 'loading' || (!force && P2.status === 'ok' && Date.now() - P2.loadedAt < 60000)) return;
    P2.status = 'loading';
    renderPresetList();
    try {
      P2.community = await PR.api.list();
      P2.status = 'ok';
      P2.loadedAt = Date.now();
    } catch (e) {
      P2.status = 'error';
      P2.error = e.message;
    }
    if (S.tab === 'presets') renderPresetList();
  }

  function presetsPanel() {
    const f = S.presets.filter;
    const chip = (k, n) => `<button class="chip" type="button" data-filter="${k}" aria-pressed="${f === k}">${n}</button>`;
    return `
      <div class="presets">
        <div class="pl">
          <div class="bar">
            <label class="search"><span class="ico ico-search" aria-hidden="true"></span><input id="pl-q" class="input" type="search" placeholder="Search presets" value="${esc(S.presets.q)}" aria-label="Search presets"></label>
            <div class="chips">${chip('all', 'All')}${chip('fits', 'For ' + esc(S.model.family))}${chip('builtin', 'Built-in')}${chip('community', 'Community')}${chip('mine', 'Mine')}</div>
          </div>
          <div id="pl-list" class="pl-list" role="listbox" aria-label="Presets"></div>
        </div>
        <div id="pd" class="pd"></div>
      </div>`;
  }

  function presetStats(p) {
    if (!p._stats) {
      try { p._keys = p._keys || PR.decodeKeys(p.keys); p._stats = PR.stats(p._keys, uniqueIndices()); } catch { p._stats = { ap: 0, apMin: 0, apMax: 0, ds: 0, us: 0 }; }
    }
    return p._stats;
  }

  function renderPresetList() {
    const box = $('#pl-list');
    if (!box) return;
    const list = presetList();
    const st = S.presets.status;
    const mine = PR.mine.all();
    let html = list.map((p, n) => {
      const s = presetStats(p);
      const tag = p.linked ? 'shared link' : p.builtin ? 'built-in' : (mine[p.id] ? 'yours' : `${p.uses || 0} uses`);
      return `<button class="pl-item" type="button" role="option" data-preset-id="${esc(p.id)}" aria-selected="${p.id === S.presets.selected}" style="--i:${Math.min(n, 12)}">
          <span class="n">${esc(p.name)}</span>
          <span class="s">${fmt(s.ap)} mm<small>${p.rt ? 'RT ' + fmt(s.ds) : 'RT off'}</small></span>
          <span class="m">${p.colors ? '<i class="pl-dot" title="Includes key colours"></i>' : ''}${esc(p.author)} · ${esc(modelName(p.model))} · ${tag}</span>
        </button>`;
    }).join('');
    if (!list.length) html = `<div class="pl-empty">${S.presets.filter === 'mine' ? 'You have not published presets yet.' : 'Nothing found.'}</div>`;
    if (st === 'loading') html += '<div class="pl-empty">Loading community presets…</div>';
    if (st === 'error' && S.presets.filter !== 'builtin') html += `<div class="pl-empty">Community library unavailable: ${esc(S.presets.error)}.<br>Sharing by link still works.</div>`;
    box.innerHTML = html;
  }

  function renderPresetDetail(animate) {
    const box = $('#pd');
    if (!box) return;
    const p = previewPreset();
    if (!p) { box.innerHTML = '<p class="pd-note">Pick a preset on the left — the keyboard above shows a live preview of its values.</p>'; return; }
    const st = presetStats(p);
    const fits = p.family === S.model.family;
    const mine = PR.mine.all()[p.id];
    const date = p.created ? new Date(p.created).toLocaleDateString() : '';
    box.innerHTML = `
      <div class="pd-title"><h3>${esc(p.name)}</h3>
        <span class="badge ${fits ? 'ok' : 'warn'}">${fits ? 'Fits your ' + esc(S.model.name) : 'Made for ' + esc(modelName(p.model))}</span>
        ${mine ? '<span class="badge mine">Yours</span>' : ''}<span class="badge">${p.rt ? 'RT on' : 'RT off'}</span>${p._colors.size ? `<span class="badge colors">Key colours · ${p._colors.size}</span>` : ''}</div>
      <div class="pd-meta">by ${esc(p.author)}${date ? ' · ' + esc(date) : ''}${!p.builtin && !p.linked ? ' · ' + (p.uses || 0) + ' uses' : ''}</div>
      ${p.note ? `<p class="pd-note">${esc(p.note)}</p>` : ''}
      ${fits ? '' : '<p class="pd-note">Different layout: values are applied by key position, so some keys may not match.</p>'}
      <div class="stats">
        <div class="stat ap"><b>${fmt(st.ap)}</b><span>avg actuation</span></div>
        <div class="stat ap"><b>${fmt(st.apMin)}–${fmt(st.apMax)}</b><span>range</span></div>
        <div class="stat rt"><b>${fmt(st.ds)} / ${fmt(st.us)}</b><span>RT press / release</span></div>
      </div>
      <div class="toolbar">
        <button class="btn primary" type="button" data-act="pr-apply">Apply to “${esc(S.profile)}”</button>
        <button class="btn" type="button" data-act="pr-new">Save as new profile</button>
        ${p._colors.size && C() ? '<button class="btn" type="button" data-act="pr-colors" title="Only the key lighting, key settings stay as they are">Apply colours only</button>' : ''}
        <button class="btn icon" type="button" data-act="pr-link" title="Copy share link" aria-label="Copy share link"><span class="ico ico-share" aria-hidden="true"></span></button>
        ${mine ? '<button class="btn danger" type="button" data-act="pr-del">Unpublish</button>' : ''}
      </div>`;
    box.classList.remove('swap');
    if (animate) { void box.offsetWidth; box.classList.add('swap'); }
  }

  function writePresetInto(profileName, p) {
    const target = P().getProfileByName(profileName);
    const keys = p._keys || PR.decodeKeys(p.keys);
    const n = Math.min(target.keys_array.length, keys.length);
    for (let i = 0; i < n; i++) {
      const k = target.keys_array[i];
      if (!k || !keys[i]) continue;
      k.action_point = keys[i].ap;
      k.downstroke = keys[i].ds;
      k.upstroke = keys[i].us;
      sanitizeKey(k, true); // presets come from other people: never trust the numbers
    }
    const ok = P().apiSaveProfileSolution(profileName);
    if (Boolean(p.rt) !== S.rt) setSwitches(S.turbo, Boolean(p.rt));
    if (!p.builtin && !p.linked) PR.api.use(p.id);
    return ok;
  }

  async function presetAction(act) {
    const p = previewPreset();
    if (!p) return;
    const lightsField = () => (p._colors.size && C()
      ? [{ id: 'lights', label: `Also apply key colours (${p._colors.size} keys, switches lighting to Custom light)`, type: 'checkbox', value: true }]
      : []);
    if (act === 'pr-apply') {
      const r = await formDialog({ title: 'Apply preset', ok: 'Apply', html: `<p>${esc(`Overwrite the key settings of “${S.profile}” with “${p.name}”?`)}</p>`, fields: lightsField() });
      if (!r) return;
      const ok = writePresetInto(S.profile, p);
      const lit = r.lights && applyPresetColors(p);
      toast(ok ? `“${p.name}” applied to ${S.profile}${lit ? ' with key colours' : ''}` : 'Could not send the profile to the keyboard', ok ? 'ok' : 'err');
    } else if (act === 'pr-new') {
      let lights = false;
      if (lightsField().length) {
        const r = await formDialog({ title: 'Save as new profile', ok: 'Save', html: `<p>${esc(`Create a new profile from “${p.name}”.`)}</p>`, fields: lightsField() });
        if (!r) return;
        lights = r.lights;
      }
      const it = P().apiProfileCreateNew(LANG);
      let name = p.name.slice(0, 32);
      for (let n = 2; P().getProfileByName(name) && name !== it.showname; n++) name = p.name.slice(0, 30) + ' ' + n;
      if (name !== it.showname) P().apiProfileChangeName(it.showname, name);
      selectProfile(P().getProfileByName(name) ? name : it.showname);
      const ok = writePresetInto(S.profile, p);
      const lit = lights && applyPresetColors(p);
      toast(ok ? `Saved as profile “${S.profile}”${lit ? ' with key colours' : ''}` : 'Could not send the profile to the keyboard', ok ? 'ok' : 'err');
      renderPresetDetail(false);
    } else if (act === 'pr-colors') {
      if (!(await confirmDialog('Apply key colours', `Switch lighting to Custom light and paint ${p._colors.size} key${p._colors.size === 1 ? '' : 's'} from “${p.name}”? Your key settings stay unchanged.`, 'Apply colours'))) return;
      if (applyPresetColors(p)) {
        if (!p.builtin && !p.linked) PR.api.use(p.id);
        toast(`Key colours from “${p.name}” applied`, 'ok');
      }
    } else if (act === 'pr-link') {
      showLink(PR.linkFor(p), p.name);
    } else if (act === 'pr-del') {
      if (!(await confirmDialog('Unpublish preset', `Remove “${p.name}” from the community library?`, 'Unpublish'))) return;
      try {
        await PR.api.remove(p.id, PR.mine.all()[p.id]);
        PR.mine.drop(p.id);
        S.presets.community = S.presets.community.filter((x) => x.id !== p.id);
        S.presets.selected = presetList()[0]?.id || null;
        toast('Preset removed', 'ok');
        renderPresetList(); renderPresetDetail(true); renderTools(); paintKeys();
      } catch (e) { toast(e.message, 'err'); }
    }
  }

  function showLink(link, name) {
    formDialog({
      title: 'Share “' + name + '”',
      ok: null,
      cancel: 'Close',
      html: `<p>Anyone with this link can preview the preset and apply it to their keyboard.</p>
        <div class="copybox"><input id="share-link" class="input" type="text" readonly value="${esc(link)}"><button class="btn primary" type="button" data-copy>Copy</button></div>`,
    });
    copyText(link);
  }

  async function sharePreset() {
    const pf = prof();
    const canPublish = S.presets.status !== 'error';
    const paint = sharePaint();
    const r = await formDialog({
      title: 'Share preset',
      ok: 'Share',
      fields: [
        { id: 'name', label: 'Preset name', value: pf.showname, max: 40, required: true },
        { id: 'author', label: 'Your nickname', value: S.prefs.author, max: 24, placeholder: 'Anonymous' },
        { id: 'note', label: 'Description (optional)', type: 'textarea', max: 160, placeholder: 'What is it good for?' },
        ...(paint.size ? [{ id: 'lights', label: `Include key colours from Custom light (${paint.size} painted key${paint.size === 1 ? '' : 's'})`, type: 'checkbox', value: true }] : []),
        { id: 'publish', label: canPublish ? 'Publish to the community library' : 'Community library unavailable — link only', type: 'checkbox', value: canPublish, disabled: !canPublish },
      ],
    });
    if (!r) return;
    S.prefs.author = r.author;
    savePrefs();
    const body = { name: r.name, author: r.author || 'Anonymous', note: r.note, model: S.type, family: S.model.family, rt: S.rt ? 1 : 0, keys: PR.encodeKeys(pf.keys_array) };
    if (r.lights && paint.size) body.colors = PR.encodeColors(paint);
    let link;
    if (r.publish) {
      try {
        const { item, token } = await PR.api.publish(body);
        PR.mine.add(item.id, token);
        S.presets.community.unshift(item);
        link = PR.linkFor(item);
        toast('Published to the community library', 'ok');
        if (S.tab === 'presets') { S.presets.selected = item.id; renderPresetList(); renderPresetDetail(true); renderTools(); paintKeys(); }
      } catch (e) {
        toast(e.message + ' — sharing by link instead', 'err');
      }
    }
    if (!link) link = PR.linkFor({ ...body, local: true });
    showLink(link, body.name);
  }

  async function readIncomingPreset() {
    const inc = PR.readIncoming();
    if (!inc) return;
    history.replaceState(null, '', location.pathname + (location.hash.startsWith('#demo') ? location.hash : ''));
    const banner = $('#incoming');
    const show = (html) => { banner.hidden = false; banner.innerHTML = '<span class="ico ico-presets" aria-hidden="true"></span><span>' + html + '</span>'; };
    if (inc.error) { show('This share link is damaged.'); return; }
    let p = inc.preset;
    if (inc.id) {
      show('Loading shared preset…');
      try { p = await PR.api.get(inc.id); } catch (e) { show('Could not load the shared preset: ' + esc(e.message)); return; }
    }
    if (!p || typeof p.keys !== 'string' || !p.id) { show('This shared preset is not available.'); return; }
    S.presets.incoming = p;
    show(`Shared preset <b>${esc(p.name)}</b> by ${esc(p.author)} (${esc(modelName(p.model))}). Connect your keyboard or open Demo mode to preview and apply it.`);
    if (S.connected) { S.presets.selected = p.id; S.tab === 'presets' ? renderAll() : setTab('presets'); }
  }

  // ---------------------------------------------------------------- firmware archive (GitHub: deerios)
  // Official DrunkDeer updater builds collected in a community repo. The list is read from the
  // GitHub API (cached for 6 h); FW_KNOWN keeps the section useful if GitHub can't be reached.
  const FW_REPO = 'deerios/DrunkDeerFirmware', FW_AUTHOR = 'deerios', FW_BRANCH = 'main';
  const FW_KNOWN = ['DrunkdeerUpdaterV2.3.4.zip', 'DrunkdeerUpdaterV2.3.1.zip', 'DrunkdeerUpdaterV2.3.0.zip', 'DrunkdeerUpdaterV2.2.4.zip',
    'DrunkdeerUpdaterV2.2.3.zip', 'DrunkdeerUpdaterV2.2.1.zip', 'DrunkdeerUpdaterV2.2.0.zip', 'DrunkdeerUpdaterV2.1.5.zip',
    'DrunkdeerUpdaterV1.4.9_0513.zip', 'DrunkdeerUpdaterV1.4.9.zip', 'drunkdeerUpgradev1.2_20240802.zip',
    'drunkdeer_A75_Pro_us_v0004_20240511.zip', 'drunkdeer_A75_us_v0017_20240511.zip'].map((name) => ({ name, size: 0 }));
  const fwState = { files: null, status: 'idle' };
  const fwUrl = (name) => `https://github.com/${FW_REPO}/raw/${FW_BRANCH}/${encodeURIComponent(name)}`;
  const fwDate = (d) => (d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '');
  const verKey = (v) => v.split('.').map((n) => n.padStart(4, '0')).join('.');

  // "DrunkdeerUpdaterV2.3.4.zip" → updater; "drunkdeer_A75_Pro_us_v0004_20240511.zip" → model firmware.
  function parseFw(f) {
    let m = f.name.match(/^DrunkdeerUpdaterV(\d+(?:\.\d+)*)(?:_(\d{4}))?\.zip$/i);
    if (m) return { ...f, kind: 'updater', title: `Updater v${m[1]}`, note: m[2] ? `build ${m[2].slice(0, 2)}-${m[2].slice(2)}` : '', sort: verKey(m[1]) + (m[2] || '') };
    m = f.name.match(/^drunkdeerUpgradev(\d+(?:\.\d+)*)_(\d{8})\.zip$/i);
    if (m) return { ...f, kind: 'updater', title: `Updater v${m[1]}`, note: fwDate(m[2]), sort: verKey(m[1]) + m[2] };
    m = f.name.match(/^drunkdeer_(.+?)_([a-z]{2})_v(\d+)_(\d{8})\.zip$/i);
    if (m) {
      const model = m[1].replace(/_/g, ' ');
      return { ...f, kind: 'model', model, title: `${model} firmware v${(+m[3] / 100).toFixed(2)}`, note: `${m[2].toUpperCase()} · ${fwDate(m[4])}`, sort: m[4] };
    }
    return { ...f, kind: 'other', title: f.name.replace(/\.zip$/i, ''), note: '', sort: '' };
  }

  async function loadFirmware(force) {
    const KEY = 'nui.fw.cache';
    if (!force) {
      try { const c = JSON.parse(ls.get(KEY) || 'null'); if (c && Date.now() - c.t < 6 * 3600e3 && c.files.length) { fwState.files = c.files; fwState.status = 'ok'; return; } } catch { }
    }
    fwState.status = 'loading';
    try {
      const r = await fetch(`https://api.github.com/repos/${FW_REPO}/contents/?ref=${FW_BRANCH}`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error('GitHub ' + r.status);
      const files = (await r.json()).filter((x) => x.type === 'file' && /\.zip$/i.test(x.name)).map((x) => ({ name: x.name, size: x.size }));
      if (!files.length) throw new Error('empty');
      fwState.files = files; fwState.status = 'ok';
      ls.set(KEY, JSON.stringify({ t: Date.now(), files }));
    } catch {
      fwState.files = fwState.files || FW_KNOWN; fwState.status = 'offline';
    }
  }

  function fwListHTML() {
    if (!fwState.files) return '<p class="fw-empty">Loading versions from GitHub…</p>';
    const all = fwState.files.map(parseFw);
    const mine = (f) => f.kind === 'model' && f.model.toLowerCase() === S.model.name.toLowerCase();
    const byNewest = (a, b) => (a.sort < b.sort ? 1 : a.sort > b.sort ? -1 : 0);
    const groups = [
      ['Updater (all models)', all.filter((f) => f.kind === 'updater').sort(byNewest)],
      ['Model-specific firmware', all.filter((f) => f.kind === 'model').sort((a, b) => (mine(b) - mine(a)) || byNewest(a, b))],
      ['Other files', all.filter((f) => f.kind === 'other')],
    ].filter(([, list]) => list.length);
    const item = (f, i) => {
      const other = f.kind === 'model' && !mine(f);
      const badge = i === 0 && f.kind === 'updater' ? '<span class="badge ok">Latest</span>'
        : mine(f) ? `<span class="badge ok">Your ${esc(S.model.name)}</span>` : other ? `<span class="badge warn">${esc(f.model)} only</span>` : '';
      const meta = [f.note, f.size ? (f.size / 1048576).toFixed(1) + ' MB' : ''].filter(Boolean).join(' · ');
      return `<li class="fw-item${other ? ' other' : ''}">
          <span class="fw-name"><b>${esc(f.title)}</b>${badge}<small>${esc(meta || f.name)}</small></span>
          <a class="btn" href="${fwUrl(f.name)}" target="_blank" rel="noopener" title="${esc(f.name)}" ${other ? `data-fw-other="${esc(f.model)}"` : ''}><span class="ico ico-download" aria-hidden="true"></span>Download</a>
        </li>`;
    };
    return groups.map(([t, list]) => `<p class="section-label">${t}</p><ul class="fw-list">${list.map(item).join('')}</ul>`).join('')
      + (fwState.status === 'offline' ? '<p class="fw-empty">Couldn’t reach GitHub — showing the last known list.</p>' : '');
  }

  // Newest updater in the archive (the official site still serves an old v1.2 build).
  function latestUpdater() {
    const ups = (fwState.files || FW_KNOWN).map(parseFw).filter((f) => f.kind === 'updater');
    return ups.sort((a, b) => (a.sort < b.sort ? 1 : a.sort > b.sort ? -1 : 0))[0];
  }
  const MANUAL_URL = 'https://drunkdeer.com/pages/user-manual-select';

  async function renderFirmwareArchive(force) {
    const box = () => $('#fw-archive');
    if (!box()) return;
    if (force || !fwState.files) {
      if (force) { fwState.files = null; box().innerHTML = fwListHTML(); }
      await loadFirmware(force);
    }
    if (box()) box().innerHTML = fwListHTML();
    const up = latestUpdater(), link = $('#fw-latest');
    if (up && link) { link.href = fwUrl(up.name); link.title = up.name; $('#fw-latest-ver').textContent = up.title; }
  }

  // ---------------------------------------------------------------- settings modal (ATK Hub style)
  let settingsSec = 'device';
  function openSettings(sec) {
    if (!S.connected) return;
    settingsSec = sec || settingsSec;
    renderSettings(false);
    $('#settings').showModal();
  }

  function renderSettings(animate) {
    $$('#settings .sheet-nav button').forEach((b) => {
      if (b.dataset.sec === settingsSec) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    const c = S.comm;
    const body = $('#settings-body');
    const iso = [751, 752, 753].includes(S.type);
    const cur = Number(ls.get('current_iso')) || 751;
    const fw = c.firmware_version_string ? 'v' + c.firmware_version_string : '—';
    const seg = (name, value, opts) => `<div class="chips" role="group">${opts.map(([v, n]) => `<button class="chip" type="button" data-pref="${name}" data-value="${v}" aria-pressed="${value === v}">${n}</button>`).join('')}</div>`;
    const lib = S.presets.status === 'ok' ? S.presets.community.length + ' community presets loaded' : S.presets.status === 'error' ? esc(S.presets.error) : 'Not loaded yet';
    const html = {
      device: `<h3>Device</h3>
        <div class="row"><dl class="kv">
          <dt>Model</dt><dd>DrunkDeer ${esc(S.model.name)}</dd>
          <dt>Firmware</dt><dd>${esc(fw)}</dd>
          <dt>Connection</dt><dd>${S.demo ? 'Demo (simulated)' : 'USB · WebHID'}</dd>
          <dt>Protocol</dt><dd>mini.js v${esc(c.web_version_string || '')}</dd>
        </dl></div>
        ${S.demo ? `<div class="row"><span class="lbl">Demo keyboard<small>Preview the driver with another DrunkDeer model.</small></span>
          <select id="demo-switch" class="select" aria-label="Demo keyboard">${demoOptions(S.type)}</select></div>` : ''}
        ${iso && !S.demo ? `<div class="row"><span class="lbl">ISO legends<small>The keyboard can’t report this; reconnect to apply.</small></span>
          <select id="iso" class="select"><option value="751" ${cur === 751 ? 'selected' : ''}>UK</option><option value="752" ${cur === 752 ? 'selected' : ''}>French (AZERTY)</option><option value="753" ${cur === 753 ? 'selected' : ''}>German (QWERTZ)</option></select></div>` : ''}
        <div class="row"><span class="lbl">${S.demo ? 'Leave demo' : 'Disconnect keyboard'}<small>${S.demo ? 'Back to the start screen.' : 'Your profiles stay saved in this browser.'}</small></span>
          <button class="btn danger" type="button" data-act="leave">${S.demo ? 'Exit demo' : 'Disconnect'}</button></div>`,
      firmware: `<h3>Firmware</h3>
        <div class="row"><span class="lbl">Installed version<small>Custom per-key lighting needs a recent firmware.</small></span><b>${esc(fw)}</b></div>
        <div class="row"><span class="lbl">Latest updater<small><span id="fw-latest-ver">${esc(latestUpdater().title)}</span> · DrunkDeer’s Windows flashing tool, from the archive below (the official site still serves v1.2).</small></span>
          <a id="fw-latest" class="btn primary" href="${fwUrl(latestUpdater().name)}" target="_blank" rel="noopener" title="${esc(latestUpdater().name)}"><span class="ico ico-download" aria-hidden="true"></span>Download</a></div>
        <div class="row"><span class="lbl">User manual<small>Key combinations and hardware reset.</small></span>
          <a class="btn" href="${MANUAL_URL}" target="_blank" rel="noopener">Open</a></div>
        <div class="row fw-head"><span class="lbl">Older versions
            <small>Unofficial source · archive collected by <a href="https://github.com/${FW_AUTHOR}" target="_blank" rel="noopener">${FW_AUTHOR}</a> on GitHub.
            Use the version made for your keyboard.</small></span>
          <span class="fw-actions">
            <button class="btn icon" type="button" data-act="fw-refresh" aria-label="Refresh list" title="Refresh list">↻</button>
            <a class="btn" href="https://github.com/${FW_REPO}" target="_blank" rel="noopener">Open repository</a>
          </span>
          <div id="fw-archive" class="fw-archive">${fwListHTML()}</div></div>`,
      interface: `<h3>Interface</h3>
        <div class="row"><span class="lbl">Values on keys<small>How actuation / Rapid Trigger numbers show on unselected keys.</small></span>
          ${seg('vals', S.prefs.vals, [['faint', 'Faint'], ['selected', 'Selected only'], ['always', 'Always']])}</div>
        <div class="row"><span class="lbl">Animations<small>Transitions, keyboard intro and effects.</small></span>
          <label class="switch"><input id="pref-anim" type="checkbox" ${S.prefs.anim ? 'checked' : ''} aria-label="Animations"></label></div>
        <div class="row"><span class="lbl">Nickname for shared presets<small>Shown next to presets you publish.</small></span>
          <input id="pref-author" class="input" type="text" maxlength="24" placeholder="Anonymous" value="${esc(S.prefs.author)}" aria-label="Nickname"></div>`,
      about: `<h3>About</h3>
        <p>Unofficial driver for first-gen DrunkDeer keyboards (A75, A75 Pro, G65, G60, G75). Profiles, colours and remaps are stored in this browser and sent to the keyboard over WebHID.</p>
        <div class="row"><span class="lbl">Preset library<small>${lib}</small></span>
          <button class="btn" type="button" data-act="lib-refresh">Refresh</button></div>
        <p>Not affiliated with DrunkDeer. Use at your own risk.</p>`,
    }[settingsSec];
    body.innerHTML = html;
    if (settingsSec === 'firmware') renderFirmwareArchive(false);
    body.classList.remove('swap');
    if (animate) { void body.offsetWidth; body.classList.add('swap'); }
  }

  // ---------------------------------------------------------------- key tracking
  function demoKey(e) {
    const i = DEMO_CODES[e.code];
    if (i === undefined || e.target.closest?.('input, select, textarea')) return;
    setTravel(i, e.type === 'keydown' ? 100 : 0);
  }

  function toggleTracking(on) {
    if (!S.connected) return;
    if (on && S.turbo) { toast('Turn off Turbo mode to watch key travel', 'err'); on = false; }
    const r = S.comm.event_control_key_tracking(0, on ? 1 : 0);
    if (r && r.status) S.tracking = on;
    if (S.demo) {
      window.removeEventListener('keydown', demoKey);
      window.removeEventListener('keyup', demoKey);
      if (S.tracking) { window.addEventListener('keydown', demoKey); window.addEventListener('keyup', demoKey); }
    }
    if (!S.tracking) for (const i of S.keyEls.keys()) setTravel(i, 0);
    if (r && r.message) toast(r.message, r.status ? 'ok' : 'err');
    const box = $('#tracking');
    if (box) box.checked = S.tracking;
  }

  // ---------------------------------------------------------------- events
  // Menus are moved to <body> while open so the scrolling panel can't clip them.
  function closeMenus(except) {
    $$('.menu').forEach((m) => {
      if (m === except) return;
      m.hidden = true;
      const owner = m._owner;
      if (!owner) return;
      owner.setAttribute('aria-expanded', 'false');
      if (owner.isConnected) owner.after(m); else m.remove();
      m._owner = null;
    });
  }
  function openMenu(btn, m) {
    m._owner = btn;
    document.body.append(m);
    m.classList.add('floating');
    m.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    placeMenu(m);
  }
  function placeMenu(m) {
    const r = m._owner.getBoundingClientRect();
    const w = m.offsetWidth, h = m.offsetHeight, gap = 6;
    const up = r.top - gap - h >= 8 || r.bottom + gap + h > innerHeight - 8;
    const top = up ? Math.max(8, r.top - gap - h) : r.bottom + gap;
    const left = clamp(r.left, 8, innerWidth - w - 8);
    m.style.top = top + 'px';
    m.style.left = left + 'px';
    m.style.transformOrigin = (up ? 'bottom' : 'top') + ' left';
  }

  // Import a performance profile from any JSON: this driver's export, the official
  // DrunkDeer driver's export (any first-gen model), a list of profiles or a shared preset.
  function findKeysArray(o, depth = 0) {
    if (!o || typeof o !== 'object' || depth > 4) return null;
    if (Array.isArray(o.keys_array) && o.keys_array.some((k) => k && 'action_point' in k)) return o;
    for (const v of Array.isArray(o) ? o : Object.values(o)) {
      const val = typeof v === 'string' && /^\s*[[{]/.test(v) ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v;
      const hit = findKeysArray(val, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  async function importPerfFile(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch { toast('Import failed: the file is not valid JSON.', 'err'); return; }
    let keys = null, name = null, rt = null;
    const src = findKeysArray(data);
    if (src) {
      keys = src.keys_array.map((k) => ({ ap: +k?.action_point, ds: +k?.downstroke, us: +k?.upstroke }));
      name = src.showname || src.name;
    } else if (data && typeof data.keys === 'string') {
      try { keys = PR.decodeKeys(data.keys); name = data.name; rt = data.rt; } catch { keys = null; }
    }
    keys = keys && keys.filter(Boolean);
    if (!keys || !keys.length || keys.every((k) => !Number.isFinite(k.ap))) { toast('Import failed: no key settings found in this file.', 'err'); return; }

    const fix = (v, lo, hi, d) => (Number.isFinite(v) ? clamp(Math.round(v * 10) / 10, lo, hi) : d);
    const it = P().apiProfileCreateNew(LANG);
    let base = String(name || file.name.replace(/\.json$/i, '') || 'Imported').slice(0, 30), nm = base;
    for (let n = 2; P().getProfileByName(nm) && nm !== it.showname; n++) nm = base.slice(0, 28) + ' ' + n;
    if (nm !== it.showname) P().apiProfileChangeName(it.showname, nm);
    selectProfile(P().getProfileByName(nm) ? nm : it.showname);
    const dst = P().getProfileByName(S.profile);
    const n = Math.min(dst.keys_array.length, keys.length);
    for (let i = 0; i < n; i++) {
      const d = dst.keys_array[i], k = keys[i];
      d.action_point = fix(k.ap, 0.2, 3.8, d.action_point);
      d.downstroke = fix(k.ds, 0, 3.6, d.downstroke);
      d.upstroke = fix(k.us, 0, 3.6, d.upstroke);
      sanitizeKey(d, true);
    }
    const ok = P().apiSaveProfileSolution(S.profile);
    if (rt !== null && rt !== undefined && Boolean(rt) !== S.rt) setSwitches(S.turbo, Boolean(rt));
    const partial = keys.length !== dst.keys_array.length;
    toast(ok ? `Imported as “${S.profile}”${partial ? ' (layout differs — matched by key order)' : ''}` : 'Imported, but could not send it to the keyboard', ok ? 'ok' : 'err');
    if (S.tab === 'perf') renderPanel(false);
    paintKeys();
  }

  // mini.js imports remap files without any check (not even the keyboard model), and a foreign or
  // damaged file would later be uploaded as-is. Check it first, with the same rules as the upload.
  async function importRemapFile(file) {
    let o;
    try { o = JSON.parse(await file.text()); } catch { toast('Import failed: the file is not valid JSON.', 'err'); return; }
    const r = R();
    const re = new RegExp('^' + r.storage_prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\d+$');
    if (!o || typeof o.storageName !== 'string' || !re.test(o.storageName)) { toast(`Import failed: this is not a key remap file for the ${S.model.name}.`, 'err'); return; }
    const allowed = remapAllowed(r);
    for (const l of ['keyCodeDefault', 'keyCodeFn1', 'keyCodeFn2']) {
      const why = checkRemapLayer(o[l], allowed);
      if (why) { toast(`Import refused: ${why}. Sending this file could scramble the key layout.`, 'err'); return; }
    }
    r.remapProfileImport(file, LANG);
  }

  function bind() {
    $('#btn-connect').addEventListener('click', connect);
    const dm = $('#demo-model');
    dm.innerHTML = demoOptions(demoType(ls.get('nui.demoModel')));
    $('#btn-demo').addEventListener('click', () => startDemo(Number(dm.value)));
    $('#btn-rt').addEventListener('click', () => setSwitches(S.turbo, !S.rt));
    $('#btn-turbo').addEventListener('click', () => setSwitches(!S.turbo, S.rt));
    $('#btn-settings').addEventListener('click', () => openSettings());
    // Keyboard name in the top bar → Settings › Device.
    const dev = $('.device');
    dev.addEventListener('click', () => openSettings('device'));
    dev.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSettings('device'); } });
    $$('.side-btn[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

    // dropdown menus
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-menu]');
      if (t) {
        const open = $$('.menu.floating').find((m) => m._owner === t && !m.hidden);
        closeMenus();
        if (!open) { const m = t.nextElementSibling; if (m?.classList.contains('menu')) openMenu(t, m); }
        return;
      }
      const item = e.target.closest('.menu.floating [data-act]');
      closeMenus();
      if (item) {
        const act = item.dataset.act;
        if (act.startsWith('p-')) profileAction(act);
        else if (act.startsWith('r-')) remapAction(act);
      }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
    window.addEventListener('resize', () => closeMenus());
    document.addEventListener('scroll', (e) => { if (!e.target.closest?.('.menu')) closeMenus(); }, true);

    $('#board-tools').addEventListener('click', (e) => {
      const pick = e.target.closest('[data-pick]');
      if (pick) selectPreset(pick.dataset.pick);
      const layer = e.target.closest('[data-layer]');
      if (layer) {
        S.remap.layer = +layer.dataset.layer;
        $$('[data-layer]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.layer === S.remap.layer)));
        paintKeys(); updateRemapInfo();
      }
      const metric = e.target.closest('[data-metric]');
      if (metric) { S.presets.metric = metric.dataset.metric; renderTools(); paintKeys(); }
      if (e.target.closest('[data-act="p-share"]')) sharePreset();
    });

    const panel = $('#panel');
    panel.addEventListener('input', (e) => {
      const t = e.target;
      if (t.type === 'range') syncSlider(t);
      if (S.tab === 'perf' && ['s-ap', 's-ds', 's-us'].includes(t.id)) {
        const kind = { 's-ap': 0, 's-ds': 1, 's-us': 2 }[t.id];
        const pf = prof();
        const sel = [...S.sel].filter((i) => pf && pf.keys_array[i]);
        let v = Math.round(+t.value * 10) / 10;
        if (!sel.length || !Number.isFinite(v)) return;
        // RT can't use more travel than the actuation point leaves: hold the thumb at the limit.
        if (kind) { const lim = rtLimit(pf, sel); if (v > lim) { v = lim; t.value = v; syncSlider(t); } }
        P().apiProfileChangeBySlider(kind, S.profile, sel, v);
        if (kind === 0) clampRt(sel);
        updatePerf();
        paintKeys();
      }
      if (S.tab === 'light' && (t.id === 's-bright' || t.id === 's-speed')) $('#v-' + t.id.slice(2)).innerHTML = `${t.value}<small>/ 9</small>`;
      if (t.id === 'pl-q') { S.presets.q = t.value; renderPresetList(); }
    });
    panel.addEventListener('change', (e) => {
      const t = e.target;
      if (S.tab === 'perf') {
        if (['s-ap', 's-ds', 's-us'].includes(t.id)) scheduleSave();
        if (t.id === 'p-profile') { selectProfile(t.value); scheduleSave(); paintKeys(); updatePerf(); }
        if (t.id === 'tracking') toggleTracking(t.checked);
      }
      if (S.tab === 'light') {
        if (t.id === 's-bright' || t.id === 's-speed') {
          const m = C().getModeByIndex(S.light.mode);
          const bright = t.id === 's-bright' ? +t.value : m.bright;
          const speed = t.id === 's-speed' ? +t.value : m.speed;
          if (isCustomMode(S.light.mode)) { C().changeModeByIndex(S.light.mode, m.index, m.colourful, bright, speed); C().updateModeStorage(S.light.mode); sendPaint(); }
          else applyLightMode({ bright, speed });
        }
        if (t.id === 'rainbow') { applyLightMode({ colourful: t.checked ? 1 : 0 }); renderPanel(false); }
        if (t.id === 'paint-pick') { S.light.color = t.value.slice(1); paintSelected(S.light.color); }
      }
      if (S.tab === 'remap' && t.id === 'r-profile') { S.remap.name = t.value; S.remap.dirty = true; updateRemapInfo(); paintKeys(); }
    });
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const act = b.dataset.act;
      if (act?.startsWith('p-')) profileAction(act);
      else if (act?.startsWith('r-')) remapAction(act);
      else if (act?.startsWith('pr-')) presetAction(act);
      else if (act === 'rtx') openRtx();
      else if (act === 'erase') paintSelected(null);
      else if (act === 'erase-all') { S.light.paint.clear(); sendPaint(); paintKeys(); }
      if (b.dataset.mode !== undefined) chooseLightMode(+b.dataset.mode);
      if (b.dataset.preset !== undefined) {
        applyLightMode({ index: +b.dataset.preset, colourful: 0 });
        $$('[data-preset]').forEach((s) => s.setAttribute('aria-pressed', String(s === b)));
        const rb = $('#rainbow'); if (rb) rb.checked = false;
      }
      if (b.dataset.paint !== undefined) { S.light.color = b.dataset.paint; paintSelected(b.dataset.paint); }
      if (b.dataset.group !== undefined) { S.remap.group = +b.dataset.group; renderPanel(false); }
      if (b.dataset.target !== undefined) assignTarget(+b.dataset.target);
      if (b.dataset.filter !== undefined) {
        S.presets.filter = b.dataset.filter;
        $$('[data-filter]').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
        renderPresetList();
      }
      if (b.dataset.presetId !== undefined) {
        S.presets.selected = b.dataset.presetId;
        const picked = previewPreset();
        if (picked && picked._colors.size) S.presets.metric = 'c';
        else if (S.presets.metric === 'c') S.presets.metric = 'ap';
        $$('.pl-item').forEach((it) => it.setAttribute('aria-selected', String(it === b)));
        renderPresetDetail(true); renderTools(); paintKeys();
      }
    });

    // settings modal
    const sheet = $('#settings');
    sheet.addEventListener('click', (e) => {
      if (e.target === sheet) { sheet.close(); return; }
      const fwOther = e.target.closest('a[data-fw-other]');
      if (fwOther && !confirm(`This firmware is for the DrunkDeer ${fwOther.dataset.fwOther}, but your keyboard is a ${S.model.name}. Flashing the wrong firmware can break the keyboard. Download anyway?`)) { e.preventDefault(); return; }
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.close !== undefined) sheet.close();
      if (b.dataset.sec) { settingsSec = b.dataset.sec; renderSettings(true); }
      if (b.dataset.pref) {
        S.prefs[b.dataset.pref] = b.dataset.value; savePrefs();
        $$(`[data-pref="${b.dataset.pref}"]`).forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
        paintKeys();
      }
      const act = b.dataset.act;
      if (act === 'leave') leave();
      if (act === 'fw-refresh') renderFirmwareArchive(true);
      if (act === 'lib-refresh') loadCommunity(true).then(() => renderSettings(false));
    });
    sheet.addEventListener('change', (e) => {
      const t = e.target;
      if (t.id === 'demo-switch') { switchDemo(Number(t.value)); return; }
      if (t.id === 'iso') { ls.set('current_iso', t.value); toast('Layout saved. Reconnect the keyboard to apply it.', 'ok'); }
      if (t.id === 'pref-anim') { S.prefs.anim = t.checked; savePrefs(); applyAnimPref(); }
      if (t.id === 'pref-author') { S.prefs.author = t.value.trim(); savePrefs(); }
    });
    $('#modal').addEventListener('click', (e) => {
      if (e.target.closest('[data-copy]')) copyText($('#share-link').value, $('#share-link')).then((ok) => { if (!ok) toast('Copy the link manually', 'err'); });
    });

    $('#file-import').addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (S.importTarget === 'remap') importRemapFile(f);
      else importPerfFile(f);
    });

    let raf = 0;
    const relayout = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { layoutBoard(); moveIndicator(true); }); };
    new ResizeObserver(relayout).observe($('.main'));
    mobile.addEventListener('change', relayout);
    setupBoardEvents();

    if ('hid' in navigator) {
      navigator.hid.addEventListener('disconnect', (e) => {
        if (S.connected && !S.demo && e.device === S.device) onDisconnected('Keyboard disconnected. If a save was running, reconnect and save again — it may have been cut off.');
      });
    }
  }

  // ---------------------------------------------------------------- boot
  installSafety();
  bind();
  readIncomingPreset();
  window.addEventListener('hashchange', () => { if (location.hash.startsWith('#share=')) readIncomingPreset(); });
  const hashTab = location.hash.match(/^#demo(?:-(perf|light|remap|presets))?(?:-([0-9]+))?$/);
  if (hashTab) { S.tab = hashTab[1] || 'perf'; startDemo(hashTab[2] && Number(hashTab[2])); }
  else if (!('hid' in navigator)) {
    $('#hid-warn').hidden = false;
  } else {
    newRealComm();
    let again = false;
    try { again = sessionStorage.getItem('nui.reconnect') === '1'; sessionStorage.removeItem('nui.reconnect'); } catch { /* ignore */ }
    // Reopens a keyboard this site was already allowed to use (no prompt needed).
    S.comm.auto_select_keyboard();
    if (again) { setBusy(true); setTimeout(() => { if (!S.connected) setBusy(false); }, 4000); }
  }
})();
