import { describe, expect, it } from 'vitest';
import { buildChatPrompt, cleanChatAnswer } from '../src/index.js';
import type { ChatContextNode, ChatTurn } from '../src/index.js';

const nodes: ChatContextNode[] = [{ id: 'n1', title: 'OAuth callback rule', content: 'loopback only for the callback url' }];

describe('buildChatPrompt', () => {
  it('opens with the registered marker and asks for prose, not JSON', () => {
    const p = buildChatPrompt({ message: 'what did I learn about oauth?', history: [], nodes });
    expect(p.startsWith('You are the brain chat assistant')).toBe(true);
    expect(p).toContain('Answer in plain prose — no JSON');
    expect(p).toContain('what did I learn about oauth?');
  });

  it('includes retrieved node excerpts, index-free (no id ever shown to the model)', () => {
    const p = buildChatPrompt({ message: 'x', history: [], nodes });
    expect(p).toContain('"OAuth callback rule"');
    expect(p).toContain('loopback only for the callback url');
    expect(p).not.toContain('n1');
  });

  it('says so honestly when nothing matched, rather than silently omitting context', () => {
    const p = buildChatPrompt({ message: 'x', history: [], nodes: [] });
    expect(p).toContain('no notes in the brain matched');
  });

  it('includes recent conversation history, oldest capped from the front', () => {
    const history: ChatTurn[] = Array.from({ length: 10 }, (_, i) => ({ role: 'user', text: `turn ${i}` }));
    const p = buildChatPrompt({ message: 'x', history, nodes: [] });
    expect(p).not.toContain('turn 0'); // capped at the most recent 6
    expect(p).toContain('turn 9');
  });

  it('clamps an overlong message', () => {
    const p = buildChatPrompt({ message: 'x'.repeat(5000), history: [], nodes: [] });
    expect(p.length).toBeLessThan(6000);
  });
});

describe('cleanChatAnswer', () => {
  it('trims whitespace', () => {
    expect(cleanChatAnswer('  hello  \n')).toBe('hello');
  });

  it('caps an overlong answer', () => {
    expect(cleanChatAnswer('y'.repeat(10_000)).length).toBeLessThanOrEqual(4000);
  });

  it('unwraps fenced code blocks, keeping the body', () => {
    expect(cleanChatAnswer('before\n```ts\nconst x = 1;\n```\nafter')).toBe('before\nconst x = 1;\nafter');
  });

  it('converts leading bullet markers to a plain bullet', () => {
    expect(cleanChatAnswer('- one\n* two\n  - nested')).toBe('• one\n• two\n  • nested');
  });

  it('strips header hashes', () => {
    expect(cleanChatAnswer('# Title\n## Subtitle\ntext')).toBe('Title\nSubtitle\ntext');
  });

  it('unwraps bold and italic emphasis', () => {
    expect(cleanChatAnswer('**bold** and *italic* and __also bold__ and _also italic_')).toBe(
      'bold and italic and also bold and also italic',
    );
  });

  it('unwraps inline code, keeping the content', () => {
    expect(cleanChatAnswer('run `npm test` first')).toBe('run npm test first');
  });

  it('keeps only the label from a markdown link', () => {
    expect(cleanChatAnswer('see [the docs](https://example.com/docs) for more')).toBe('see the docs for more');
  });

  it('strips a mix of markdown in one answer', () => {
    const raw = '# Notes\n- **OAuth** uses `PKCE`\n- see [the rule](https://example.com)\n\n```js\nconst y = 2;\n```';
    expect(cleanChatAnswer(raw)).toBe('Notes\n• OAuth uses PKCE\n• see the rule\n\nconst y = 2;');
  });
});
