import { useMemo } from 'react';
import { Gitgraph, Orientation, TemplateName, templateExtend, type Branch } from '@gitgraph/react';
import type { ViewCommit, ViewRefs } from '../src/protocol';

// The commit history tab — same @gitgraph/react approach nff-admin's RepoTree
// already proved out for its own git-graph view (see that component's header
// for why: hand-rolled SVG lane/connector math failed three times in a row
// there; a mature library draws lanes/merges, we only decide what to replay).
//
// Unlike nff-admin's replay (which must GUESS branch ownership from GitHub's
// commit/branch listing), our Commit objects already carry the branch they
// were authored on directly — no fork-point inference needed, just walk
// commits oldest-first and fork a new Gitgraph branch off its first parent's
// branch the first time a branch name is seen.

const MAIN_COLOR = '#8a8a8a';
const BRANCH_COLORS = ['#a78bfa', '#22d3ee', '#4ade80', '#fbbf24', '#f472b6', '#fb923c', '#60a5fa', '#f87171'];

export function CommitGraph({
  commits,
  refs,
  onCheckout,
}: {
  commits: ViewCommit[];
  refs: ViewRefs;
  onCheckout: (ref: string) => void;
}) {
  const ordered = useMemo(() => [...commits].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)), [commits]);
  const byId = useMemo(() => new Map(ordered.map((c) => [c.id, c])), [ordered]);
  const tipsBySha = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const [name, headId] of Object.entries(refs.branches)) {
      const list = m.get(headId);
      if (list) list.push(name);
      else m.set(headId, [name]);
    }
    return m;
  }, [refs]);

  const template = useMemo(
    () =>
      templateExtend(TemplateName.Metro, {
        colors: [MAIN_COLOR, ...BRANCH_COLORS],
        branch: { lineWidth: 2, spacing: 16, label: { display: false } },
        commit: {
          // gitgraph-core places each row at a static `spacing * row`, blind to
          // our custom renderMessage foreignObject's real height — must stay
          // comfortably above messageHeight below or rows overlap.
          spacing: 46,
          dot: { size: 5, strokeWidth: 2, strokeColor: 'var(--nb-paper)' },
          message: { display: true }, // gates the whole <Message> element, incl. renderMessage
        },
      }),
    [],
  );

  if (ordered.length === 0) {
    return (
      <div style={{ fontSize: 12, color: 'var(--nb-faint)', textAlign: 'center', lineHeight: 2, padding: 24 }}>
        No commits yet.
        <br />
        Run <b>nff-brain commit</b> in a terminal to start the history.
      </div>
    );
  }

  const messageWidth = 640;
  const messageHeight = 40; // keep below commit.spacing above, with margin

  return (
    <div style={{ overflow: 'auto', height: '100%', padding: 12 }}>
      <Gitgraph options={{ orientation: Orientation.VerticalReverse, template }}>
        {(gitgraph) => {
          const branchApi = new Map<string, Branch>();
          let colorCursor = 0;

          for (const c of ordered) {
            let api = branchApi.get(c.branch);
            if (!api) {
              const parentCommit = c.parents[0] ? byId.get(c.parents[0]) : undefined;
              const parentApi = parentCommit ? branchApi.get(parentCommit.branch) : undefined;
              api = parentApi
                ? parentApi.branch({
                    name: c.branch,
                    style: { color: BRANCH_COLORS[colorCursor++ % BRANCH_COLORS.length] },
                  })
                : gitgraph.branch({ name: c.branch, style: { color: MAIN_COLOR } });
              branchApi.set(c.branch, api);
            }

            const tips = tipsBySha.get(c.id) ?? [];
            const isMerge = c.parents.length > 1;
            const checkoutTarget = tips[0] ?? c.id;

            api.commit({
              hash: c.id,
              subject: c.message,
              renderMessage: () => (
                <foreignObject x={0} y={-messageHeight / 2} width={messageWidth} height={messageHeight}>
                  <div
                    onClick={() => onCheckout(checkoutTarget)}
                    title={`Check out ${checkoutTarget}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      cursor: 'pointer',
                      fontFamily: 'var(--nb-mono)',
                      minWidth: 0,
                    }}
                  >
                    {tips.map((name) => (
                      <span
                        key={name}
                        style={{
                          flexShrink: 0,
                          fontSize: 10,
                          fontWeight: 'bold',
                          border: `1px solid ${name === refs.HEAD ? '#fbbf24' : 'var(--nb-muted)'}`,
                          color: name === refs.HEAD ? '#fbbf24' : 'var(--nb-muted)',
                          padding: '1px 4px',
                        }}
                      >
                        {name === refs.HEAD ? '● ' : '⑂ '}
                        {name}
                      </span>
                    ))}
                    {isMerge && (
                      <span style={{ flexShrink: 0, fontSize: 10, color: 'var(--nb-faint)' }}>merge</span>
                    )}
                    <code style={{ flexShrink: 0, fontSize: 10, color: 'var(--nb-faint)' }}>
                      {c.id.slice(-8)}
                    </code>
                    <span
                      style={{
                        fontSize: 11,
                        color: 'var(--nb-ink)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        minWidth: 0,
                      }}
                      title={c.message}
                    >
                      {c.message}
                    </span>
                    <span style={{ flexShrink: 0, fontSize: 10, color: 'var(--nb-faint)' }}>
                      +{c.nodesAdded}/~{c.nodesModified}/-{c.nodesRemoved} · {c.author}
                    </span>
                  </div>
                </foreignObject>
              ),
            });
          }
        }}
      </Gitgraph>
    </div>
  );
}
