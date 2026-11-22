// Spheres website. The app (the Brick's own C code as WebAssembly: the
// site_* exports) runs on this page and owns every setting; the engine runs
// in an audio worklet. Each frame the page sends the app's snapshot to the
// engine, hands the engine's state back, draws the sky from the shapes the
// app records, and refreshes the controls that changed. Controls take their
// names, ranges, steps and wording from the app's settings tables, so they
// are the Brick's own.

const T = { DRONES: 0, ARPS: 1, SOUND: 2, LOOP: 3 };
const SF = { LOG: 1, CLAMP: 2, SOUND: 4, RETRIG: 8, NOTE: 16, LOOP: 32, COUNTER: 64 };
const D = { ON: 0, VOICE: 1, LEVEL: 2, PRESSURE: 3, SPEED: 4, OCTAVE: 5, ORBIT: 6, MOONS: 7, MOON_BEAT: 8,
  ROOT: 9, NOTE: 10, ORBIT_TIME: 11, GRAVITY: 12, WANDER: 13, COMETS: 14 };
const A = { ON: 0, INSTRUMENT: 1, LEVEL: 2, OCTAVE: 3, SCALE: 4, NOTES: 5, RANGE: 6, PATTERN: 7, STEPS: 8,
  LENGTH: 9, METER: 10, CLICK: 11, RETRIG: 12, RETRIG_CHANCE: 13, FROM: 14, CHANCE: 15, MUTATE: 16,
  EVERY: 17, CHORDS: 18, TEMPO: 19, SWING: 20, ACCENT: 21 };
const S = { FILTER_D: 6, CUTOFF_D: 7, RES_D: 8, FILTER_N: 21, CUTOFF_N: 22, RES_N: 23 };
const LP = { LOOP: 0, BARS: 1, COUNT: 2 };
const LOOP = { OFF: 0, REC: 1, PLAY: 2 };
const ARP0 = 4, BODIES = 7, TAU = 2 * Math.PI;
const SLOTS_KEY = (i) => `spheres.slot${i + 1}`, SESSION_KEY = "spheres.session", VOLUME_KEY = "spheres.volume";
const SELFTEST = new URLSearchParams(location.search).has("selftest");

let W, wasmBytes, snapSize;
const $ = (id) => document.getElementById(id);
const fields = [], choices = [], toggles = [], segs = [];
let sel = 1, info = new Float32Array(32), frameNo = 0;

/* ------------------------------------------------------------------ */
/* memory                                                              */

const decoder = new TextDecoder(), encoder = new TextEncoder();
function cstr(ptr) {
  const m = new Uint8Array(W.memory.buffer);
  let e = ptr;
  while (m[e]) e++;
  return decoder.decode(m.subarray(ptr, e));
}
const f32 = (ptr, n) => new Float32Array(W.memory.buffer, ptr, n);
const bytesAt = (ptr, n) => new Uint8Array(W.memory.buffer, ptr, n);
function writeText(ptr, size, text) {
  const enc = encoder.encode(text || "");
  const n = Math.min(enc.length, size - 1), b = bytesAt(ptr, size);
  b.set(enc.subarray(0, n));
  b[n] = 0;
}
const colours = new Map();
function css(c) {
  let s = colours.get(c);
  if (!s) colours.set(c, s = `rgb(${c & 255},${(c >>> 8) & 255},${(c >>> 16) & 255})`);
  return s;
}
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const capture = (e, id) => { try { e.setPointerCapture(id); } catch { /* not a live pointer */ } };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/* ------------------------------------------------------------------ */
/* the app's settings                                                  */

const metas = new Map();
function meta(t, r) {
  const k = t * 100 + r;
  if (!metas.has(k)) {
    const a = f32(W.site_row_meta(t, r), 9);
    metas.set(k, { t, r, name: cstr(W.site_row_name(t, r)), base: a[0], flags: a[1], min: a[2], max: a[3],
      small: a[4], big: a[5], scale: a[6], list: a[7] > 0, perBody: a[8] > 0 });
  }
  return metas.get(k);
}

function options(t, r, b) {
  const n = W.site_options(t, r, b);
  return Array.from(f32(W.site_option_values(), n)).map((v) => ({ v, label: cstr(W.site_option_text(t, r, b, v)) }));
}

const get = (t, r, b) => W.site_get(t, r, b);
const text = (t, r, b) => cstr(W.site_text(t, r, b));

/* ------------------------------------------------------------------ */
/* undo                                                                */

const hist = { past: [], future: [], key: null, at: 0 };
const settingsCopy = () => bytesAt(W.site_settings(), snapSize).slice();

// before an edit; edits to one control close together make one step
function pushUndo(key) {
  const now = performance.now();
  if (key && key === hist.key && now - hist.at < 1500) {
    hist.at = now;
    return;
  }
  hist.key = key || null;
  hist.at = now;
  hist.past.push(settingsCopy());
  if (hist.past.length > 200) hist.past.shift();
  hist.future.length = 0;
}

function restoreFrom(from, to) {
  if (!from.length) return;
  const bytes = from.pop(), now = settingsCopy();
  bytesAt(W.site_undo_buf(), bytes.length).set(bytes);
  if (W.site_restore()) to.push(now);
  else from.push(bytes);
  hist.key = null;
  refreshAll();
}
const undo = () => restoreFrom(hist.past, hist.future);
const redo = () => restoreFrom(hist.future, hist.past);

/* ------------------------------------------------------------------ */
/* controls                                                            */

// a number to drag, step or type: in the matrices, the knobs and the clock
class Field {
  constructor(t, r, b, opt = {}) {
    Object.assign(this, { t, r, b, opt, m: meta(t, r), v: NaN, shown: null, editing: null });
    this.readonly = !!opt.readonly;
    const e = this.el = el("div", opt.knob ? "knob" : "vf" + (opt.big ? " big" : "") + (this.readonly ? " ro" : ""));
    e.setAttribute("role", "slider");
    e.tabIndex = 0;
    e.setAttribute("aria-label", opt.label || this.m.name);
    if (opt.knob) {
      this.ring = e.appendChild(el("span", "ring"));
      e.appendChild(el("span", "kl", opt.label || this.m.name));
      this.txt = e.appendChild(el("span", "kv"));
    } else {
      this.fill = e.appendChild(el("span", "fill"));
      this.txt = e.appendChild(el("span", "txt"));
    }
    if (this.readonly) e.setAttribute("aria-readonly", "true");
    else {
      e.title = opt.title || "Drag to change (Shift: finely) · double-click to type · Delete: the start value";
      this.bind();
    }
    fields.push(this);
  }

  // where v sits in the range, 0..1
  pos(v) {
    const m = this.m;
    if (m.flags & SF.LOG) return Math.log(v / m.min) / Math.log(m.max / m.min);
    return (v - m.min) / (m.max - m.min);
  }

  val(p) {
    const m = this.m;
    if (m.flags & SF.LOG) return m.min * Math.pow(m.max / m.min, p);
    return m.min + p * (m.max - m.min);
  }

  // pixels of drag for the whole range: speeds and the root an octave per 200
  span() {
    const m = this.m;
    if ((this.t === T.DRONES && (this.r === D.SPEED || this.r === D.ROOT))) return 200 * Math.log2(m.max / m.min);
    return this.opt.knob ? 240 : 320;
  }

  update(force) {
    const v = get(this.t, this.r, this.b);
    if (v === this.v && !force) return;
    this.v = v;
    const s = text(this.t, this.r, this.b);
    if (s !== this.shown) {
      this.shown = s;
      if (!this.editing) this.txt.textContent = s;
      this.el.setAttribute("aria-valuetext", s);
    }
    const p = clamp(this.pos(v), 0, 1);
    if (this.ring) this.ring.style.setProperty("--a", `${(p * 270).toFixed(1)}deg`);
    else this.fill.style.width = `${(p * 100).toFixed(1)}%`;
  }

