// Browser shell for the apps (the drone synth, the orrery with ?app=orrery, or
// Spheres with ?app=spheres, or Trio with ?app=trio):
// collects input from keyboard, mouse/touch and gamepads, runs the app (C, as
// WebAssembly), shows its pixels, forwards its parameter snapshot to the audio
// worklet, and hands the engine's reported state back to the app.

const W = 1024, H = 768;
const APPS = {
  drone: { wasm: "drone.wasm", title: "Drone simulator", device: "DRONE SIM" },
  orrery: { wasm: "orrery.wasm", title: "Orrery simulator", device: "ORRERY SIM" },
  spheres: { wasm: "spheres.wasm", title: "Spheres", device: "SPHERES" },
  trio: { wasm: "trio.wasm", title: "Trio simulator", device: "TRIO SIM" },
};
const APP_NAME = "spheres";
const APP = APPS[APP_NAME];
const BTN = {
  UP: 1 << 0, DOWN: 1 << 1, LEFT: 1 << 2, RIGHT: 1 << 3, A: 1 << 4, B: 1 << 5, X: 1 << 6, Y: 1 << 7,
  L1: 1 << 8, R1: 1 << 9, L2: 1 << 10, R2: 1 << 11, L3: 1 << 12, R3: 1 << 13,
  SELECT: 1 << 14, START: 1 << 15, MENU: 1 << 16,
};
const KEYS = {
  ArrowUp: "UP", ArrowDown: "DOWN", ArrowLeft: "LEFT", ArrowRight: "RIGHT",
  KeyX: "A", KeyZ: "B", KeyS: "X", KeyA: "Y", KeyQ: "L1", KeyW: "R1", Digit1: "L2", Digit2: "R2",
  KeyE: "L3", KeyR: "R3", Backspace: "SELECT", ShiftRight: "SELECT", Enter: "START", Escape: "MENU",
};
// key -> [stick, axis (0 = x, 1 = y), direction]
const STICK_KEYS = {
  KeyT: [0, 1, 1], KeyG: [0, 1, -1], KeyF: [0, 0, -1], KeyH: [0, 0, 1],
  KeyI: [1, 1, 1], KeyK: [1, 1, -1], KeyJ: [1, 0, -1], KeyL: [1, 0, 1],
};
// standard gamepad layout, mapped by position (bottom face button = B)
const PAD_BUTTONS = ["B", "A", "Y", "X", "L1", "R1", "L2", "R2", "SELECT", "START", "L3", "R3",
  "UP", "DOWN", "LEFT", "RIGHT", "MENU"];

const statusEl = document.getElementById("status");
const banner = document.getElementById("banner");
const ctx = document.getElementById("screen").getContext("2d");

function stubImports(module) {
  const imports = {};
  for (const i of WebAssembly.Module.imports(module)) {
    if (i.kind === "function") (imports[i.module] ??= {})[i.name] = () => 0;
  }
  return imports;
}

const state = {
  keys: new Map(),            // code -> time pressed (ms)
  pointerButtons: new Map(),  // pointerId -> bit
  pulses: [],                 // [bit, until] short presses from stick taps
  pointerSticks: [[0, 0], [0, 0]],
  audio: "off",
  levels: [0, 0],
  states: 0,                  // state reports received from the engine
  pad: "",
};

let wasm, wasmBytes, audioCtx, node;

