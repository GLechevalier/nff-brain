import * as fs from 'node:fs';

// Claude Code session transcripts are JSONL. Each line is an event; the shapes
// drift across versions, so parse tolerantly: keep user text and assistant text
// blocks, skip tool calls/results, and tail-cap the result (the end of a session
// carries the conclusions worth distilling).

interface ContentBlock {
  type?: string;
  text?: string;
}

interface TranscriptLine {
  type?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
}

function textOf(content: string | ContentBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

/** Extract "[user] …" / "[assistant] …" lines from a transcript, tail-capped. */
export function readTranscript(filePath: string, maxChars = 12_000): string {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
  const joined = conversationLines(raw.split('\n')).join('\n');
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}

/**
 * Read bounded byte windows from both ends of a file. Transcripts run to
 * several MB and the importer holds four open at once, so `readFileSync` would
 * cost tens of MB resident to yield ~12 KB of useful text.
 *
 * The window boundaries land mid-line, so the head's last line and the tail's
 * first line are dropped as partial. Returns `null` if the file can't be read.
 */
function readEnds(
  filePath: string,
  headBytes: number,
  tailBytes: number,
): { head: string[]; tail: string[] } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;

    // Small enough to read whole — no partial lines, no tail window.
    if (size <= headBytes + tailBytes) {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      return { head: buf.toString('utf8').split('\n'), tail: [] };
    }

    const headBuf = Buffer.alloc(headBytes);
    fs.readSync(fd, headBuf, 0, headBytes, 0);
    const tailBuf = Buffer.alloc(tailBytes);
    fs.readSync(fd, tailBuf, 0, tailBytes, size - tailBytes);

    const head = headBuf.toString('utf8').split('\n');
    head.pop(); // truncated by the window
    const tail = tailBuf.toString('utf8').split('\n');
    tail.shift(); // started mid-line
    return { head, tail };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

function conversationLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(t) as TranscriptLine;
    } catch {
      continue;
    }
    const role = parsed.message?.role ?? parsed.type;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = textOf(parsed.message?.content).trim();
    if (!text) continue;
    if (text.startsWith('<') && text.includes('system-reminder')) continue;
    out.push(`[${role}] ${text}`);
  }
  return out;
}

export interface TranscriptWindowOptions {
  headChars?: number;
  tailChars?: number;
  headBytes?: number;
  tailBytes?: number;
}

/**
 * Like `readTranscript`, but keeps BOTH ends of the session.
 *
 * `readTranscript` is tail-capped, which is right for distilling a session you
 * just watched: the conclusions are at the end. It is wrong for mining an old
 * session — architectural decisions and stated preferences ("we use tsup, never
 * rollup") land in the FIRST prompt, while the lessons land in the last. Keeping
 * only the tail loses exactly the two kinds the importer most wants.
 */
export function readTranscriptWindow(filePath: string, opts: TranscriptWindowOptions = {}): string {
  const headChars = opts.headChars ?? 4_000;
  const tailChars = opts.tailChars ?? 8_000;
  const ends = readEnds(filePath, opts.headBytes ?? 512 * 1024, opts.tailBytes ?? 1024 * 1024);
  if (!ends) return '';

  const headAll = conversationLines(ends.head);
  const tailAll = conversationLines(ends.tail);

  // Take from the front of the head and the BACK of the tail.
  const head: string[] = [];
  let headLen = 0;
  for (const l of headAll) {
    if (headLen + l.length > headChars) break;
    head.push(l);
    headLen += l.length + 1;
  }
  const tail: string[] = [];
  let tailLen = 0;
  for (let i = tailAll.length - 1; i >= 0; i--) {
    const l = tailAll[i];
    if (tailLen + l.length > tailChars) break;
    tail.unshift(l);
    tailLen += l.length + 1;
  }

  // Whole file fit in the head window: `tail` is empty and `head` is the lot.
  if (!tailAll.length) {
    // Still honour tailChars by keeping the end when the head cap truncated it.
    if (head.length < headAll.length) {
      const kept: string[] = [];
      let len = 0;
      for (let i = headAll.length - 1; i >= head.length; i--) {
        const l = headAll[i];
        if (len + l.length > tailChars) break;
        kept.unshift(l);
        len += l.length + 1;
      }
      const omitted = headAll.length - head.length - kept.length;
      return [...head, ...(omitted > 0 ? [`… (${omitted} turns omitted) …`] : []), ...kept].join('\n');
    }
    return head.join('\n');
  }

  return [...head, `… (middle of session omitted) …`, ...tail].join('\n');
}

/** First real user message — used as the "task text" for distillation context. */
export function firstUserText(filePath: string, maxChars = 2_000): string {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(t) as TranscriptLine;
    } catch {
      continue;
    }
    const role = parsed.message?.role ?? parsed.type;
    if (role !== 'user') continue;
    const text = textOf(parsed.message?.content).trim();
    if (!text || text.startsWith('<')) continue;
    return text.slice(0, maxChars);
  }
  return '';
}