  set(v) {
    const m = this.m;
    if (!(m.flags & SF.LOG) && m.small >= 1) v = Math.round(v);
    else if (!(m.flags & SF.LOG) && m.small > 0) v = Math.round(v / m.small) * m.small;
    W.site_set(this.t, this.r, this.b, v);
    this.update(true);
  }

  key() { return `${this.t}.${this.r}.${this.b}`; }

  bind() {
    const e = this.el;
    let drag = null;
    e.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || this.editing) return;
      wake();
      if (this.m.perBody) choose(this.b);
      e.focus({ preventScroll: true });
      capture(e, ev.pointerId);
      drag = { x: ev.clientX, y: ev.clientY, p0: clamp(this.pos(get(this.t, this.r, this.b)), 0, 1), moved: false };
      ev.preventDefault();
    });
    e.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!drag.moved) {
        if (Math.abs(dx) + Math.abs(dy) < 3) return;
        drag.moved = true;
        pushUndo(this.key());
      }
      const d = this.opt.knob ? -dy : dx - dy;
      this.set(this.val(clamp(drag.p0 + d / (this.span() * (ev.shiftKey ? 10 : 1)), 0, 1)));
    });
    const end = () => { drag = null; };
    e.addEventListener("pointerup", end);
    e.addEventListener("pointercancel", end);
    e.addEventListener("dblclick", () => this.edit());
    e.addEventListener("keydown", (ev) => {
      if (this.editing) return;
      let dir = 0, big = ev.shiftKey;
      if (ev.key === "ArrowUp" || ev.key === "ArrowRight") dir = 1;
      else if (ev.key === "ArrowDown" || ev.key === "ArrowLeft") dir = -1;
      else if (ev.key === "PageUp") { dir = 1; big = true; }
      else if (ev.key === "PageDown") { dir = -1; big = true; }
      else if (ev.key === "Enter") { ev.preventDefault(); this.edit(); return; }
      else if (ev.key === "Delete" || ev.key === "Backspace") {
        ev.preventDefault();
        pushUndo();
        W.site_set(this.t, this.r, this.b, W.site_default(this.t, this.r, this.b));
        this.update(true);
        return;
      } else if (ev.key === "Home" || ev.key === "End") {
        ev.preventDefault();
        pushUndo(this.key());
        W.site_set(this.t, this.r, this.b, ev.key === "Home" ? this.m.min : this.m.max);
        this.update(true);
        return;
      }
      if (!dir) return;
      ev.preventDefault();
      pushUndo(this.key());
      W.site_step(this.t, this.r, this.b, dir, big ? 1 : 0);
      this.update(true);
    });
  }

  // type a value: the number as shown, a note for the root, p:q for a speed
  edit() {
    if (this.editing) return;
    const input = this.editing = el("input");
    input.type = "text";
    input.value = this.shown || "";
    input.setAttribute("aria-label", `${this.m.name}: type a value`);
    (this.opt.knob ? this.txt : this.el).appendChild(input);
    input.select();
    const done = (keep) => {
      if (!this.editing) return;
      this.editing = null;
      const v = keep ? this.parse(input.value) : null;
      input.remove();
      this.txt.textContent = this.shown;
      if (v != null && Number.isFinite(v)) {
        pushUndo();
        W.site_set(this.t, this.r, this.b, v);
      }
      this.update(true);
      this.el.focus({ preventScroll: true });
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") done(true);
      else if (ev.key === "Escape") done(false);
    });
    input.addEventListener("blur", () => done(true));
    input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  }

  parse(s) {
    s = s.trim();
    if (this.t === T.DRONES && this.r === D.ROOT) {
      const hz = noteHz(s);
      if (hz) return hz;
    }
    if (this.t === T.DRONES && this.r === D.SPEED) {
      const q = s.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
      if (q) return parseFloat(q[1]) / parseFloat(q[2]);
    }
    const x = parseFloat(s.replace(",", "."));
    if (!Number.isFinite(x)) return null;
    return x / (this.m.scale || 1);
  }
}