// Save slots live in this browser's storage, one entry per slot; the app
// holds them as text and says which ones changed.
const slotKey = (i) => `${APP_NAME}.slot${i + 1}`;

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, text) {
  try {
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch { /* private window or storage off: slots last until reload */ }
}

function slotText(i) {
  const size = wasm.ui_slot_size();
  const bytes = new Uint8Array(wasm.memory.buffer, wasm.ui_slot(i), size);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(bytes.subarray(0, end < 0 ? size : end));
}

function setSlotText(i, text) {
  const size = wasm.ui_slot_size();
  const enc = new TextEncoder().encode(text || "");
  const n = Math.min(enc.length, size - 1);
  const bytes = new Uint8Array(wasm.memory.buffer, wasm.ui_slot(i), size);
  bytes.set(enc.subarray(0, n));
  bytes[n] = 0;
}

function loadSlots() {
  for (let i = 0; i < wasm.ui_slot_count(); i++) setSlotText(i, storageGet(slotKey(i)) || "");
  wasm.ui_slots_loaded();
}

function storeSlots() {
  const dirty = wasm.ui_slots_dirty();
  for (let i = 0; dirty >>> i; i++) if ((dirty >>> i) & 1) storageSet(slotKey(i), slotText(i));
}

// Where the player left off, kept beside the slots: written every few
// seconds when it has changed and when the page goes away, read at start.
const sessionKey = `${APP_NAME}.session`;
let sessionKept = null;

function sessionBytes() {
  const ptr = wasm.ui_session();             // fills it with the state now
  return new Uint8Array(wasm.memory.buffer, ptr, wasm.ui_session_size());
}

function resumeSession() {
  const text = storageGet(sessionKey);
  if (!text) return;
  const bytes = sessionBytes();
  const enc = new TextEncoder().encode(text);
  const n = Math.min(enc.length, bytes.length - 1);
  bytes.set(enc.subarray(0, n));
  bytes[n] = 0;
  wasm.ui_session_load();
  sessionKept = text;
}

function keepSession() {
  const bytes = sessionBytes();
  const end = bytes.indexOf(0);
  const text = new TextDecoder().decode(bytes.subarray(0, end < 0 ? bytes.length : end));
  if (text !== sessionKept) {
    storageSet(sessionKey, text);
    sessionKept = text;
  }
}

function exportSaves() {
  const slots = [];
  for (let i = 0; i < wasm.ui_slot_count(); i++) slots.push(slotText(i));
  const blob = new Blob([JSON.stringify({ app: APP_NAME, slots }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${APP_NAME}-saves.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importSaves(file) {
  const note = document.getElementById("savesNote");
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== APP_NAME || !Array.isArray(data.slots)) {
      note.textContent = `That file holds ${data.app || "something else"}, not ${APP.title.toLowerCase()} saves.`;
      return;
    }
    for (let i = 0; i < wasm.ui_slot_count(); i++) {
      const text = typeof data.slots[i] === "string" ? data.slots[i] : "";
      setSlotText(i, text);
      storageSet(slotKey(i), text);
    }
    wasm.ui_slots_loaded();
    note.textContent = `Loaded ${data.slots.filter((t) => t).length} saves from ${file.name}.`;
  } catch (err) {
    note.textContent = `Could not read ${file.name}: ${err.message}`;
  }
}

function showApp() {
  document.title = APP.title;
  document.getElementById("title").textContent = APP.title;
  document.getElementById("devname").textContent = APP.device;
  for (const el of document.querySelectorAll("[data-app]")) el.hidden = el.dataset.app !== APP_NAME;
  for (const el of document.querySelectorAll("[data-app-link]")) {
    el.classList.toggle("current", el.dataset.appLink === APP_NAME);
  }
}

async function main() {
  showApp();
  wasmBytes = await (await fetch(APP.wasm)).arrayBuffer();
  const module = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(module, stubImports(module));
  wasm = instance.exports;
  wasm._initialize?.();
  if (!wasm.ui_init()) throw new Error("ui_init failed");
  loadSlots();
  resumeSession();
  setInterval(keepSession, 5000);
  addEventListener("pagehide", keepSession);
  bindInput();
  document.getElementById("exportSaves").addEventListener("click", exportSaves);
  document.getElementById("importSaves").addEventListener("change", (e) => {
    if (e.target.files[0]) importSaves(e.target.files[0]);
    e.target.value = "";
  });
  // test hook: ?autostart starts sound and presses START without a click
  // (only works where the browser allows audio without a gesture)
  if (new URLSearchParams(location.search).has("autostart")) {
    startAudio();
    state.pulses.push([BTN.START, performance.now() + 100]);
    // reports into the local server's request log
    setTimeout(() => fetch(`__report?app=${APP_NAME}&audio=${encodeURIComponent(state.audio)}` +
      `&states=${state.states}` +
      `&peak=${state.levels.map((v) => v.toFixed(3)).join(",")}`).catch(() => {}), 5000);
  }
  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    tick(now, dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function startAudio() {
  if (audioCtx) {
    if (audioCtx.state === "suspended") audioCtx.resume();
    return;
  }
  audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: "playback" });
  state.audio = "starting";
  banner.hidden = true;
  audioCtx.audioWorklet.addModule("worklet.js").then(() => {
    node = new AudioWorkletNode(audioCtx, "drone", { numberOfInputs: 0, outputChannelCount: [2] });
    node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "levels") {
        wasm.ui_levels(m.l, m.r);
        state.levels = [m.l, m.r];
      } else if (m.type === "state" && wasm.ui_state) {
        new Uint8Array(wasm.memory.buffer, wasm.ui_state(), m.bytes.length).set(m.bytes);
        wasm.ui_state_ready();
        state.states++;
      }
      else if (m.type === "ready") state.audio = `running at ${m.sampleRate} Hz`;
      else if (m.type === "error") state.audio = `error: ${m.message}`;
    };
    node.port.postMessage({ type: "init", bytes: wasmBytes.slice(0) });
    node.connect(audioCtx.destination);
  }).catch((err) => {
    state.audio = `error: ${err.message}`;
  });
}

function bindInput() {
  addEventListener("keydown", (e) => {
    startAudio();
    if (!(e.code in KEYS) && !(e.code in STICK_KEYS)) return;
    e.preventDefault();
    if (!state.keys.has(e.code)) state.keys.set(e.code, performance.now());
  });
  addEventListener("keyup", (e) => state.keys.delete(e.code));
  addEventListener("blur", () => state.keys.clear());
  banner.addEventListener("pointerdown", startAudio);

  for (const el of document.querySelectorAll("[data-btn]")) {
    const bit = BTN[el.dataset.btn];
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      startAudio();
      el.setPointerCapture(e.pointerId);
      state.pointerButtons.set(e.pointerId, bit);
    });
    const up = (e) => state.pointerButtons.delete(e.pointerId);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  ["stickL", "stickR"].forEach((id, s) => {
    const el = document.getElementById(id);
    let start = null;
    const move = (e) => {
      const r = el.getBoundingClientRect();
      const reach = r.width * 0.32;
      let x = (e.clientX - (r.left + r.width / 2)) / reach;
      let y = -(e.clientY - (r.top + r.height / 2)) / reach;
      const m = Math.hypot(x, y);
      if (m > 1) { x /= m; y /= m; }
      state.pointerSticks[s] = [x, y];
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) start.moved = true;
    };
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      startAudio();
      el.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
    });
    el.addEventListener("pointermove", (e) => { if (start) move(e); });
    const release = () => {
      // a quick tap without dragging clicks the stick (L3 / R3)
      if (start && !start.moved && performance.now() - start.t < 300) {
        state.pulses.push([s ? BTN.R3 : BTN.L3, performance.now() + 80]);
      }
      start = null;
      state.pointerSticks[s] = [0, 0];
    };
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
  });
}

