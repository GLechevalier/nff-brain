# Web Store submission runbook

The engineering is done when `npm run package -w nff-brain-chrome` produces the
zip; everything below is the (manual) dashboard work.

**Sequencing decision to make at submit time.** The working tree already
carries the recorder surface (`scripting` + github/linkedin optional hosts —
all warning-free, hosts optional). Two valid paths:

- **(a) Cleanest first review:** for the v0.1.0 upload only, strip `scripting`
  and the two site patterns from `manifest.json` (and the matching two tests in
  `manifest.test.ts`), package, submit; restore for the v0.2 recorder update
  with the justifications' v2 section. Recommended if review latency matters.
- **(b) Submit as-is:** all five permissions are install-warning-free and the
  justifications file covers everything including the v2 section. One review,
  slightly more reviewer surface.

## Pre-submit gates (all must pass — do not skip)

- [ ] `npm run typecheck && npm test` green at the repo root.
- [ ] **Local Network Access row of `packages/chrome/README.md` executed and
      its findings recorded there.** Still marked "Not yet run" as of
      2026-08-11 — this is a genuine blocker: if current Chrome requires the
      optional loopback permission, the popup must request it before store
      users can pair at all.
- [ ] Upload the zip as a **draft**; the dashboard's computed permission list
      must be exactly `storage`, `alarms`, `activeTab`, `contextMenus`, with
      one optional host (`http://127.0.0.1/*`).
- [ ] Install the packed build in a clean profile; screenshot the install
      dialog showing **no permission warnings** (keep with the release notes).
- [ ] Full manual checklist in `packages/chrome/README.md` run once on the
      packed build.

## Privacy policy URL

The source of truth is `store/privacy-policy.md` in this repo. Publish it as a
public URL from the repository (user decision 2026-08-11: repo-hosted, not the
landing site) — either:

- GitHub Pages for the nff-brain repo (`Settings → Pages`, serve `/docs` or a
  branch; put a rendered copy of the policy there), or
- the rendered GitHub blob URL of `packages/chrome/store/privacy-policy.md`
  (acceptable to the dashboard; less polished).

**Record the final URL here once live:** `TODO`

## Dashboard steps

1. Developer account: one-time $5 registration fee, verified email.
2. New item → upload `nff-brain-chrome.zip`.
3. Store listing tab ← `store/listing-copy.md` (name, descriptions, category)
   + screenshots per `store/screenshots.md`.
4. Privacy tab ← `store/permission-justifications.md` (per-permission
   paragraphs, single-purpose statement, data-usage certifications) + the
   privacy policy URL above.
5. Distribution: public; EU Digital Services Act trader/non-trader declaration
   (non-trader for a free personal tool, unless circumstances say otherwise).
6. Submit. First reviews of new developer accounts can take days to a couple
   of weeks — this is why item 6 starts now, in parallel with everything else.

## If rejected

Respond with the exact paragraph from `permission-justifications.md` for the
flagged permission. Do **not** widen permissions to placate a generic rejection
— the narrow set IS the case. If the rejection cites minimum functionality,
point to the capture verb + popup management UI (the reason the capture verb
shipped in v0.1 at all).

## After first approval

- Follow `store/post-upload-key.md` (pin the `key` in `manifest.json`).
- Tag the commit that produced the uploaded zip (`chrome-v0.1.0`) — `zip.mjs`
  is byte-reproducible, so tag → archive is auditable.
- Every later upload needs a strictly higher `version` in `manifest.json`,
  bumped in lockstep with `packages/chrome/package.json`.