// "Bb3", "c#2", "A4" as Hz (A4 = 440)
const NOTE_INDEX = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
function noteHz(s) {
  const m = s.match(/^([a-gA-G])([#b♯♭]?)(-?\d)$/);
  if (!m) return null;
  const k = NOTE_INDEX[m[1].toLowerCase()] + (m[2] === "#" || m[2] === "♯" ? 1 : m[2] ? -1 : 0);
  return 440 * Math.pow(2, ((parseInt(m[3], 10) + 1) * 12 + k - 69) / 12);
}
const hzOf = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const noteName = (midi) => NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);

// a list: a menu, its choices the app's (scales grouped by family)
class Choice {
  constructor(t, r, b, opt = {}) {
    Object.assign(this, { t, r, b, opt, m: meta(t, r), v: NaN, sig: "" });
    const e = this.el = el("select", "pick");
    e.setAttribute("aria-label", opt.label || this.m.name);
    this.build();
    e.addEventListener("pointerdown", () => { wake(); if (this.m.perBody) choose(this.b); });
    e.addEventListener("change", () => {
      pushUndo();
      if (!W.site_set(this.t, this.r, this.b, parseFloat(e.value))) this.v = NaN;
      this.update(true);
    });
    choices.push(this);
  }

  build() {
    const opts = options(this.t, this.r, this.b);
    const sig = opts.map((o) => `${o.v}=${o.label}`).join("|");
    if (sig === this.sig) return;
    this.sig = sig;
    this.el.textContent = "";
    let group = null, groupName = null;
    for (const o of opts) {
      const label = o.label;
      let parent = this.el;
      const cut = this.opt.grouped ? label.indexOf(": ") : -1;
      if (cut > 0) {
        const g = label.slice(0, cut);
        if (g !== groupName) {
          group = this.el.appendChild(el("optgroup"));
          group.label = groupName = g;
        }
        parent = group;
      }
      const op = parent.appendChild(el("option", null, label));
      op.value = String(o.v);
    }
    this.v = NaN;
  }

  update(force) {
    if (force) this.build();
    const v = get(this.t, this.r, this.b);
    if (v === this.v) return;
    this.v = v;
    this.el.value = String(v);
    this.el.title = this.el.selectedOptions[0]?.textContent || "";
  }
}

// a few choices side by side
class Seg {
  constructor(t, r, b, opt = {}) {
    Object.assign(this, { t, r, b, m: meta(t, r), v: NaN });
    const e = this.el = el("div", "seg");
    e.setAttribute("role", "group");
    e.setAttribute("aria-label", opt.label || this.m.name);
    this.buttons = options(t, r, b).map((o) => {
      const bt = e.appendChild(el("button", null, opt.short ? opt.short(o.label) : o.label));
      bt.type = "button";
      bt.title = o.label;
      bt.addEventListener("click", () => {
        wake();
        pushUndo();
        W.site_set(t, r, b, o.v);
        this.update(true);
      });
      return { bt, v: o.v };
    });
    segs.push(this);
  }

  update(force) {
    const v = get(this.t, this.r, this.b);
    if (v === this.v && !force) return;
    this.v = v;
    for (const { bt, v: ov } of this.buttons) bt.setAttribute("aria-pressed", String(ov === v));
  }
}

// a body on or off
class Toggle {
  constructor(b) {
    this.b = b;
    const e = this.el = el("button", "switch");
    e.type = "button";
    e.addEventListener("click", () => {
      wake();
      choose(b);
      pushUndo();
      W.site_toggle(b);
      this.update(true);
    });
    this.v = NaN;
    toggles.push(this);
  }

  update(force) {
    const v = get(this.b >= ARP0 ? T.ARPS : T.DRONES, 0, this.b);
    if (v === this.v && !force) return;
    this.v = v;
    this.el.setAttribute("aria-pressed", String(v >= 0.5));
    this.el.textContent = v >= 0.5 ? "On" : "Off";
    this.el.setAttribute("aria-label", `${this.b ? `Planet ${this.b}` : "Sun"} ${v >= 0.5 ? "on" : "off"}`);
  }
}

/* ------------------------------------------------------------------ */
/* building the panes                                                  */

const bodyName = (b) => (b ? `Planet ${b}` : "Sun");
const colHeads = [];

function matrix(box, t, bodies, rows, heads) {
  box.classList.add(bodies.length === 4 ? "d4" : "d3");
  box.appendChild(el("span"));
  for (const b of bodies) {
    const h = el("button", "colhead");
    h.type = "button";
    h.dataset.b = b;
    h.innerHTML = `<span class="nm"><span class="dot"></span>${esc(b >= ARP0 ? `Planet ${b}` : b ? String(b) : "Sun")}</span><span class="sub"></span>`;
    h.setAttribute("aria-label", `Choose ${bodyName(b)}`);
    h.addEventListener("click", () => { wake(); choose(b); });
    box.appendChild(h);
    colHeads.push({ h, b, sub: h.querySelector(".sub") });
  }
  for (const r of rows) {
    const head = heads.find((hd) => hd.row === r);
    if (head) box.appendChild(el("div", "sect", head.name));
    const m = meta(t, r);
    const lab = box.appendChild(el("div", "lab"));
    lab.appendChild(el("span", null, m.name.replace(" (shared)", "")));
    if (t === T.ARPS && (r === A.SCALE || r === A.METER)) {
      const all = lab.appendChild(el("button", "mini", "all"));
      all.type = "button";
      all.title = `Give the chosen arp planet's ${m.name.toLowerCase()} to all three`;
      all.addEventListener("click", () => {
        pushUndo();
        W.site_all_arps(r, sel >= ARP0 ? sel : ARP0);
        refreshAll();
      });
    }
    for (const b of bodies) {
      const cell = box.appendChild(el("div", "cellx"));
      cell.dataset.b = b;
      if (r === 0) cell.appendChild(new Toggle(b).el);
      else if (m.list) cell.appendChild(new Choice(t, r, b, { label: `${bodyName(b)} ${m.name}`, grouped: r === A.SCALE && t === T.ARPS }).el);
      else cell.appendChild(new Field(t, r, b, { label: `${bodyName(b)} ${m.name}`, readonly: t === T.DRONES && r === D.SPEED && b === 0 }).el);
      if (t === T.ARPS && r === A.CLICK) cell.classList.add("free");
    }
  }
}

function headsOf(t) {
  const out = [];
  for (let i = 0; i < W.site_heads(t); i++) {
    out.push({ row: W.site_head_row(t, i), name: cstr(W.site_head_name(t, i)).replace(/ \(ALL .*\)$/, "") });
  }
  return out;
}

const piano = { keys: [], lo: 36, hi: 71 };

function buildSpace() {
  const box = $("space");
  box.appendChild(el("p", "locked-note", "Looping: the drones keep the loop's settings. Loop again to carry on."));
  const line = box.appendChild(el("div", "root-line"));
  const rootField = new Field(T.DRONES, D.ROOT, 0, { big: true, label: "Root",
    title: "The root, in Hz. Drag, or double-click and type 231 or Bb3" });
  line.appendChild(rootField.el);
  const note = line.appendChild(el("div", "root-note"));
  piano.note = note.appendChild(el("b"));
  const snap = note.appendChild(el("button", "tool", "Onto the note"));
  snap.type = "button";
  snap.title = "Move the root to the nearest equal-tempered note";
  snap.addEventListener("click", () => { pushUndo(); W.site_root_snap(); refreshAll(); });

  const keys = box.appendChild(el("div", "piano"));
  keys.setAttribute("role", "group");
  keys.setAttribute("aria-label", "The root as a note");
  const whites = keys.appendChild(el("div", "whites"));
  const nWhite = [...Array(piano.hi - piano.lo + 1).keys()].filter((i) => ![1, 3, 6, 8, 10].includes((piano.lo + i) % 12)).length;
  let wi = 0;
  for (let midi = piano.lo; midi <= piano.hi; midi++) {
    const black = [1, 3, 6, 8, 10].includes(midi % 12);
    const k = el("button", black ? "b" : "w");
    k.type = "button";
    k.setAttribute("aria-label", `${noteName(midi)}, ${hzOf(midi).toFixed(2)} Hz`);
    k.title = `${noteName(midi)}  ${hzOf(midi).toFixed(2)} Hz`;
    if (black) {
      k.style.left = `calc(${(wi / nWhite) * 100}% - ${(0.3 / nWhite) * 100}%)`;
      k.style.width = `${(0.6 / nWhite) * 100}%`;
      keys.appendChild(k);
    } else {
      if (midi % 12 === 0) k.textContent = noteName(midi);
      whites.appendChild(k);
      wi++;
    }
    k.addEventListener("click", () => {
      wake();
      pushUndo();
      W.site_set(T.DRONES, D.ROOT, 0, hzOf(midi));
      refreshAll();
    });
    piano.keys.push({ k, midi, black });
  }
  box.appendChild(el("p", "hint", "Click a key for the root on that note; everything above it stays in just intervals."));
  const rows = box.appendChild(el("div", "rows"));
  for (const r of [D.ORBIT_TIME, D.GRAVITY, D.WANDER, D.COMETS]) {
    const f = new Field(T.DRONES, r, 0);
    const lab = rows.appendChild(el("label", null, meta(T.DRONES, r).name));
    lab.addEventListener("click", () => f.el.focus());
    rows.appendChild(f.el);
  }
}

function buildDrones() {
  buildSpace();
  const box = $("droneMatrix");
  box.parentElement.insertBefore(el("p", "locked-note", "Looping: these play as the loop has them. Loop again to carry on."), box);
  matrix(box, T.DRONES, [0, 1, 2, 3], [0, 1, 2, 3, 4, 5, 6, 7, 8], headsOf(T.DRONES));
}

function buildArps() {
  const box = $("arpMatrix");
  box.parentElement.insertBefore(el("p", "locked-note", "Looping: these play as the loop has them, but for the metronomes."), box);
  const rows = [...Array(A.TEMPO).keys()];
  matrix(box, T.ARPS, [4, 5, 6], rows, headsOf(T.ARPS));
}

function buildClock() {
  const box = $("clock");
  for (const [r, label] of [[A.TEMPO, "Tempo"], [A.SWING, "Swing"], [A.ACCENT, "Accent"]]) {
    const row = box.appendChild(el("label", "field-row"));
    row.appendChild(el("span", null, label));
    row.appendChild(new Field(T.ARPS, r, ARP0, { label }).el);
  }
}

const dims = [];

function buildRack() {
  const rack = $("rack");
  const groups = [
    { title: "Drone tone", c: "var(--drone)", rows: [0, 1, 2, 3, 4, 5], tone: true },
    { title: "Drone effects", c: "var(--drone)", filter: S.FILTER_D, rows: [7, 8, 9, 10, 11, 12, 13, 14, 15] },
    { title: "Note tone", c: "var(--arp)", rows: [16, 17, 18, 19, 20] },
    { title: "Note effects", c: "var(--arp)", filter: S.FILTER_N, rows: [22, 23, 24, 25, 26, 27, 28, 29, 30] },
  ];
  for (const g of groups) {
    const mod = rack.appendChild(el("div", "module"));
    mod.style.setProperty("--c", g.c);
    const head = mod.appendChild(el("div", "mod-head"));
    head.appendChild(el("h3", null, g.title));
    if (g.tone) head.appendChild(toneMenu());
    if (g.filter != null) {
      const f = mod.appendChild(el("div", "filter"));
      f.appendChild(new Seg(T.SOUND, g.filter, 0, { label: `${g.title}: filter`, short: (s) => s.replace("-pass", "") }).el);
    }
    const knobs = mod.appendChild(el("div", "knobs"));
    for (const r of g.rows) {
      const k = new Field(T.SOUND, r, 0, { knob: true, label: meta(T.SOUND, r).name.replace(" (shared)", "") });
      knobs.appendChild(k.el);
      if (r === S.CUTOFF_D || r === S.RES_D) dims.push({ k, filter: S.FILTER_D });
      if (r === S.CUTOFF_N || r === S.RES_N) dims.push({ k, filter: S.FILTER_N });
    }
  }
  rack.appendChild(buildSaves());
}

const tone = { menu: null, v: NaN };
function toneMenu() {
  const m = tone.menu = el("select", "pick");
  m.setAttribute("aria-label", "Drone tone preset");
  m.title = "The Brick's tone presets for the drones";
  const custom = m.appendChild(el("option", null, "Custom"));
  custom.value = "-1";
  custom.disabled = true;
  for (let i = 0; i < W.site_tone_count(); i++) {
    const o = m.appendChild(el("option", null, cstr(W.site_tone_name(i))));
    o.value = String(i);
  }
  m.addEventListener("change", () => { pushUndo(); W.site_tone(parseInt(m.value, 10)); refreshAll(); });
  return m;
}

/* ------------------------------------------------------------------ */
/* choosing a body                                                     */

function choose(b) {
  if (b < 0 || b >= BODIES) return;
  W.site_select(b);
  sel = b;
  showChosen();
}

function showChosen() {
  for (const n of document.querySelectorAll("[data-b]")) n.classList.toggle("sel", +n.dataset.b === sel);
}

/* ------------------------------------------------------------------ */
/* the sky                                                             */

const sky = {
  canvas: null, ctx: null, k: 1, size: 0, dpr: 1, drag: null,

  init() {
    this.canvas = $("sky");
    this.ctx = this.canvas.getContext("2d");
    this.cx = W.site_sky_cx();
    this.cy = W.site_sky_cy();
    this.bg = css(W.site_sky_bg());
    new ResizeObserver(() => this.resize()).observe(this.canvas);
    this.resize();
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this.down(e));
    c.addEventListener("pointermove", (e) => this.move(e));
    c.addEventListener("pointerup", (e) => this.up(e));
    c.addEventListener("pointercancel", () => { this.drag = null; note(""); });
    c.addEventListener("dblclick", (e) => {
      const b = this.hit(e);
      if (b >= 0) { pushUndo(); W.site_toggle(b); }
    });
  },

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.size = r.width;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.k = r.width / 2 / 335;            // the Brick's sky reaches about 335 px from the sun
  },

  draw() {
    const n = W.site_sky(), base = W.site_rec(), stride = W.site_rec_size() / 4;
    const F = new Float32Array(W.memory.buffer, base, n * stride);
    const U = new Uint32Array(W.memory.buffer, base, n * stride);
    const chars = W.site_rec_chars();
    const g = this.ctx, w = this.canvas.width, h = this.canvas.height, s = this.k * this.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = this.bg;
    g.fillRect(0, 0, w, h);
    g.setTransform(s, 0, 0, s, w / 2 - this.cx * s, h / 2 - this.cy * s);
    g.lineCap = "round";
    let open = false, pc = -1, pw = -1;
    const flush = () => {
      if (!open) return;
      g.strokeStyle = css(pc);
      g.lineWidth = pw;
      g.stroke();
      open = false;
    };
    for (let i = 0; i < n; i++) {
      const o = i * stride, kind = F[o], col = U[o + 7];
      if (kind === 2) {                       // lines of a colour and width, one path
        if (!open || col !== pc || F[o + 6] !== pw) {
          flush();
          g.beginPath();
          open = true;
          pc = col;
          pw = F[o + 6];
        }
        g.moveTo(F[o + 1], F[o + 2]);
        g.lineTo(F[o + 3], F[o + 4]);
        continue;
      }
      flush();
      if (kind === 0) {
        g.beginPath();
        g.arc(F[o + 1], F[o + 2], F[o + 5], 0, TAU);
        g.fillStyle = css(col);
        g.fill();
      } else if (kind === 1) {
        g.beginPath();
        g.arc(F[o + 1], F[o + 2], F[o + 5], 0, TAU);
        g.strokeStyle = css(col);
        g.lineWidth = F[o + 6];
        g.stroke();
      } else if (kind === 3) {
        g.fillStyle = css(col);
        g.font = `600 ${Math.round(F[o + 5] * 0.78)}px system-ui, sans-serif`;
        g.textBaseline = "top";
        g.fillText(cstr(chars + U[o + 8]), F[o + 1], F[o + 2]);
      }
    }
    flush();
  },

  // the body under the pointer, or -1 (arp planets drawn over the drones' orbits)
  hit(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = (e.clientX - r.left - r.width / 2) / this.k + this.cx;
    const y = (e.clientY - r.top - r.height / 2) / this.k + this.cy;
    const p = f32(W.site_bodies(), BODIES * 4);
    let best = -1, bd = Infinity;
    for (let b = 0; b < BODIES; b++) {
      const d = Math.hypot(x - p[4 * b], y - p[4 * b + 1]), reach = p[4 * b + 2] + 10 / Math.min(1, this.k);
      if (d < reach && d < bd) { best = b; bd = d; }
    }
    return best;
  },

  down(e) {
    wake();
    const b = this.hit(e);
    if (b < 0) return;
    choose(b);
    capture(this.canvas, e.pointerId);
    this.drag = { b, y: e.clientY, total: 0, acc: 0, moved: false };
  },

  move(e) {
    const d = this.drag;
    if (!d) {
      const b = this.hit(e);
      this.canvas.style.cursor = b < 0 ? "default" : "ns-resize";
      return;
    }
    const dy = e.clientY - d.y;
    d.y = e.clientY;
    d.total += dy;
    if (!d.moved) {
      if (Math.abs(d.total) < 3) return;
      d.moved = true;
      pushUndo(`sky.${d.b}`);
    }
    if (d.b < ARP0) {                          // a drone's speed, the sun's root: cents a pixel
      W.site_bend(d.b, -dy * (e.shiftKey ? 0.25 : 2.5));
      note(d.b ? `Planet ${d.b}  ${text(T.DRONES, D.SPEED, d.b)}  ${W.site_freq(d.b).toFixed(2)} Hz`
               : `Root ${text(T.DRONES, D.ROOT, 0)}  ${text(T.DRONES, D.NOTE, 0)}`);
    } else {                                   // an arp planet's note length, a step per 24 px
      d.acc -= dy;
      while (Math.abs(d.acc) >= 24) {
        const dir = Math.sign(d.acc);
        W.site_step(T.ARPS, A.LENGTH, d.b, dir, 0);
        d.acc -= dir * 24;
      }
      note(`Planet ${d.b}  ${text(T.ARPS, A.LENGTH, d.b)} notes`);
    }
  },

  up(e) {
    const d = this.drag;
    this.drag = null;
    if (d && d.moved && d.b > 0 && d.b < ARP0 && !e.altKey) W.site_snap_ratio(d.b, 15);
    setTimeout(() => note(""), d && d.moved ? 900 : 0);
  },
};

