// Audio worklet: runs an app's engine (compiled C) on the audio thread.
// The page posts parameter snapshots; this posts output levels back, and,
// for apps whose engine reports state (the orrery's orbits), that too.

function stubImports(module) {
  const imports = {};
  for (const i of WebAssembly.Module.imports(module)) {
    if (i.kind === "function") (imports[i.module] ??= {})[i.name] = () => 0;
  }
  return imports;
}

class DroneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.x = null;
    this.pending = null;
    this.peak = [0, 0];
    this.frames = 0;
    this.stateFrames = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  async onMessage(msg) {
    if (msg.type === "init") {
      const module = await WebAssembly.compile(msg.bytes);
      const instance = await WebAssembly.instantiate(module, stubImports(module));
      const x = instance.exports;
      x._initialize?.();
      if (!x.au_init(sampleRate)) {
        this.port.postMessage({ type: "error", message: "engine failed to start" });
        return;
      }
      this.x = x;
      if (this.pending) this.apply(this.pending);
      this.port.postMessage({ type: "ready", sampleRate });
    } else if (msg.type === "snapshot") {
      if (this.x) this.apply(msg.bytes);
      else this.pending = msg.bytes;
    }
  }

  apply(bytes) {
    new Uint8Array(this.x.memory.buffer, this.x.au_snapshot(), bytes.length).set(bytes);
    this.x.au_apply();
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!this.x || out.length === 0) return true;
    const n = out[0].length;
    this.x.au_process(n);
    const mem = this.x.memory.buffer;
    const chans = [new Float32Array(mem, this.x.au_left(), n), new Float32Array(mem, this.x.au_right(), n)];
    for (let c = 0; c < out.length && c < 2; c++) {
      out[c].set(chans[c]);
      for (let i = 0; i < n; i++) {
        const a = Math.abs(chans[c][i]);
        if (a > this.peak[c]) this.peak[c] = a;
      }
    }
    this.frames += n;
    if (this.frames >= sampleRate / 30) {
      this.port.postMessage({ type: "levels", l: this.peak[0], r: this.peak[1] });
      this.peak = [0, 0];
      this.frames = 0;
    }
    this.stateFrames += n;
    if (this.x.au_state && this.stateFrames >= sampleRate / 60) {
      this.stateFrames = 0;
      const bytes = new Uint8Array(this.x.memory.buffer, this.x.au_state(), this.x.au_state_size()).slice();
      this.port.postMessage({ type: "state", bytes }, [bytes.buffer]);
    }
    return true;
  }
}

registerProcessor("drone", DroneProcessor);
