// DiscordIA — motor de áudio do microfone
// MicProcessor segue a interface de "processor" do LiveKit (init / restart / destroy / processedTrack),
// então o LiveKit continua cuidando de publicar, silenciar e trocar de microfone.

const WORKLET_URL = new URL('./mic-worklet.js', import.meta.url).href;

export class MicProcessor {
  constructor(settings = {}) {
    this.name = 'discordia-mic';
    this.settings = { inputVolume: 1, rnnoise: true, gate: true, autoSens: true, threshold: -50, hold: 300, ...settings };
    this.ctx = null;
    this.node = null;
    this.source = null;
    this.inGain = null;
    this.dest = null;
    this.processedTrack = undefined;
    this.onLevel = null;   // (info) => void  — {db, threshold, open, vad}
    this.onError = null;
    this.failed = false;
  }

  async ensureContext() {
    if (this.ctx && this.ctx.state !== 'closed') return;
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule(WORKLET_URL);
    this.dest = this.ctx.createMediaStreamDestination();
    this.dest.channelCount = 1;
  }

  buildGraph(track) {
    this.teardownGraph();
    this.source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    this.inGain = this.ctx.createGain();
    this.inGain.gain.value = this.settings.inputVolume;
    this.node = new AudioWorkletNode(this.ctx, 'discordia-mic', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });
    this.node.port.onmessage = (e) => {
      const m = e.data;
      if (m?.type === 'level') this.onLevel?.(m);
      else if (m?.type === 'error') { this.failed = true; this.onError?.(new Error(m.message)); }
    };
    this.pushSettings();
    this.source.connect(this.inGain).connect(this.node).connect(this.dest);
    this.processedTrack = this.dest.stream.getAudioTracks()[0];
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  teardownGraph() {
    try { this.source?.disconnect(); } catch {}
    try { this.inGain?.disconnect(); } catch {}
    try { this.node?.disconnect(); this.node.port.onmessage = null; } catch {}
    this.source = this.inGain = this.node = null;
  }

  pushSettings() {
    const s = this.settings;
    if (this.inGain) this.inGain.gain.setTargetAtTime(s.inputVolume, this.ctx.currentTime, 0.02);
    this.node?.port.postMessage({ rnnoise: !!s.rnnoise, gate: !!s.gate, autoSens: !!s.autoSens, threshold: Number(s.threshold), hold: Number(s.hold) });
  }

  update(settings) {
    Object.assign(this.settings, settings);
    this.pushSettings();
  }

  // ---- interface do LiveKit ----
  async init(opts) {
    await this.ensureContext();
    this.buildGraph(opts.track);
  }
  async restart(opts) {
    await this.ensureContext();
    this.buildGraph(opts.track);
  }
  async destroy() {
    this.teardownGraph();
    try { await this.ctx?.close(); } catch {}
    this.ctx = null;
    this.processedTrack = undefined;
  }
}

// Converte dB para a posição de 0 a 100 usada nos medidores (-80 dB … 0 dB)
export const dbToPct = (db) => Math.max(0, Math.min(100, ((db + 80) / 80) * 100));
export const pctToDb = (pct) => (pct / 100) * 80 - 80;