function note(s) {
  const n = $("dragNote");
  if (s) n.textContent = s;
  n.classList.toggle("show", !!s);
}

/* ------------------------------------------------------------------ */
/* the inspector: what the chosen body is doing                        */

let inspected = "";
function renderInspector() {
  const raw = cstr(W.site_inspect(sel));
  if (raw === inspected) return;
  inspected = raw;
  let j;
  try { j = JSON.parse(raw); } catch { return; }
  const box = $("inspector");
  const c = j.col;
  let h = `<div class="ti"><b>${esc(j.title)}</b><span style="--c:${c}">${esc(j.on ? (j.voice || j.sound) : "off")}</span></div>`;
  if (j.kind === "drone") {
    h += `<div class="big">${esc(j.hz)}<small>Hz</small></div><div class="ln">${esc(j.line)}</div>`;
    if (j.pulled) h += `<div class="ln${j.warn ? " warn" : ""}">pulled ${esc(j.pulled)}</div>`;
    h += `<h3>Pitch ratio with</h3>`;
    if (j.with.length) {
      h += `<div class="with">${j.with.map((w) => `<span>${esc(w.with)}</span><span>${esc(w.ratio)}</span><span class="${w.lock ? "ok" : w.near ? "near" : "far"}">${esc(w.state)}</span>`).join("")}</div>`;
    } else h += `<div class="ln off">no other drone on</div>`;
    h += `<div class="ln" style="margin-top:8px">orbit ${esc(j.orbit)}</div>`;
    const sun = j.with.find((w) => w.with === "sun");
    if (j.b > 0 && sun && !sun.lock) h += `<button class="tool snap" type="button" data-snap="${j.b}">Onto the simple ratio with the sun</button>`;
  } else {
    if (j.note) h += `<div class="big" style="color:${j.notecol}">${esc(j.note)}<small>${esc(j.hz)}</small></div>`;
    h += `<div class="ln">${esc(j.scale)}</div>`;
    h += j.lines.filter((l) => l.trim()).map((l) => `<div class="ln">${esc(l)}</div>`).join("");
    h += `<h3>This pass</h3><div class="pass">${j.pass.map((p, i) => `<span class="${i === j.heard && j.flash > 0 ? "at" : ""}" style="color:${p.c}">${esc(p.t)}</span>`).join("")}</div>`;
  }
  box.innerHTML = h;
  box.style.setProperty("--c", c);
  const snap = box.querySelector("[data-snap]");
  if (snap) snap.addEventListener("click", () => { pushUndo(); W.site_snap_ratio(+snap.dataset.snap, 0); refreshAll(); });
}

