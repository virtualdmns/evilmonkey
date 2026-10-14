# Phase 2 Notes: Browser Evidence and Investigation Tools

Status: implemented, build verified (see Validation). Live Chrome verification still needed.

## What was built

New background module `violentmonkey/src/background/evm/evidence.js`:
the browser evidence tool service. All tools register through the Phase 1
shared policy gate (`registerTool`/`invokeTool` in `policy.js`); nothing is
wired into the external MCP server path (D9 stays open). No
`chrome.debugger` anywhere (D4).

### Tool inventory (all RISK_READ; reads need no approval beyond session scope)

| Tool | What it does |
|---|---|
| `evidence.capabilities` | Capability discovery for the session target: content injection, frame enumeration, navigation tracking, userscript engine state, plus unavailable and not-yet-instrumented entries with reasons. Also attached to the session-created event as the session start report. |
| `page.snapshot` | Structured DOM inspection via one-shot ISOLATED-world injection. Bounded pre-order walk (5000 nodes, depth 6 default), per-node tag/text/attrs/rect/children, stable index refs (`e0`, `e1`, ...). Paginated with cursors. |
| `page.query` | Selector validation: observed match count plus a 5-element sample of matched nodes. |
| `page.selectors` | Selector proposals for a snapshot ref: id, test-id/aria/name attributes, class, ancestor chain, and full-path fallback candidates, each validated with its observed match count and uniqueness. Re-walks with the identical traversal as the snapshot so refs resolve deterministically. |
| `page.repeated` | Heuristic repeated-item detection: groups a container's children by structural signature, reports groups with 2+ members and sample selectors. Labeled heuristic; callers must verify with `page.query`. |
| `console.read` | Bounded console/error collection from a MAIN-world page collector (console method wrappers, error and unhandledrejection listeners). Sequence cursors (`sinceSeq`), clear support. |
| `page.mutations` | Bounded mutation observation: start/poll/stop actions against a MutationObserver in the MAIN-world collector. Last 100 records, cumulative counts. |
| `network.bodies`, `page.profile`, `page.axtree` | Explicit unsupported stubs. Invoking returns `reason: 'unsupported'` with the D4 rationale, instead of failing obscurely. Registered via a new `unsupported` option on `registerTool` (policy.js). |

### Supporting changes

- `policy.js`: `registerTool` accepts `unsupported: 'reason'`; `invokeTool`
  returns `{ ok: false, reason: 'unsupported', detail }` before any session
  lookup or execution.
- `orchestrator.js`:
  - `EvmSessionCreate` attaches a capability summary
    (available/unavailable/not-instrumented) to the session-created event.
  - Navigation tracking now bumps `target.documentEpoch` on main-frame
    commits AND on `webNavigation.onHistoryStateUpdated` (SPA route
    changes), so evidence refs from the old document fail clearly as
    stale. The url guard prevents double-bumping when both events fire.
  - `target.describe` now reports the document epoch.
- `scripts/manifest-helper.js`: MV3 manifest gains the `scripting`
  permission (normal permission, no install warning). This is the injection
  mechanism the Phase 0 capability matrix names for Phase 2 evidence work;
  it is not the userscript engine and does not change the Chrome 135 floor.
- `src/workspace/views/app.vue`: new Evidence section with Capabilities,
  Snapshot, and Read console buttons rendering gated tool results as JSON,
  for live testing.

## Design choices

- **Injection topology.** DOM work runs in ISOLATED-world one-shot
  injections (return values come straight back to the background).
  Console/error/mutation collection needs the MAIN world (page JS
  context), so a small MAIN-world collector installs once per document
  (idempotent, guarded by a window flag) and talks to per-call ISOLATED
  bridge scripts over `window.postMessage` with tagged request ids.
  Injected functions are serialized with `Function.prototype.toString`,
  so every content-side function is fully self-contained (plain
  `function`/`var`, no module references); shared helpers are
  deliberately duplicated inside each collector.
- **Document epochs.** A monotonically increasing counter per session
  target, bumped on full navigations and SPA route changes. Every tool
  result is stamped with the epoch it was collected against; tools that
  take evidence refs (`page.selectors`, `page.query` with an epoch arg)
  throw a clear `stale-reference` error on mismatch.
