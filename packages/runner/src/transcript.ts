/**
 * Trial transcripts.
 *
 * One JSONL file per trial at
 *   results/<runId>/<taskId>/<configId>/<docs>/trial-<n>/transcript.jsonl
 *
 * Each record is `{"t":<ms since trial start>,"s":"out"|"err"|"meta","raw":"<line>"}`.
 * Storing the RAW line (rather than a pre-parsed object) is deliberate: agent CLI
 * JSON shapes drift between releases, and PLAN.md commits to publishing all
 * trajectories. Re-parsing later must be possible without re-running anything.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type TranscriptStream = 'out' | 'err' | 'meta';

export interface TranscriptRecord {
  /** Milliseconds since trial start. */
  t: number;
  s: TranscriptStream;
  /** Raw line, verbatim and lossless, for 'out' / 'err'. */
  raw?: string;
  /** For 's':'meta' records: 'start' | 'end' | 'note'. */
  event?: string;
  [k: string]: unknown;
}

export class TranscriptWriter {
  readonly filePath: string;
  private stream: WriteStream | undefined;
  private readonly t0: number;
  private closed = false;

  constructor(filePath: string, t0: number = Date.now()) {
    this.filePath = filePath;
    this.t0 = t0;
  }

  async open(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    this.stream = createWriteStream(this.filePath, { flags: 'w' });
    await new Promise<void>((resolve, reject) => {
      this.stream!.once('open', () => resolve());
      this.stream!.once('error', reject);
    });
  }

  write(record: Omit<TranscriptRecord, 't'> & { t?: number }): void {
    if (this.closed || !this.stream) return;
    const rec: TranscriptRecord = { t: record.t ?? Date.now() - this.t0, ...record } as TranscriptRecord;
    this.stream.write(`${JSON.stringify(rec)}\n`);
  }

  line(s: 'out' | 'err', raw: string): void {
    this.write({ s, raw });
  }

  async close(): Promise<void> {
    if (this.closed || !this.stream) return;
    this.closed = true;
    const stream = this.stream;
    await new Promise<void>((resolve) => stream.end(resolve));
  }
}

export interface ReadTranscript {
  records: TranscriptRecord[];
  stdoutLines: string[];
  stderrLines: string[];
  meta: TranscriptRecord[];
  /** Lines that were not valid JSON records (corruption / partial write). */
  malformed: number;
}

export async function readTranscript(filePath: string): Promise<ReadTranscript> {
  const text = await readFile(filePath, 'utf8');
  return parseTranscript(text);
}

export function parseTranscript(text: string): ReadTranscript {
  const out: ReadTranscript = {
    records: [],
    stdoutLines: [],
    stderrLines: [],
    meta: [],
    malformed: 0,
  };
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    let rec: TranscriptRecord;
    try {
      rec = JSON.parse(line) as TranscriptRecord;
    } catch {
      out.malformed++;
      continue;
    }
    out.records.push(rec);
    if (rec.s === 'out' && typeof rec.raw === 'string') out.stdoutLines.push(rec.raw);
    else if (rec.s === 'err' && typeof rec.raw === 'string') out.stderrLines.push(rec.raw);
    else if (rec.s === 'meta') out.meta.push(rec);
  }
  return out;
}

/**
 * Splits a byte stream into complete lines, holding partial trailing data until the
 * next chunk. `flush()` emits whatever is left when the stream ends.
 */
export class LineSplitter {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    if (!this.buffer.includes('\n')) return [];
    const parts = this.buffer.split('\n');
    this.buffer = parts.pop() ?? '';
    return parts.map(stripCr);
  }

  flush(): string[] {
    if (this.buffer.length === 0) return [];
    const rest = this.buffer;
    this.buffer = '';
    return [stripCr(rest)];
  }
}

function stripCr(s: string): string {
  return s.endsWith('\r') ? s.slice(0, -1) : s;
}
