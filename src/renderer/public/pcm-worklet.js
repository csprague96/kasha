// Converts the input to 16-bit PCM and posts it in half-second chunks.
// When the input is empty (nothing playing), it writes silence so the mic
// and system tracks stay aligned to the same clock.
const CHUNK = 8000 // 0.5s at 16 kHz

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Int16Array(CHUNK)
    this.n = 0
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        if (this.n > 0) this.post(this.buf.slice(0, this.n))
        this.n = 0
        this.port.postMessage('flushed')
      }
    }
  }

  post(arr) {
    this.port.postMessage(arr.buffer, [arr.buffer])
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    const len = ch ? ch.length : 128
    for (let i = 0; i < len; i++) {
      let s = ch ? ch[i] : 0
      s = s < -1 ? -1 : s > 1 ? 1 : s
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff
      if (this.n === CHUNK) {
        this.post(this.buf)
        this.buf = new Int16Array(CHUNK)
        this.n = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-capture', PcmCapture)
