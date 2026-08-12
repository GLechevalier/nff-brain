# Screenshot checklist

Format: **1280×800 PNG** (Chrome also accepts 640×400 — use 1280×800). 3–5
shots. Rule: **no personal data visible in any shot** — use a scratch profile,
a demo workspace, and neutral page content (public documentation pages).

| # | Shot | How |
|---|---|---|
| 1 | Popup, connected: green dot, node counts, allowlist with one domain, capture ON | `nff-brain serve` running beside a paired popup; crop the browser chrome to a clean frame |
| 2 | The verb: right-click over selected text on a documentation page showing **Remember this** / **Remember this link** / **Remember this page** | Any public docs page (e.g. MDN); select a paragraph first |
| 3 | The payoff: a Claude Code session whose recall preamble shows a `[clip]` line citing the captured fact with its source host | Terminal screenshot after a session start in a workspace with the drained clip |
| 4 | Allowlist management: adding `*.example.com`, the default-deny hint visible | Popup with the input focused |
| 5 (optional) | Paused state: toggle off, badge in paused colour | Popup + badge visible |

Promo tile (optional but improves listing placement): **440×280 PNG** — icon on
a plain dark background with the one-liner "Local-first memory for Claude
Code".

Store the finished PNGs in `store/assets/` (gitignored if large); they are
uploaded through the dashboard, never packed in the zip.