/* ------------------------------------------------------------------ */
/* the top bar, the looper and the pad                                 */

const beatsState = { sig: "", els: [] };
function renderBar() {
  const playing = info[0] >= 0.5, has = info[1] >= 0.5, bar = info[2];
  $("barNum").textContent = playing && has && bar >= 1 ? String(bar) : "–";
  const n = info[4], groups = info[20] >>> 0, sig = `${n}.${groups}`;
  const box = $("beats");
  if (sig !== beatsState.sig) {
    beatsState.sig = sig;
    box.textContent = "";
    beatsState.els = [];
    for (let i = 0; i < n; i++) {
      const g = i > 0 && ((groups >>> i) & 1);
      const b = box.appendChild(el("i", (i === 0 ? "down" : g ? "strong gap" : "")));
      beatsState.els.push(b);
    }
  }
  const now = playing && has ? info[5] : -1, frac = info[6], col = css(info[21] >>> 0);
  beatsState.els.forEach((b, i) => {
    b.style.background = i === now ? col : "";
    b.style.opacity = i === now ? String(1 - 0.6 * frac) : "";
  });
}

function loopWords() {
  const mode = info[7], left = info[11], first = info[8], bars = info[9], n = info[14], bar = info[2];
  const last = first + bars - 1;
  if (info[0] < 0.5) return { sub: `${n} + ${n} bars`, text: "Press Play first, then Loop: it takes the bars around now and plays them again and again." };
  if (mode === LOOP.REC) {
    const come = left > 0 ? `${left} bar${left === 1 ? "" : "s"} to come` : "its last bar";
    return { sub: come, text: `Recording: ${come}, then bars ${first}–${last} play again and again, every note and move the same.` };
  }
  if (mode === LOOP.PLAY) {
    return { sub: `bar ${bar - first + 1} of ${bars}`, text: `Looping bars ${first}–${last}. Only the Sound settings change now; Loop again to carry on from here.` };
  }
  return { sub: `${n} + ${n} bars`, text: `Loop takes the ${n} bar${n === 1 ? "" : "s"} up to now and the ${n} to come, and plays those ${2 * n} bars again and again.` };
}

let loopSig = "";
function renderLoop() {
  const mode = info[7], words = loopWords();
  for (const id of ["loopTop", "loopBig"]) {
    const b = $(id);
    b.classList.toggle("rec", mode === LOOP.REC);
    b.classList.toggle("play", mode === LOOP.PLAY);
    b.setAttribute("aria-pressed", String(mode !== LOOP.OFF));
  }
  $("loopTop").querySelector(".loop-word").textContent = mode === LOOP.PLAY ? "Looping" : mode === LOOP.REC ? "Recording" : "Loop";
  $("loopTop").querySelector(".loop-sub").textContent = words.sub;
  $("loopBig").querySelector("span").textContent = mode === LOOP.OFF ? "Loop" : "Stop the loop";
  const t = $("loopText");
  if (t.textContent !== words.text) t.textContent = words.text;

  // the loop's bars, as the Brick draws them: kept and to come, the press between
  const on = mode !== LOOP.OFF, has = info[1] >= 0.5 && info[0] >= 0.5, bar = has ? info[2] : 0;
  const n = on ? info[9] : 2 * info[14];
  let first = on ? info[8] : bar - n / 2 + 1;
  if (first < 1) first = 1;
  const mid = on ? info[10] : bar;
  const sig = `${mode}.${n}.${first}.${mid}.${bar}`;
  if (sig === loopSig) return;
  loopSig = sig;
  const box = $("loopCells");
  box.textContent = "";
  for (let i = 0; i < n; i++) {
    const b = first + i;
    let cls = b === bar ? "now" : b < bar ? "past" : "";
    if (mode === LOOP.REC) cls += " rec";
    if (mode === LOOP.PLAY) cls += " lp";
    if (b === mid && i < n - 1) cls += " press";
    box.appendChild(el("i", cls, String(b)));
  }
}

const pad = {
  init() {
    const e = this.el = $("pad");
    this.dot = e.querySelector(".pad-dot");
    let on = false;
    const set = (ev) => {
      const r = e.getBoundingClientRect();
      const x = clamp((ev.clientX - r.left - 8) / (r.width - 16), 0, 1), y = clamp(1 - (ev.clientY - r.top - 8) / (r.height - 16), 0, 1);
      W.site_set(T.DRONES, D.GRAVITY, 0, Math.round(y * 100) / 100);
      W.site_set(T.DRONES, D.WANDER, 0, Math.round(x * 300) / 10);
    };
    e.addEventListener("pointerdown", (ev) => {
      wake();
      capture(e, ev.pointerId);
      on = true;
      pushUndo("pad");
      set(ev);
    });
    e.addEventListener("pointermove", (ev) => { if (on) set(ev); });
    e.addEventListener("pointerup", () => { on = false; });
    e.addEventListener("pointercancel", () => { on = false; });
    e.addEventListener("keydown", (ev) => {
      const k = { ArrowUp: [D.GRAVITY, 1], ArrowDown: [D.GRAVITY, -1], ArrowRight: [D.WANDER, 1], ArrowLeft: [D.WANDER, -1] }[ev.key];
      if (!k) return;
      ev.preventDefault();
      pushUndo("pad");
      W.site_step(T.DRONES, k[0], 0, k[1], ev.shiftKey ? 1 : 0);
    });
  },
  render() {
    const g = get(T.DRONES, D.GRAVITY, 0), w = get(T.DRONES, D.WANDER, 0);
    this.dot.style.left = `calc(8px + ${clamp(w / 30, 0, 1)} * (100% - 16px))`;
    this.dot.style.top = `calc(8px + ${1 - clamp(g, 0, 1)} * (100% - 16px))`;
    this.el.setAttribute("aria-valuetext", `gravity ${text(T.DRONES, D.GRAVITY, 0)}, wander ${text(T.DRONES, D.WANDER, 0)}`);
  },
};

/* ------------------------------------------------------------------ */
/* refreshing                                                          */

