// AudioWorklet: turns mic audio into Int16 LE mono 16 kHz frames of 1,600 samples (100 ms)
// and posts each frame (ArrayBuffer) to the main thread. If the context isn't running at
// 16 kHz, it downsamples by averaging (good enough for speech).
const TARGET_RATE = 16000;
const FRAME = 1600;

class PcmFramer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE; // sampleRate is a worklet global
    this.acc = 0;     // fractional position for downsampling
    this.sum = 0;
    this.n = 0;
    this.frame = new Int16Array(FRAME);
    this.i = 0;
  }

  push(s) {
    const c = Math.max(-1, Math.min(1, s));
    this.frame[this.i++] = c < 0 ? c * 0x8000 : c * 0x7fff;
    if (this.i === FRAME) {
      const out = this.frame;
      this.port.postMessage(out.buffer, [out.buffer]);
      this.frame = new Int16Array(FRAME);
      this.i = 0;
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.ratio === 1) {
      for (let k = 0; k < ch.length; k++) this.push(ch[k]);
      return true;
    }
    for (let k = 0; k < ch.length; k++) {
      this.sum += ch[k];
      this.n++;
      this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        this.push(this.sum / this.n);
        this.sum = 0;
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-framer', PcmFramer);