function readInput(now) {
  let buttons = 0;
  for (const code of state.keys.keys()) if (KEYS[code]) buttons |= BTN[KEYS[code]];
  for (const bit of state.pointerButtons.values()) buttons |= bit;
  state.pulses = state.pulses.filter(([, until]) => until > now);
  for (const [bit] of state.pulses) buttons |= bit;

  const sticks = [[0, 0], [0, 0]];
  for (const [code, t0] of state.keys) {
    const m = STICK_KEYS[code];
    if (m) sticks[m[0]][m[1]] += m[2] * Math.min(1, 0.2 + 0.6 * (now - t0) / 1000);
  }
  const candidates = [sticks, state.pointerSticks];

  state.pad = "";
  for (const pad of navigator.getGamepads?.() ?? []) {
    if (!pad) continue;
    state.pad = pad.id;
    pad.buttons.forEach((b, i) => { if (b.pressed && PAD_BUTTONS[i]) buttons |= BTN[PAD_BUTTONS[i]]; });
    const ax = pad.axes;
    if (ax.length >= 4) candidates.push([[ax[0], -ax[1]], [ax[2], -ax[3]]]);
    break;
  }
  // per stick, the source pushed furthest wins
  const out = [[0, 0], [0, 0]];
  for (let s = 0; s < 2; s++) {
    for (const c of candidates) {
      if (Math.hypot(...c[s]) > Math.hypot(...out[s])) out[s] = c[s];
    }
    out[s] = out[s].map((v) => Math.max(-1, Math.min(1, v)));
  }
  return { buttons, sticks: out };
}

function tick(now, dt) {
  const { buttons, sticks } = readInput(now);
  wasm.ui_frame(buttons, sticks[0][0], sticks[0][1], sticks[1][0], sticks[1][1], dt);
  storeSlots();

  const pixels = new Uint8ClampedArray(wasm.memory.buffer, wasm.ui_pixels(), W * H * 4);
  ctx.putImageData(new ImageData(pixels, W, H), 0, 0);

  if (node) {
    const snap = new Uint8Array(wasm.memory.buffer, wasm.ui_snapshot(), wasm.ui_snapshot_size()).slice();
    node.port.postMessage({ type: "snapshot", bytes: snap }, [snap.buffer]);
  }

  for (const el of document.querySelectorAll("[data-btn]")) {
    el.classList.toggle("on", (buttons & BTN[el.dataset.btn]) !== 0);
  }
  ["stickL", "stickR"].forEach((id, s) => {
    const knob = document.getElementById(id).firstElementChild;
    const reach = knob.parentElement.clientWidth * 0.32;
    knob.style.transform = `translate(${sticks[s][0] * reach}px, ${-sticks[s][1] * reach}px)`;
    knob.classList.toggle("on", (buttons & (s ? BTN.R3 : BTN.L3)) !== 0);
  });
  const status = `audio: ${state.audio}\ngamepad: ${state.pad || "none"}`;
  if (status !== statusEl.textContent) statusEl.textContent = status;
}

main().catch((err) => {
  statusEl.textContent = `failed to start: ${err.message}`;
  console.error(err);
});