let lastToast = 0, toastTimer = 0;
function toast(s) {
  const t = $("toast");
  t.textContent = s;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function refreshAll() {
  for (const c of [...fields, ...choices, ...toggles, ...segs]) c.update(true);
}

function refresh() {
  const slow = frameNo % 30 === 0;
  info = new Float32Array(f32(W.site_info(), 32));
  const playing = info[0] >= 0.5, looping = info[15] >= 0.5;
  $("play").classList.toggle("on", playing);
  $("play").setAttribute("aria-label", playing ? "Stop" : "Play");
  $("startHint").hidden = playing;
  document.body.classList.toggle("locked", looping);
  $("hold").setAttribute("aria-pressed", String(info[12] >= 0.5));
  $("undo").disabled = !hist.past.length;
  $("redo").disabled = !hist.future.length;
  if (info[13] !== sel) { sel = info[13]; showChosen(); }

  for (const c of fields) c.update(slow);
  for (const c of choices) c.update(slow);
  for (const c of toggles) c.update(slow);
  for (const c of segs) c.update(slow);
  for (const { k, filter } of dims) k.el.classList.toggle("dim", get(T.SOUND, filter, 0) < 0.5);
  renderBar();
  renderLoop();
  pad.render();
  if (frameNo % 6 === 0) renderInspector();

  if (slow) {
    for (const { h, b, sub } of colHeads) {
      h.style.setProperty("--c", css(W.site_body_col(b)));
      const cell = h.parentElement.querySelectorAll(`.cellx[data-b="${b}"]`);
      cell.forEach((x) => x.style.setProperty("--c", css(W.site_body_col(b))));
      sub.textContent = b < ARP0 ? W.site_freq(b).toFixed(2) : text(T.ARPS, A.INSTRUMENT, b);
      if (b < ARP0) sub.title = `${bodyName(b)} sounds at ${sub.textContent} Hz`;
    }
    const t = info[22];
    if (tone.menu && t !== tone.v) {
      tone.v = t;
      tone.menu.value = String(t);
    }
    const midi = 69 + 12 * Math.log2(get(T.DRONES, D.ROOT, 0) / 440), near = Math.round(midi);
    piano.note.textContent = text(T.DRONES, D.NOTE, 0);
    for (const { k, midi: m } of piano.keys) {
      k.classList.toggle("on", m === near && Math.abs(midi - near) < 0.005);
      k.classList.toggle("near", m === near && Math.abs(midi - near) >= 0.005);
    }
  }

  // levels, as dB from -48
  const meter = $("meter").children;
  for (let c = 0; c < 2; c++) {
    const db = info[18 + c] > 0 ? 20 * Math.log10(info[18 + c]) : -96;
    meter[c].style.clipPath = `inset(0 ${(100 - clamp((db + 48) / 48, 0, 1) * 100).toFixed(1)}% 0 0)`;
  }
  if (info[16] > lastToast + 1e-3) toast(cstr(W.site_toast()));
  lastToast = info[16];
  recorder.tick();
}

/* ------------------------------------------------------------------ */
/* sound                                                               */

const audio = { ctx: null, node: null, gain: null, starting: null, states: 0, rate: 48000, sent: null, sentAt: 0 };

function wake() {
  if (!audio.starting) audio.starting = startAudio();
  else if (audio.ctx && audio.ctx.state === "suspended") audio.ctx.resume();
  return audio.starting;
}

async function startAudio() {
  const ctx = audio.ctx = new AudioContext({ sampleRate: 48000, latencyHint: "playback" });
  try {
    await ctx.audioWorklet.addModule("worklet.js");
    const node = new AudioWorkletNode(ctx, "spheres", { numberOfInputs: 0, outputChannelCount: [2] });
    const gain = ctx.createGain();
    gain.gain.value = volume();
    node.connect(gain).connect(ctx.destination);
    node.port.onmessage = (e) => fromEngine(e.data);
    node.port.postMessage({ type: "init", bytes: wasmBytes.slice(0) });
    audio.node = node;
    audio.gain = gain;
    audio.sent = null;
  } catch (err) {
    toast(`Sound could not start: ${err.message}`);
  }
}

function fromEngine(m) {
  if (m.type === "state") {
    bytesAt(W.site_state(), m.bytes.length).set(m.bytes);
    W.site_state_ready();
    audio.states++;
  } else if (m.type === "levels") W.site_levels(m.l, m.r);
  else if (m.type === "ready") audio.rate = m.sampleRate;
  else if (m.type === "chunk") recorder.add(m.data);
  else if (m.type === "recorded") recorder.finish();
  else if (m.type === "error") toast(`Sound: ${m.message}`);
}

// the snapshot goes over when it changes (and each second regardless)
function sendSnapshot(now) {
  if (!audio.node) return;
  const snap = bytesAt(W.site_snapshot(), snapSize);
  const s = audio.sent;
  let same = s && now - audio.sentAt < 1000;
  if (same) for (let i = 0; i < snapSize; i++) if (s[i] !== snap[i]) { same = false; break; }
  if (same) return;
  audio.sent = snap.slice();
  audio.sentAt = now;
  const copy = snap.slice();
  audio.node.port.postMessage({ type: "snapshot", bytes: copy }, [copy.buffer]);
}

function volume() {
  const v = parseFloat(storageGet(VOLUME_KEY));
  return Number.isFinite(v) ? clamp(v, 0, 1) : 0.8;
}

/* record what is heard, as a 16-bit WAV */
const recorder = {
  on: false, chunks: [], frames: 0, t0: 0, last: null,
  async toggle() {
    if (this.on) return this.stop();
    await wake();
    if (!audio.node) return;
    this.on = true;
    this.chunks = [];
    this.frames = 0;
    this.t0 = performance.now();
    audio.node.port.postMessage({ type: "record", on: true });
    $("record").classList.add("on");
    if (info[0] < 0.5) toast("Recording: press Play to hear something");
  },
  stop() {
    if (!this.on) return;
    this.on = false;
    audio.node.port.postMessage({ type: "record", on: false });
    $("record").classList.remove("on");
  },
  add(f) {
    const out = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const s = clamp(f[i], -1, 1);
      out[i] = s < 0 ? s * 32768 : s * 32767;
    }
    this.chunks.push(out);
    this.frames += f.length / 2;
    if (this.frames > audio.rate * 60 * 30) {
      this.stop();
      toast("Recording stopped at 30 minutes");
    }
  },
  finish() {
    const data = this.frames * 4, head = new DataView(new ArrayBuffer(44));
    const put = (o, s) => [...s].forEach((ch, i) => head.setUint8(o + i, ch.charCodeAt(0)));
    put(0, "RIFF"); head.setUint32(4, 36 + data, true); put(8, "WAVE"); put(12, "fmt ");
    head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, 2, true);
    head.setUint32(24, audio.rate, true); head.setUint32(28, audio.rate * 4, true);
    head.setUint16(32, 4, true); head.setUint16(34, 16, true); put(36, "data"); head.setUint32(40, data, true);
    const blob = new Blob([head, ...this.chunks], { type: "audio/wav" });
    const secs = Math.round(this.frames / audio.rate), d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
    const name = `spheres-${stamp}.wav`;
    let peak = 0;
    for (const c of this.chunks) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
    this.last = { frames: this.frames, bytes: blob.size, peak: +(peak / 32768).toFixed(3) };
    this.chunks = [];
    if (!SELFTEST) save(blob, name);
    toast(`Saved ${name}, ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`);
  },
  tick() {
    if (!this.on) return;
    const s = Math.floor((performance.now() - this.t0) / 1000);
    const w = $("record").querySelector(".rec-word"), t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    if (w.textContent !== t) w.textContent = t;
  },
};

/* ------------------------------------------------------------------ */
/* saves, the session, files and links                                 */

function storageGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function storageSet(k, v) {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch { /* storage off: it lasts until the page closes */ }
}

const slotText = (i) => cstr(W.site_slot(i));
const setSlotText = (i, t) => writeText(W.site_slot(i), W.site_slot_size(), t);

function loadSlots() {
  for (let i = 0; i < W.site_slot_count(); i++) setSlotText(i, storageGet(SLOTS_KEY(i)) || "");
  W.site_slots_loaded();
}

