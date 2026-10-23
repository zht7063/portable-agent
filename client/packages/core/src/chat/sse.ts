/** Incremental SSE parser: feed text chunks, get `data:` payloads (joined per event). */
export class SseParser {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let idx: number;
    while ((idx = this.buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      const data = raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
      if (data.length) out.push(data.join('\n'));
    }
    return out;
  }
  flush(): string[] { const rest = this.buf; this.buf = ''; return rest.trim() ? this.push(rest + '\n\n') : []; }
}
