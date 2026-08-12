import { describe, expect, it } from 'vitest';
import { buildToolArgsPrompt, parseToolArgsResponse } from '../src/index.js';
import type { McpToolDef } from '../src/index.js';

const crmTool: McpToolDef = {
  name: 'crm_create_contact',
  description: 'Create a CRM contact',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' }, role: { type: 'string' }, company_name: { type: 'string' } },
    required: ['name'],
  },
};

describe('buildToolArgsPrompt', () => {
  it('opens with the registered marker and includes the tool name and fields', () => {
    const p = buildToolArgsPrompt(crmTool, { name: 'Ada Lovelace', headline: 'Robotics Engineer at Acme' });
    expect(p.startsWith("You are the web agent's list-write field mapper")).toBe(true);
    expect(p).toContain('crm_create_contact');
    expect(p).toContain('Ada Lovelace');
  });
});

describe('parseToolArgsResponse', () => {
  it('accepts args that satisfy every required key', () => {
    const args = parseToolArgsResponse(
      JSON.stringify({ args: { name: 'Ada Lovelace', role: 'Robotics Engineer' } }),
      crmTool,
    );
    expect(args).toEqual({ name: 'Ada Lovelace', role: 'Robotics Engineer' });
  });

  it('drops keys the schema does not define, rather than sending them malformed', () => {
    const args = parseToolArgsResponse(JSON.stringify({ args: { name: 'Ada Lovelace', made_up_key: 'x' } }), crmTool);
    expect(args).toEqual({ name: 'Ada Lovelace' });
  });

  it('returns null when a required key is missing — never sent malformed', () => {
    expect(parseToolArgsResponse(JSON.stringify({ args: { role: 'Robotics Engineer' } }), crmTool)).toBeNull();
  });

  it('returns null on unparseable input', () => {
    expect(parseToolArgsResponse('total garbage', crmTool)).toBeNull();
    expect(parseToolArgsResponse(JSON.stringify({ args: 'not an object' }), crmTool)).toBeNull();
  });
});
