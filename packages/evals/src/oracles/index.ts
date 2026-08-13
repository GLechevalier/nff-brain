// Assembles the Oracles bundle from whatever credentials exist. Every SDK is
// imported lazily inside its factory; an unconfigured service yields null and
// the runner reports its scenarios as skipped-unconfigured, never failed.
//
// Credentials: packages/evals/.env.evals (loaded by the runner) + .auth/*.json
// minted by the setup scripts. All gitignored; test/secretsGuard.test.ts is
// the tripwire.

import type { WebAgentRun } from '@nff-brain/core';
import { makeCalendarOracle, makeDriveOracle, makeGmailOracle, readGoogleAuth } from './google.js';
import type { LinkedInOracle, NffCrmOracle, NotionOracle, Oracles, SlackOracle } from './types.js';

async function makeSlackOracle(): Promise<SlackOracle | null> {
  const token = process.env.NFF_EVALS_SLACK_BOT_TOKEN;
  if (!token) return null;
  const { WebClient } = await import('@slack/web-api');
  const slack = new WebClient(token);
  return {
    async createChannel(name) {
      try {
        const res = await slack.conversations.create({ name });
        return { id: res.channel?.id ?? '' };
      } catch (err) {
        // name_taken → find and reuse (channels are never deletable, only archived).
        const list = await slack.conversations.list({ types: 'public_channel', limit: 1000 });
        const existing = list.channels?.find((c) => c.name === name);
        if (existing?.id) {
          if (existing.is_archived) await slack.conversations.unarchive({ channel: existing.id }).catch(() => undefined);
          return { id: existing.id };
        }
        throw err;
      }
    },
    async postMessage(channelId, text) {
      const res = await slack.chat.postMessage({ channel: channelId, text });
      return { ts: res.ts ?? '' };
    },
    async history(channelId, limit = 50) {
      const res = await slack.conversations.history({ channel: channelId, limit });
      return (res.messages ?? []).map((m) => m.text ?? '').filter(Boolean);
    },
    async archiveChannel(channelId) {
      await slack.conversations.archive({ channel: channelId }).catch(() => undefined);
    },
  };
}

async function makeNotionOracle(): Promise<NotionOracle | null> {
  const token = process.env.NFF_EVALS_NOTION_TOKEN;
  const dbId = process.env.NFF_EVALS_NOTION_DEALS_DB;
  if (!token || !dbId) return null;
  const { Client } = await import('@notionhq/client');
  const notion = new Client({ auth: token });
  return {
    async createDeal(deal) {
      const page = await notion.pages.create({
        parent: { database_id: dbId },
        properties: {
          // Assumes a Deals database with Name(title)/Stage(select)/Amount(number)/LastActivity(date)
          Name: { title: [{ text: { content: deal.name } }] },
          Stage: { select: { name: deal.stage } },
          Amount: { number: deal.amount },
          ...(deal.lastActivityIso ? { LastActivity: { date: { start: deal.lastActivityIso } } } : {}),
        },
      } as never);
      return { id: (page as { id: string }).id };
    },
    async queryDealNames() {
      const res = (await notion.databases.query({ database_id: dbId } as never)) as {
        results: Array<{ properties?: { Name?: { title?: Array<{ plain_text?: string }> } } }>;
      };
      return res.results
        .map((r) => r.properties?.Name?.title?.map((t) => t.plain_text ?? '').join('') ?? '')
        .filter(Boolean);
    },
    async archivePage(id) {
      await notion.pages.update({ page_id: id, archived: true } as never).catch(() => undefined);
    },
  };
}

function makeNffCrmOracle(): NffCrmOracle | null {
  // Wired against the nff-admin CRM's MCP endpoint in a later wave — the
  // env var reserves the config shape now so .env.evals is stable.
  const url = process.env.NFF_EVALS_NFFCRM_MCP_URL;
  if (!url) return null;
  const notImplemented = (): never => {
    throw new Error('nffcrm oracle: MCP wiring lands with the crm ladder (P3-adapter:nffcrm)');
  };
  return { createContact: notImplemented, findContactByEmail: notImplemented, deleteContact: notImplemented };
}

/** Pure — reads the run history serve kept. Always available. */
export function makeLinkedInOracle(): LinkedInOracle {
  return {
    connectedNames(run: WebAgentRun): string[] {
      return run.history
        .filter((h) => h.verb === 'clickConnect' && h.result?.ok)
        .map((h) => h.result?.fields?.name ?? '')
        .filter(Boolean);
    },
    actionCount(run: WebAgentRun, verb: string): number {
      return run.history.filter((h) => h.verb === verb).length;
    },
  };
}

export async function loadOracles(evalsRoot: string): Promise<Oracles> {
  const googleAuth = readGoogleAuth(evalsRoot);
  return {
    gmail: googleAuth ? await makeGmailOracle(googleAuth) : null,
    calendar: googleAuth ? await makeCalendarOracle(googleAuth) : null,
    drive: googleAuth ? await makeDriveOracle(googleAuth) : null,
    slack: await makeSlackOracle(),
    notion: await makeNotionOracle(),
    nffcrm: makeNffCrmOracle(),
    linkedin: makeLinkedInOracle(),
  };
}