function storeSlots() {
  const dirty = W.site_slots_dirty();
  if (!dirty) return;
  for (let i = 0; dirty >>> i; i++) if ((dirty >>> i) & 1) storageSet(SLOTS_KEY(i), slotText(i));
  renderSlots();
}

let kept = null;
const sessionText = () => cstr(W.site_session());
function keepSession() {
  const t = sessionText();
  if (t !== kept) {
    storageSet(SESSION_KEY, t);
    kept = t;
  }
}

function loadText(t) {
  writeText(W.site_session_buf(), W.site_session_size(), t);
  return W.site_session_load();
}

const slotRows = [];
function buildSaves() {
  const mod = el("div", "module saves");
  mod.style.setProperty("--c", "var(--text)");
  const head = mod.appendChild(el("div", "mod-head"));
  head.appendChild(el("h3", null, "Saves"));
  head.appendChild(el("span", "hint", "kept in this browser"));
  head.lastChild.style.margin = "0";
  const list = mod.appendChild(el("div", "slots"));
  for (let i = 0; i < W.site_slot_count(); i++) {
    const row = list.appendChild(el("div", "slot"));
    row.appendChild(el("span", "n", String(i + 1)));
    const t = row.appendChild(el("button", "t"));
    t.type = "button";
    t.title = "Load this slot";
    t.addEventListener("click", () => { pushUndo(); W.site_slot_load(i); refreshAll(); renderSlots(); });
    const acts = row.appendChild(el("div", "acts"));
    const sv = acts.appendChild(el("button", null, "Save"));
    sv.type = "button";
    sv.title = "Save the sky now in this slot";
    let asking = 0;
    sv.addEventListener("click", () => {
      const full = !!slotText(i), cur = W.site_current() === i;
      if (full && !cur && !asking) {
        sv.textContent = "Replace?";
        sv.classList.add("ask");
        asking = setTimeout(() => { asking = 0; sv.textContent = "Save"; sv.classList.remove("ask"); }, 3000);
        return;
      }
      clearTimeout(asking);
      asking = 0;
      sv.textContent = "Save";
      sv.classList.remove("ask");
      W.site_slot_save(i);
      storeSlots();
    });
    const dl = acts.appendChild(el("button"));
    dl.type = "button";
    dl.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>`;
    dl.setAttribute("aria-label", `Download slot ${i + 1} for the Brick`);
    dl.title = `Download slot${i + 1}.txt, the Brick's own file`;
    dl.addEventListener("click", () => save(new Blob([slotText(i)], { type: "text/plain" }), `slot${i + 1}.txt`));
    slotRows.push({ row, t, dl });
  }
  const tools = mod.appendChild(el("div", "save-tools"));
  const open = tools.appendChild(el("button", "tool", "Open a file"));
  open.type = "button";
  open.title = "Open a save: a slot file from the Brick, or the old page's saves";
  const file = mod.appendChild(el("input"));
  file.type = "file";
  file.accept = ".txt,.json,text/plain,application/json";
  file.hidden = true;
  open.addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    if (file.files[0]) openFile(file.files[0]);
    file.value = "";
  });
  const link = tools.appendChild(el("button", "tool", "Copy link"));
  link.type = "button";
  link.title = "Copy a link that holds this whole sky";
  link.addEventListener("click", shareLink);
  const fresh = tools.appendChild(el("button", "tool", "Starting sky"));
  fresh.type = "button";
  fresh.title = "Everything back to how Spheres starts (the slots stay)";
  let sure = 0;
  fresh.addEventListener("click", () => {
    if (!sure) {
      fresh.textContent = "Sure? Click again";
      sure = setTimeout(() => { sure = 0; fresh.textContent = "Starting sky"; }, 3000);
      return;
    }
    clearTimeout(sure);
    sure = 0;
    fresh.textContent = "Starting sky";
    pushUndo();
    W.site_fresh();
    refreshAll();
  });
  mod.appendChild(el("p", "note", "A slot's download is the Brick's own file: copy it to Tools/tg5040/Spheres.pak/saves/ on the card."));
  return mod;
}

function renderSlots() {
  const cur = W.site_current();
  slotRows.forEach(({ row, t, dl }, i) => {
    const title = cstr(W.site_slot_title(i));
    t.textContent = title || "empty";
    t.disabled = !title;
    dl.hidden = !title;
    row.classList.toggle("cur", cur === i && !!title);
  });
}

async function openFile(f) {
  const body = await f.text();
  if (/\.json$/i.test(f.name) || body.trim().startsWith("{")) {
    try {
      const d = JSON.parse(body);
      if (d.app === "spheres" && Array.isArray(d.slots)) {
        const n = d.slots.filter((s) => s).length;
        if (!confirm(`Put the ${n} saves from ${f.name} in the slots? Slots they fill are replaced.`)) return;
        d.slots.forEach((s, i) => {
          if (i < W.site_slot_count() && typeof s === "string" && s) {
            setSlotText(i, s);
            storageSet(SLOTS_KEY(i), s);
          }
        });
        W.site_slots_loaded();
        renderSlots();
        toast(`${n} saves from ${f.name} are in the slots`);
        return;
      }
    } catch { /* not JSON: try it as a save below */ }
  }
  pushUndo();
  if (loadText(body)) {
    refreshAll();
    toast(`Opened ${f.name}`);
  } else {
    hist.past.pop();
    toast(`${f.name} is not a Spheres save`);
  }
}