- **Refs.** Snapshot element refs are pre-order indexes (`e42`) valid
  for one (tab, frame, epoch). `page.selectors` re-walks with the byte-
  identical traversal to resolve them; a missing index returns
  `ref-not-found` with an explanatory note.
- **Caps.** Console 150 entries, errors 100, mutations 100 records,
  snapshot walk 5000 nodes / 500 per page, console args 500 chars, DOM
  text 200 chars per node, attribute values 300 chars. Buffers are ring
  buffers in the page collector; counts are cumulative where noted.
- **Provenance envelope.** Every tool result carries target tab/frame,
  url, epoch, provenance (`source: evm-evidence`, `collectedAt`,
  `untrusted: true`), warnings, limitations, and a pagination cursor
  (or null). Payloads pass through `redactForProvider` before leaving
  the tool.
- **Untrusted boundary.** Page content is evidence, never instructions:
  enforced by the envelope flag, code comments, the redaction step, and
  the fact that the policy gate never consults page content. A hostile
  page can lie in its DOM or spoof collector replies; the tools report
  what was observed.
- **Known redaction limitation.** Redaction is key-based (cookies,
  tokens, secrets, auth headers) plus truncation. A secret embedded in
  a console message *value* under an innocuous key is not caught. This
  is documented, not silently assumed safe.

## Validation

- `node --check` passed for all new and edited modules.
- `pnpm build:mv3` (production, MV3): passed,
  `webpack 5.111.0 compiled successfully`. Verified in `dist-mv3/`:
  manifest contains the `scripting` permission (and still `sidePanel`);
  `sw.js` contains the evidence tool registrations and epoch logic;
  `workspace/index.js` contains the Evidence section buttons.
  (`dist-mv3/` is generated output and is not committed.)
- `pnpm lint` was not run (not requested per repo AGENTS.md).

## Live Chrome verification still needed

No interactive browser is available in this environment, so these Phase 2
acceptance criteria remain unchecked in the plan:

- Selector candidates include observed match count and validation status;
  stale candidates fail clearly after navigation. Needs: snapshot a page,
  propose selectors for a ref, navigate the tab (full and SPA), re-run
  with the old epoch and confirm the stale-reference failure; confirm
  candidate match counts match the live DOM.
- End-to-end evidence flows. Needs: run Snapshot, Read console, and
  mutations start/poll/stop from the workspace Evidence section on a
  real page; confirm the MAIN-world collector installs, console output
  appears, mutation records arrive, and cursors paginate.
- Capability report on session start. Needs: create a session and confirm
  the session-created event lists available vs unavailable vs
  not-instrumented capabilities; confirm `network.bodies` etc. return
  the explicit unsupported status when invoked.
- Frame targeting. Needs: a page with iframes, snapshot with an explicit
  frameId from the capabilities frame list.
- Injection on restricted pages (chrome://, Chrome Web Store): confirm
  the failure message is clear rather than a hang.

Checked in the plan (verified by code inspection and build):

- [x] A tool result identifies target tab/frame, document epoch,
  provenance, warnings, limitations, and any next-page cursor. The
  `envelope()` function in evidence.js is the single result path for all
  seven tools and always emits every required field; snapshot is the
  only tool with a non-null cursor.
- [x] Page content is treated as untrusted evidence rather than tool
  policy or agent instructions. Every result carries
  `provenance.untrusted: true`, the boundary is stated in code comments,
  payloads are redacted before leaving the tool, and the policy gate
  never reads page content.
- [x] Collection limits and redaction are enforced before evidence
  reaches a provider. Caps are hard-coded in the collectors and the
  snapshot walker; `envelope()` runs `redactForProvider` on every
  payload. (Known limitation above: value-embedded secrets under
  innocuous keys are not caught.)
- [x] The session start report distinguishes available, unavailable, and
  not-yet-instrumented capabilities. `EvmSessionCreate` attaches the
  three-way summary to the session-created event; `getCapabilities`
  computes it live per target.
