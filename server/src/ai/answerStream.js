// The model answers with one JSON object: {"type":"final","answer":"...",...}. While it is being generated this pulls the
// text of the "answer" string out of the partial JSON, decoded, so it can be shown as it is written. A reply that turns out
// to be a tool call has no "answer" and shows nothing.
export class AnswerStream {
  constructor(onText) { this.onText = onText; this.raw = ''; this.pos = -1; this.text = ''; this.done = false; this.tool = false; }

  push(chunk) {
    this.raw += chunk;
    if (this.done || this.tool) return;
    if (this.pos < 0) {
      if (/"type"\s*:\s*"tool"/.test(this.raw)) { this.tool = true; return; }
      const m = /"answer"\s*:\s*"/.exec(this.raw);
      if (!m) return;
      this.pos = m.index + m[0].length;
    }
    let out = '';
    let i = this.pos;
    for (; i < this.raw.length; i += 1) {
      const c = this.raw[i];
      if (c === '"') { this.done = true; i += 1; break; }
      if (c !== '\\') { out += c; continue; }
      const n = this.raw[i + 1];
      if (n === undefined) break;                       // escape split across chunks: wait
      if (n === 'u') {
        const hex = this.raw.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16)); i += 5; continue;
      }
      out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }[n] ?? n; i += 1;
    }
    this.pos = i;
    if (out) { this.text += out; this.onText?.(out); }
  }

  get answer() { return this.text; }
}
