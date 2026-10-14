# Phase 1 Notes: Chrome Workspace and Shared Session Foundation

Status: implemented, build verified (see Validation). Live Chrome verification still needed.

## What was built

New background modules in `violentmonkey/src/background/evm/`:

- `models.js` — session, target, event, evidence-reference, artifact, and
  candidate-revision factories. Candidate revision identity is the SHA-256 of
  code plus normalized metadata, so any edit invalidates prior approvals
  (exact-revision install binding). No Chrome API usage; pure data.
- `store.js` — two-tier persistence per D6. Ephemeral tier is
  `chrome.storage.session` (MV3; memory shim otherwise) for live session
  records, budgets, stop flags, and in-flight operations. Durable tier is
  `browser.storage.local` under the `evm:` prefix for the session index,
  checkpoints, and event tails. Never persists tokens, credentials, provider
  keys, live handles, or raw page content.
- `redact.js` — shared redaction: sensitive keys (cookies, authorization,
  tokens, secrets, passwords, API keys) replaced, long strings truncated,
  depth and key counts bounded.
- `policy.js` — the shared policy gate. Single choke point: `registerTool`
  plus `invokeTool`. Enforces active session, selected-tab scope, origin
  change re-approval (compared against the origin at session start, so
  navigation cannot silently re-scope), risk levels (read/write allowed with
  redaction; destructive/privileged require approval), redaction, and
  exact-revision install approval. Backend-neutral: knows nothing about MCP,
  Claude Code, or Codex. Per D9, no new tools are wired into the external MCP
  server path; the D9 registration decision stays open.
- `orchestrator.js` — session lifecycle as background own-commands
  (extension pages only): `EvmSessionCreate` (defaults to the selected tab),
  `EvmSessionList`, `EvmSessionGet` (with recovery state), `EvmSessionCheckpoint`,
  `EvmSessionStop` (returns a recall report distinguishing cancelled
  operations from effects that could not be recalled),
  `EvmSessionApproveRevision`, `EvmSessionCheckInstall`, and `EvmToolInvoke`
  (routes through the policy gate). Budgets (steps, events, elapsed time)
  fail the session when exceeded. Target navigation is tracked via
  `webNavigation.onCommitted` (falls back to `tabs.onUpdated`); origin
  changes flag the target and arm re-approval. Startup reconciliation marks
  sessions lost to browser restart as `interrupted` with `recoverable` or
  `unrecoverable` recovery state.
- `index.js` — wires the modules into the background page; imported by
  `src/background/index.js`.

New UI in `violentmonkey/src/workspace/`:

- `index.js`, `views/app.vue`, `style.css` — side panel workspace page built
  with the existing Vue 3 / webpack page conventions (added to the `pages`
  list in `scripts/webpack-base.js`, which generates `workspace/index.html`).
  Lists sessions, shows detail (status, target, origin-change warnings,
  budget, events), and offers New session, Checkpoint, Stop (with recall
  report), and a gated target-describe tool call. User-visible strings are
  English for now; full localization is deferred.

Popup entry point:

- `src/popup/views/app.vue` — workspace button (code icon) in the
  menu-buttons row, shown on Chrome MV3 only. Click handler calls
  `chrome.sidePanel.open({ windowId })` directly in the gesture (U3) and
  closes the popup. Falls back to a message when the API is unavailable.
- `_locales/en/messages.yml` — new `menuWorkspace` key.

Manifest and build:

- `scripts/manifest-helper.js` — MV3 manifest gains the `sidePanel`
  permission and `side_panel: { default_path: 'workspace/index.html' }`.
  No other permissions changed; `debugger` stays out per D4.
- `scripts/webpack-base.js` — `workspace` added to the page list.

Untouched, as required: `src/background/utils/mcp.js` (MCP settings
approval and explicit disconnect flow unchanged), all userscript engine,
storage, and GM API code.

## Design choices

- U8 storage split: ephemeral (`chrome.storage.session`) holds exactly what
  must not survive browser exit but must survive worker restarts: live
  session records, budget counters, stop flags, in-flight ops. Durable
  (`browser.storage.local`, `evm:` prefix) holds the session index, up to 20
  checkpoints per session, and the last 100 events per session. Sessions older
  than 30 days and indexes beyond 50 entries are pruned. Nothing sensitive is
  persisted, ever.
- U3 `sidePanel.open` gesture handling: the call happens synchronously in
  the popup button click handler, which satisfies the user-gesture
  requirement. Programmatic open from non-gesture contexts is not attempted.
- Policy gate placement: `invokeTool` in `policy.js` is the only path from a
  tool name to its implementation. The orchestrator's `EvmToolInvoke`
  command and the workspace UI both go through it; future embedded backends
  and (once D9 is decided) any MCP exposure must do the same. Structural
  guarantee, verified by code inspection.
- Origin re-approval compares against `originAtStart`, recorded at session
  creation, so mid-session navigation cannot silently widen scope.

## Validation

- `node --check` syntax validation passed for all new modules and edited
  build scripts.
- `pnpm build:mv3` (production, MV3): passed. `webpack 5.111.0 compiled
  successfully` for all chunks. Verified in `dist-mv3/`: `workspace/index.html`,
  `workspace/index.js`, `workspace/index.css` emitted; manifest contains the
  `sidePanel` permission and `side_panel.default_path: workspace/index.html`;
  `sw.js` contains the EVM session commands; `popup/index.js` contains the
  side panel open handler. (`dist-mv3/` is generated output and is not
  committed.)
- `pnpm lint` was not run (not requested per repo AGENTS.md).

## Live Chrome verification still needed

No interactive browser is available in this environment, so the following
Phase 1 acceptance criteria could not be exercised and remain unchecked in
the plan:

- Workspace surviving popup closure and worker suspension, with
  recoverable/unrecoverable states shown correctly. Needs: open panel, start
  session, kill the worker via `chrome://serviceworker-internals`, confirm
  the session resumes; restart the browser, confirm interrupted sessions
  report the right recovery state.
- Session scope defaulting to the selected tab and reporting navigation or
  target changes. Needs: create session, switch tabs, confirm the gate
  denies cross-tab calls; navigate the target tab cross-origin, confirm the
  re-approval requirement fires.
- Stop behavior and the recall report. Needs: stop a session mid-task and
  confirm the report lists cancelled vs non-recallable operations.
- Existing script management working without an agent backend. Needs:
  install/enable/disable a userscript with no backend configured; confirm
  the MCP settings pairing flow is unchanged.
- `chrome.sidePanel.open` gesture behavior across Chrome versions (U3
  follow-up) and the "Allow User Scripts" / workspace page load path.

Checked in the plan (verified without a live browser):

- [x] No agent or browser tool can bypass the shared policy gate.
  Verified by code inspection: `invokeTool` is the single registration and
  dispatch point, both commands and the workspace UI route through it, no
  new tools were added to the MCP server path, and `mcp.js` is untouched.
