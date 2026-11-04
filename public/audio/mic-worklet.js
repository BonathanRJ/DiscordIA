// DiscordIA — processamento do microfone (roda dentro de um AudioWorklet, a 48 kHz)
// Etapas: supressão de ruído forte (RNNoise) → medição de volume → portão de voz (sensibilidade).
import createRNNWasmModuleSync from '../vendor/rnnoise/rnnoise-sync.js';

const FRAME = 480;             // RNNoise trabalha em blocos de 10 ms a 48 kHz
const RING = 1920;             // mmc(128, 480): o bloco do worklet e o do RNNoise "fecham" juntos
const SCALE = 32768;

class RNNoise {
  constructor() {
    this.m = createRNNWasmModuleSync();
    this.state = this.m._rnnoise_create();
    this.ptr = this.m._malloc(FRAME * 4);
  }
  // processa 480 amostras no lugar; devolve a probabilidade de ter voz (0..1)
  process(frame) {
    const heap = this.m.HEAPF32;
    const base = this.ptr >> 2;
    for (let i = 0; i < FRAME; i++) heap[base + i] = frame[i] * SCALE;
    const vad = this.m._rnnoise_process_frame(this.state, this.ptr, this.ptr);
    for (let i = 0; i < FRAME; i++) frame[i] = heap[base + i] / SCALE;
    return vad;
  }
  destroy() {
    try { this.m._rnnoise_destroy(this.state); this.m._free(this.ptr); } catch {}
  }
}

class DiscordiaMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cfg = { rnnoise: false, gate: true, autoSens: true, threshold: -50, hold: 300 };
    this.rnn = null;
    this.ring = new Float32Array(RING);
    this.inLen = 0;      // amostras recebidas no anel
    this.doneLen = 0;    // amostras já processadas pelo RNNoise
    this.outIdx = 0;     // próxima amostra processada a enviar
    this.primed = false; // o RNNoise atrasa 1 bloco (~10 ms) até ter dado pronto
    this.vad = 0;
    // medição e portão
    this.levelDb = -100;
    this.power = 1e-10;  // potência suavizada (~30 ms) usada para decidir se é voz
    this.floorDb = -60;  // estimativa do ruído de fundo (sensibilidade automática)
    this.winMin = Infinity; this.prevMin = Infinity; this.winAge = 0;
    this.gain = 0;       // ganho atual do portão (0 fechado, 1 aberto)
    this.holdLeft = 0;
    this.open = false;
    this.lastReport = 0;
    this.port.onmessage = (e) => this.configure(e.data || {});
  }

  configure(c) {
    Object.assign(this.cfg, c);
    if (this.cfg.rnnoise && !this.rnn) {
      try { this.rnn = new RNNoise(); this.inLen = this.doneLen = this.outIdx = 0; this.primed = false; }
      catch (err) { this.cfg.rnnoise = false; this.port.postMessage({ type: 'error', message: String(err) }); }
    } else if (!this.cfg.rnnoise && this.rnn) {
      this.rnn.destroy();
      this.rnn = null;
    }
  }

  // RNNoise com anel: entra 128, sai 128 (com ~10 ms de atraso)
  denoise(input, output) {
    this.ring.set(input, this.inLen);
    this.inLen += input.length;
    let vadSum = 0, vadN = 0;
    while (this.doneLen + FRAME <= this.inLen) {
      vadSum += this.rnn.process(this.ring.subarray(this.doneLen, this.doneLen + FRAME));
      vadN++;
      this.doneLen += FRAME;
    }
    if (vadN) this.vad = vadSum / vadN;
    let avail = this.outIdx > this.doneLen ? RING - this.outIdx : this.doneLen - this.outIdx;
    if (!this.primed && avail >= FRAME) this.primed = true;
    if (this.primed && avail >= output.length) {
      output.set(this.ring.subarray(this.outIdx, this.outIdx + output.length));
      this.outIdx += output.length;
    } else {
      output.fill(0);
    }
    if (this.outIdx === RING) this.outIdx = 0;
    if (this.inLen === RING) { this.inLen = 0; this.doneLen = 0; }
  }

  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0];
    const outs = outputs[0];
    if (!inp || !outs || !outs[0]) return true;
    const out = outs[0];
    const n = out.length;

    if (this.rnn) this.denoise(inp, out);
    else out.set(inp);

    // volume do bloco (depois da supressão: ruído removido não abre o portão)
    let sum = 0;
    for (let i = 0; i < n; i++) sum += out[i] * out[i];
    const blockPow = sum / n;
    const a = 1 - Math.exp(-(n / sampleRate) / 0.03);
    this.power += (blockPow - this.power) * a;
    const db = 10 * Math.log10(this.power + 1e-12);
    this.levelDb = Math.max(10 * Math.log10(blockPow + 1e-12), this.levelDb - 1.2); // pico com queda suave para o medidor

    // sensibilidade automática: o ruído de fundo é o volume mais baixo dos últimos ~3 s
    // (quase sempre há uma pausa na fala nesse intervalo, então a voz não "ensina" o ruído)
    this.winMin = Math.min(this.winMin, db);
    this.winAge += n / sampleRate;
    if (this.winAge >= 1.5) { this.prevMin = this.winMin; this.winMin = Infinity; this.winAge = 0; }
    const noise = Math.min(this.winMin, this.prevMin);
    if (Number.isFinite(noise)) this.floorDb += (noise - this.floorDb) * 0.02;
    const threshold = this.cfg.autoSens ? Math.min(-24, Math.max(-62, this.floorDb + 9)) : this.cfg.threshold;

    // com RNNoise, a probabilidade de voz também ajuda a decidir
    const voice = db > threshold && (!this.rnn || this.vad > 0.2 || db > threshold + 10);
    const blockMs = (n / sampleRate) * 1000;
    if (!this.cfg.gate) { this.open = true; }
    else if (voice) { this.open = true; this.holdLeft = this.cfg.hold; }
    else if (this.holdLeft > 0) { this.holdLeft -= blockMs; }
    else { this.open = false; }

    // abre rápido (~5 ms), fecha suave (~60 ms) para não cortar sílabas
    const target = this.open ? 1 : 0;
    const coef = target > this.gain ? 1 - Math.exp(-1 / (0.005 * sampleRate)) : 1 - Math.exp(-1 / (0.06 * sampleRate));
    for (let i = 0; i < n; i++) {
      this.gain += (target - this.gain) * coef;
      out[i] *= this.gain;
    }
    for (let c = 1; c < outs.length; c++) outs[c].set(out);

    if (currentTime - this.lastReport > 0.05) {
      this.lastReport = currentTime;
      this.port.postMessage({ type: 'level', db: this.levelDb, threshold, open: this.open, vad: this.vad });
    }
    return true;
  }
}

registerProcessor('discordia-mic', DiscordiaMic);
