// Minimal VT100 screen model for the end-to-end tests: cursor addressing,
// erase screen/line and newline handling; SGR attributes are tracked as the
// colour of each cell (0 = default) so tests can check colours too.
export class Screen {
  constructor(rows = 24, cols = 80) {
    this.rows = rows; this.cols = cols;
    this.clear();
    this.r = 0; this.c = 0; this.fg = 0; this.cursor = true; this.pending = '';
  }
  clear() {
    this.text = Array.from({ length: this.rows }, () => Array(this.cols).fill(' '));
    this.color = Array.from({ length: this.rows }, () => Array(this.cols).fill(0));
  }
  write(s) {
    s = this.pending + s; this.pending = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\x1b') {
        const m = /^\x1b\[(\??)([0-9;]*)([A-Za-z])/.exec(s.slice(i));
        if (!m) { if (s.length - i < 16) { this.pending = s.slice(i); return; } continue; }
        i += m[0].length - 1;
        this.csi(m[1], m[2] === '' ? [] : m[2].split(';').map(Number), m[3]);
      } else if (ch === '\r') this.c = 0;
      else if (ch === '\n') this.r = Math.min(this.rows - 1, this.r + 1);
      else if (ch === '\b') this.c = Math.max(0, this.c - 1);
      else if (ch >= ' ') {
        if (this.c < this.cols) { this.text[this.r][this.c] = ch; this.color[this.r][this.c] = this.fg; }
        this.c++;
      }
    }
  }
  csi(priv, p, f) {
    if (priv) { if (p[0] === 25) this.cursor = f === 'h'; return; }
    if (f === 'H') { this.r = (p[0] || 1) - 1; this.c = (p[1] || 1) - 1; }
    else if (f === 'J' && p[0] === 2) this.clear();
    else if (f === 'K') for (let c = this.c; c < this.cols; c++) { this.text[this.r][c] = ' '; this.color[this.r][c] = 0; }
    else if (f === 'm') for (const v of p.length ? p : [0]) {
      if (v === 0) this.fg = 0; else if (v >= 30 && v <= 37) this.fg = v - 30;
    }
  }
  line(r) { return this.text[r - 1].join('').trimEnd(); }   // 1-based row
  dump() { return this.text.map((l) => l.join('').trimEnd()).join('\n'); }
}
