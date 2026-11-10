// Captures raw microphone samples, tagged with the audio-clock time of each chunk
// so the page can line the take up with what was playing.
class Recorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.t = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') {
        this.n = 0;
        this.on = true;
      } else if (e.data === 'stop') {
        this.flush();
        this.on = false;
        this.port.postMessage({ done: true });
      }
    };
  }

  flush() {
    if (!this.n) return;
    this.port.postMessage({ time: this.t, samples: this.buf.slice(0, this.n) });
    this.n = 0;
  }

  process(inputs) {
    if (!this.on) return true;
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.n === 0) this.t = currentTime;
    this.buf.set(ch, this.n);
    this.n += ch.length;
    if (this.n + ch.length > this.buf.length) this.flush();
    return true;
  }
}

registerProcessor('recorder', Recorder);
