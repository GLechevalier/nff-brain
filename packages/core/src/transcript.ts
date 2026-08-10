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
  const parts: string[] = [];
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
    if (role !== 'user' && role !== 'assistant') continue;
    const text = textOf(parsed.message?.content).trim();
    if (!text) continue;
    // Hook/system payloads inside user turns are noise, not conversation.
    if (text.startsWith('<') && text.includes('system-reminder')) continue;
    parts.push(`[${role}] ${text}`);
  }
  const joined = parts.join('\n');
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
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
