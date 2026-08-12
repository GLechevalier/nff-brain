// Maps a successful clickConnect's read fields (name/headline/company) onto
// whatever arguments the user's chosen "add to list" MCP tool actually
// expects. Tool `inputSchema`s vary per server — this one small call per
// successful match is what lets the web agent work with an arbitrary tool
// shape rather than assuming every configured tool looks CRM-shaped.

import { extractJson } from './distill.js';
import { NFF_PROMPT_MARKERS } from './promptMarkers.js';
import type { McpToolDef } from './mcpClient.js';

export function buildToolArgsPrompt(toolDef: McpToolDef, fields: Record<string, string>): string {
  return [
    `${NFF_PROMPT_MARKERS.agentListWrite}.`,
    ``,
    `A web agent just connected with someone on LinkedIn. Map what was read off`,
    `their profile card onto the arguments of the tool below.`,
    ``,
    `TOOL: ${toolDef.name}${toolDef.description ? ` — ${toolDef.description}` : ''}`,
    `INPUT SCHEMA: ${JSON.stringify(toolDef.inputSchema)}`,
    ``,
    `FIELDS READ FROM THE PROFILE CARD:`,
    JSON.stringify(fields),
    ``,
    `Return STRICT JSON only (no prose, no code fence): {"args": {...matching the schema...}}`,
    `Rules:`,
    `- Only include keys the schema actually defines.`,
    `- Never invent a value not derivable from the fields above — omit an optional`,
    `  key you cannot fill rather than guessing.`,
  ].join('\n');
}

function schemaRequired(schema: Record<string, unknown>): string[] {
  const req = schema.required;
  return Array.isArray(req) ? req.filter((k): k is string => typeof k === 'string') : [];
}

function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
  const props = schema.properties;
  return props && typeof props === 'object' ? (props as Record<string, unknown>) : {};
}

/**
 * Tolerant: an args object missing a required key, or carrying a key the
 * schema doesn't define, is dropped (returns null) rather than sent to the
 * tool malformed — the caller records this as a listWriteError and moves on,
 * it must never block the clip write or the run's progression.
 */
export function parseToolArgsResponse(raw: string, toolDef: McpToolDef): Record<string, unknown> | null {
  const doc = extractJson<Record<string, unknown>>(raw);
  const args = doc?.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;

  const known = schemaProperties(toolDef.inputSchema);
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (k in known) filtered[k] = v;
  }

  for (const req of schemaRequired(toolDef.inputSchema)) {
    if (!(req in filtered)) return null;
  }
  return filtered;
}