function save(blob, name) {
  const a = el("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* a link that holds the sky: the save text, deflated, in the address's # */
const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function pack(t) {
  const bytes = encoder.encode(t);
  if (typeof CompressionStream === "function") {
    const z = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return "z" + b64(new Uint8Array(await new Response(z).arrayBuffer()));
  }
  return "t" + b64(bytes);
}

async function unpack(s) {
  const bytes = unb64(s.slice(1));
  if (s[0] === "z") {
    const z = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return decoder.decode(await new Response(z).arrayBuffer());
  }
  return decoder.decode(bytes);
}

async function shareLink() {
  const url = `${location.origin}${location.pathname}#s=${await pack(sessionText())}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied: whoever opens it gets this sky");
  } catch {
    prompt("Copy this link: it holds the whole sky", url);
  }
}

async function fromLink() {
  const m = location.hash.match(/^#s=([zt][A-Za-z0-9_-]+)$/);
  if (!m) return false;
  window.history.replaceState(null, "", location.pathname + location.search);
  try {
    if (loadText(await unpack(m[1]))) {
      toast("The sky from the link: press Play");
      return true;
    }
  } catch { /* a broken link: say so below */ }
  toast("That link does not hold a Spheres sky");
  return false;
}

/* ------------------------------------------------------------------ */
/* keys                                                                */

function bindKeys() {
  addEventListener("keydown", (e) => {
    const t = e.target;
    const typing = t.closest && t.closest("select, textarea, input:not([type=range])");
    if (e.ctrlKey || e.metaKey) {
      if (typing) return;
      const k = e.key.toLowerCase();
      if (k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (k === "y") { e.preventDefault(); redo(); }
      return;
    }
    if (typing || e.altKey || $("help").open) return;
    if (e.key === " ") {
      if (t.tagName === "BUTTON") return;
      e.preventDefault();
      play();
    } else if (e.key === "l" || e.key === "L") { wake(); W.site_loop(); }
    else if (e.key === "c" || e.key === "C") { wake(); W.site_comet(); }
    else if (e.key === "h" || e.key === "H") W.site_hold();
    else if (e.key === "?") $("help").showModal();
    else if (/^[0-6]$/.test(e.key)) choose(+e.key);
  });
}

function play() {
  wake();
  W.site_play();
}

/* ------------------------------------------------------------------ */
/* start                                                               */

async function main() {
  wasmBytes = await (await fetch("spheres.wasm")).arrayBuffer();
  const module = await WebAssembly.compile(wasmBytes);
  const imports = {};
  for (const i of WebAssembly.Module.imports(module)) {
    if (i.kind === "function") (imports[i.module] ??= {})[i.name] = () => 0;
  }
  W = (await WebAssembly.instantiate(module, imports)).exports;
  W._initialize?.();
  if (!W.site_init()) throw new Error("the app did not start");
  snapSize = W.site_snapshot_size();

  loadSlots();
  if (!(await fromLink())) {
    const t = storageGet(SESSION_KEY);
    if (t) loadText(t);
  }
  kept = sessionText();
  setInterval(keepSession, 5000);
  addEventListener("pagehide", keepSession);

  buildClock();
  buildDrones();
  buildArps();
  buildRack();
  const loopSet = $("loopSet");
  loopSet.appendChild(el("span", "lab", "Bars each side"));
  loopSet.appendChild(new Seg(T.LOOP, LP.BARS, 0, { label: "Bars each side" }).el);
  loopSet.appendChild(el("span", "lab", "Count bars of"));
  loopSet.appendChild(new Choice(T.LOOP, LP.COUNT, 0, { label: "Count bars of" }).el);
  sky.init();
  pad.init();
  renderSlots();
  choose(1);

  $("play").addEventListener("click", play);
  $("startHint").addEventListener("click", play);
  for (const id of ["loopTop", "loopBig"]) $(id).addEventListener("click", () => { wake(); W.site_loop(); });
  $("comet").addEventListener("click", () => { wake(); W.site_comet(); });
  $("hold").addEventListener("click", () => W.site_hold());
  $("undo").addEventListener("click", undo);
  $("redo").addEventListener("click", redo);
  $("record").addEventListener("click", () => recorder.toggle());
  $("share").addEventListener("click", shareLink);
  for (const id of ["helpBtn", "helpLink"]) $(id).addEventListener("click", () => $("help").showModal());
  const vol = $("volume");
  vol.value = String(volume());
  vol.addEventListener("input", () => {
    storageSet(VOLUME_KEY, vol.value);
    if (audio.gain) audio.gain.gain.setTargetAtTime(parseFloat(vol.value), audio.ctx.currentTime, 0.02);
  });
  const swell = $("swell");
  const spring = () => { swell.value = "0"; };
  swell.addEventListener("pointerup", spring);
  swell.addEventListener("pointercancel", spring);
  swell.addEventListener("change", spring);
  swell.addEventListener("blur", spring);
  addEventListener("pointerdown", () => wake(), { once: true });
  bindKeys();

  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    frameNo++;
    W.site_frame(parseFloat(swell.value) || 0, dt);
    storeSlots();
    sendSnapshot(now);
    sky.draw();
    refresh();
    requestAnimationFrame(frame);
  };
  refreshAll();
  refresh();
  requestAnimationFrame(frame);
  if (SELFTEST) selftest();
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("afterbegin", `<p style="padding:16px;color:#ff6b62">Spheres could not start: ${esc(err.message)}</p>`);
});

/* ------------------------------------------------------------------ */
/* ?selftest: drives the page as a person would and reports to the
   local server's log (GET __report?...), for checking without a mouse */

async function selftest() {
  const out = {}, errors = [];
  addEventListener("error", (e) => errors.push(String(e.message)));
  addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const pointer = (target, type, x, y, extra = {}) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0, buttons: 1, ...extra }));
  const drag = (target, dx, dy) => {
    const r = target.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    pointer(target, "pointerdown", x, y);
    for (let i = 1; i <= 5; i++) pointer(target, "pointermove", x + (dx * i) / 5, y + (dy * i) / 5);
    pointer(target, "pointerup", x + dx, y + dy);
  };
  try {
    out.built = { fields: fields.length, choices: choices.length, toggles: toggles.length, segs: segs.length };
    out.startRoot = [text(T.DRONES, D.ROOT, 0), text(T.ARPS, A.TEMPO, ARP0), location.hash || "(no #)"];
    await wake();
    $("play").click();
    await wait(4000);
    out.audio = audio.ctx && audio.ctx.state;
    out.states = audio.states;
    out.playing = info[0];
    out.bar = info[2];
    out.levels = [+info[18].toFixed(3), +info[19].toFixed(3)];
    const lev = fields.find((f) => f.t === T.DRONES && f.r === D.LEVEL && f.b === 1);
    const l0 = get(T.DRONES, D.LEVEL, 1);
    drag(lev.el, 40, 0);
    out.levelDrag = [+l0.toFixed(3), +get(T.DRONES, D.LEVEL, 1).toFixed(3), lev.txt.textContent];
    const grav = fields.find((f) => f.t === T.DRONES && f.r === D.GRAVITY);
    grav.el.focus();
    grav.el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    out.gravityStep = +get(T.DRONES, D.GRAVITY, 0).toFixed(3);
    const voice = choices.find((c) => c.t === T.DRONES && c.r === D.VOICE && c.b === 2);
    voice.el.value = "2";
    voice.el.dispatchEvent(new Event("change"));
    out.voice = get(T.DRONES, D.VOICE, 2);
    undo();
    out.voiceUndone = get(T.DRONES, D.VOICE, 2);
    redo();
    out.voiceRedone = get(T.DRONES, D.VOICE, 2);
    const speed = fields.find((f) => f.t === T.DRONES && f.r === D.SPEED && f.b === 3);
    speed.edit();
    speed.editing.value = "5:2";
    speed.editing.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    out.typedSpeed = text(T.DRONES, D.SPEED, 3);
    const root = fields.find((f) => f.t === T.DRONES && f.r === D.ROOT);
    root.edit();
    root.editing.value = "A2";
    root.editing.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    out.typedRoot = [text(T.DRONES, D.ROOT, 0), text(T.DRONES, D.NOTE, 0)];
    const p = f32(W.site_bodies(), BODIES * 4), r = sky.canvas.getBoundingClientRect();
    const at = (b) => [r.left + r.width / 2 + (p[4 * b] - sky.cx) * sky.k, r.top + r.height / 2 + (p[4 * b + 1] - sky.cy) * sky.k];
    const [x5, y5] = at(5);
    pointer(sky.canvas, "pointerdown", x5, y5);
    pointer(sky.canvas, "pointerup", x5, y5);
    out.skyChose = sel;
    out.colLit = document.querySelectorAll(".colhead.sel").length + ":" + document.querySelector(".colhead.sel")?.dataset.b;
    const [x2, y2] = at(2);
    const s2 = get(T.DRONES, D.SPEED, 2);
    pointer(sky.canvas, "pointerdown", x2, y2);
    for (let i = 1; i <= 6; i++) pointer(sky.canvas, "pointermove", x2, y2 - 10 * i);
    pointer(sky.canvas, "pointerup", x2, y2 - 60);
    out.skyDrag = [+s2.toFixed(4), +get(T.DRONES, D.SPEED, 2).toFixed(4), text(T.DRONES, D.SPEED, 2)];
    const packed = await pack(sessionText());
    out.link = { chars: packed.length, same: (await unpack(packed)) === sessionText() };
    W.site_slot_save(2);
    storeSlots();
    out.slot3 = cstr(W.site_slot_title(2));
    $("loopBig").click();
    await wait(800);
    out.loopRec = [info[7], $("loopText").textContent];
    await recorder.toggle();
    await wait(1500);
    recorder.stop();
    await wait(1000);
    out.recorded = recorder.last;
    const t0 = performance.now(), f0 = frameNo;
    await wait(2000);
    out.fps = Math.round(((frameNo - f0) * 1000) / (performance.now() - t0));
    out.inspector = $("inspector").textContent.slice(0, 120);
    out.toast = $("toast").textContent;
  } catch (err) {
    out.error = String((err && err.stack) || err);
  }
  out.errors = errors;
  fetch(`__report?${encodeURIComponent(JSON.stringify(out))}`).catch(() => {});
}
