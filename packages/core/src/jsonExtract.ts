// Tolerant JSON extraction: strip prose / code fences, take the outermost
// object. Every LLM JSON contract in the codebase funnels through this, so it
// lives alone as a browser-safe subpath export (the Chrome extension's
// standalone drain parses provider output with the same tolerance the CLI
// applies to `claude -p`). distill.ts re-exports it for node callers.

export function extractJson<T>(text: string): T | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
