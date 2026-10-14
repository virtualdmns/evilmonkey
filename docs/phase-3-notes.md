# Phase 3 Notes: Curse Draft, Bounded Test, and Approval Vertical Slice

Status: implemented, build verified (see Validation). Live Chrome verification still needed for the representative task, assertion reporting, and the demonstrated repair.

## What was built

New background modules in `violentmonkey/src/background/evm/`:

- `curse.js` — candidate Curse model and static analyses. `createCandidate`
  wraps the Phase 1 revision identity (SHA-256 of code plus normalized
  metadata) and adds assertions, an optional parent revision link, an
  optional repair context (failed assertion evidence), test reports, and
  the install record. `scoreAssertion` maps observed page facts to
  PASS/FAIL/INCONCLUSIVE; `markNotRun` covers epoch-changed skips.
  `lineDiff` is a minimal line diff for the approval UI (labeled as
  such). `parseMetablock` reads a `==UserScript==` block to cross-check
  `@require`/`@resource` declarations. `scanExternalDestinations` is a
  heuristic static scan for fetch/XHR/WebSocket/absolute URLs, labeled
  heuristic in the UI. `buildInstallSource` prepends a generated metadata
  block when the candidate code does not carry one.
- `runner.js` — the bounded test runner. Lifecycle per run: verify
  explicit test authorization (separate map from install approvals),
  register a temporary userscript (`evm-test-*` id, metadata matches or
  session-origin default, metadata runAt/allFrames passthrough),
  execute immediately in the current document via
  `chrome.userScripts.execute`, evaluate assertions in the same
  USER_SCRIPT world, epoch-guard each assertion (NOT_RUN on navigation),
  unregister, and verify absence via `chrome.userScripts.getScripts`.
  Assertion kinds: `selector-hidden`, `selector-count`,
  `selector-visible`, `selector-text`, `js-eval` (bounded snippet via
  `new Function` in the USER_SCRIPT world, whose baseline CSP allows
  unsafe-eval; failures degrade to INCONCLUSIVE). Every test report
  carries the D5 matrix, irreversible-effects accounting, limitations,
  and warnings. Two gate tools: `curse.test` (RISK_WRITE; enforces the
  explicit per-revision test authorization inside invoke, so no backend
  can run a candidate without it) and `curse.draft` (RISK_WRITE;
  creates a candidate through the gate for future backends).
- `models.js` — session gains `candidates: {}` and `testApprovals: {}`.
  Test approvals are recorded separately from `revisionApprovals`
  (install): authorizing a test run never implies install approval.
- `orchestrator.js` — new own-commands: `EvmCandidateCreate` (with
  parent link and repair context), `EvmCandidateList`,
  `EvmCandidateGet` (code or diff vs parent, metadata, grants,
  matches, heuristic external destinations, assertions with latest
  results, test reports, both authorization states),
  `EvmTestAuthorize`, and `EvmCurseInstall`. Install goes through the
  baseline script store (`parseScript` from `../utils/db`) but only
  after `checkInstallApproval` passes in code, not just in the UI:
  without an approval bound to the exact displayed revision id,
  `EvmCurseInstall` throws `install-refused`.

Workspace UI (`violentmonkey/src/workspace/`):

- New "Curse (Phase 3)" section in `views/app.vue`: candidate form
  (code, name, matches, grants, run-at, assertions JSON), candidate
  list, candidate detail (metadata, grants, matches, external
  destinations, code or parent diff, assertions with evidence,
  test reports with fidelity matrix and irreversible-effects panels),
  and the full action chain: Authorize test run, Run test, Approve
  install, Install, Revise from failure. The detail always shows the
  test-authorized and install-approved states, plus a standing
  fidelity-unverified banner. `style.css` gains `.ws-input` and
  `.ws-scroll`.

Untouched, as required: `src/background/utils/mcp.js` (D9 stays open;
nothing is wired into the external MCP server path), `debugger`
(D4), and all userscript engine code.

## Design choices

- **Test authorization vs install approval.** Two separate maps on the
  session (`testApprovals`, `revisionApprovals`), two separate commands
  (`EvmTestAuthorize`, `EvmSessionApproveRevision`), two separate UI
  buttons. The `curse.test` tool additionally re-checks test
  authorization inside its invoke, so the gate's risk decision and the
  explicit authorization are both required.
- **Observation world.** Assertions evaluate in the USER_SCRIPT world
  via `chrome.userScripts.execute`, the same world the candidate ran
  in, rather than ISOLATED. Rationale: the observation should see what
  the candidate saw. The Phase 2 evidence tools stay ISOLATED; the two
  are not mixed.
- **No GM shims.** The runner does not fake GM APIs for the test. A
  candidate calling `GM_*` throws during the bounded run and the
  assertion degrades to INCONCLUSIVE with the error as evidence. This
  is the honest D5 behavior: the matrix says unverified, the runner
  shows it.
- **Revision cycle mechanism.** `EvmCandidateCreate` accepts
  `parentRevisionId` and `repairContext` (failed assertion ids plus
  their evidence and conditions). The UI's "Revise from failure"
  prefills the form from the latest failed assertions. The agent-side
  repair authoring arrives in later phases; Phase 3 provides the data
  flow: fail -> evidence attached -> new revision -> re-test.
- **Install is real.** `EvmCurseInstall` produces a genuine persistent
  userscript via the baseline `parseScript` (metadata block generated
  from the candidate when absent), enabled on install, no tab reload.
  The candidate records the resulting script id.

## D5 verification matrix status

The runner's `checkFidelity` reports per run. Current standing:

| Dimension | Status | Basis |
|---|---|---|
| GM APIs | unverified | No GM bindings in temporary execution; demonstrated only by comparing test vs install behavior live. |
| `@require` | unverified | Runner does not load `@require`; metablock parse warns when declared. |
| `@resource` | unverified | No resource resolution in the runner. |
| Grants | unverified | Raw registration does not enforce the grant set; recorded but not proven. |
| Run timing | unverified | Immediate execute plus registered runAt; timing equivalence not demonstrated. |
| Frames | unverified | Main-frame execution; allFrames passed through but not demonstrated. |
| Cleanup | verified (per run) | Unregister plus `getScripts` absence check, reported in the lifecycle block. |
| Navigation | unverified | Bounded run does not exercise reload/SPA behavior. |

Overall fidelity is `unverified` until every applicable dimension
passes. Test reports and the workspace UI label this on every run.

## Reload, cleanup, and irreversible effects (criterion 5)

- **Reload.** Reloading the page after a test does not re-run the
  candidate: the temporary registration is removed at test end, so
  there is nothing for the engine to fire on the new document. DOM
  changes the candidate already made persist until that reload.
- **Cleanup.** The runner unregisters the temporary id and confirms
  absence with `getScripts`; the lifecycle block reports each step.
  If unregister or verification fails, the report warns instead of
  claiming success.
- **Irreversible.** Every report lists what was cleaned up and what
  cannot be reverted: page DOM mutations persist until reload, and
  network requests, downloads, and server-side changes cannot be
  rolled back. Candidate-declared `sideEffects` metadata is shown
  alongside.

## Validation

- `node --check` passes on `curse.js`, `runner.js`, and the edited
  `models.js`/`orchestrator.js`.
- `pnpm build:mv3` (Node 24, pnpm 12.4.2) compiles cleanly;
  `dist-mv3/workspace/index.js` contains the new Curse UI strings,
  `sw.js` contains the new Evm commands and the `curse.test` /
  `curse.draft` registrations, and the manifest is unchanged from
  Phase 2 (no new permissions).
- Live Chrome testing was not possible from the build environment.
  The owner live-tests on his machine.

## Live-test procedure (for the unchecked criteria)

1. Load the unpacked `dist-mv3` build, open the side panel workspace,
   create a session on a feed-style page (e.g. a social timeline with
   sponsored cards).
2. New candidate: code that hides sponsored cards
   (`document.querySelectorAll('[data-ad], .sponsored').forEach(...)`
   or similar for the page), matches for the page origin, assertions:
   `selector-hidden` on the sponsored selector, `selector-count` gte 1
   on ordinary cards (guards against hiding everything),
   `selector-visible` on ordinary cards.
3. Authorize test run, then Run test. Check each assertion shows
   PASS/FAIL/NOT_RUN/INCONCLUSIVE with evidence and conditions
   (criterion 2).
4. While a test runs, add a dynamic card (scroll the feed) and confirm
   the mutation path is exercised; check duplicate-observer behavior
   by running the test twice and comparing assertion evidence
   (criterion 1).
5. Break the candidate deliberately (wrong selector), re-run, confirm
   FAIL with evidence, then use Revise from failure, fix the selector,
   create the revision, re-run, and confirm the repair (criterion 3).
6. Without approving install, attempt Install and confirm refusal;
   approve the exact revision, edit the code (new revision id),
   and confirm the old approval no longer installs (criterion 4,
   also verified by code inspection of `EvmCurseInstall`).

## Acceptance criteria mapping

- Representative task (sponsored cards, ordinary cards, dynamic
  additions, duplicate observers): unchecked, needs live browser
  (procedure above, steps 2 and 4).
- Assertion statuses with evidence and conditions: unchecked, needs
  a live run (procedure step 3). The mechanism (four statuses,
  evidence, conditions on every evaluated assertion) is implemented.
- Failed assertion feeds a revision cycle with a demonstrated repair:
  unchecked, needs live browser (procedure step 5). The data flow
  (parent link, repair context with failed assertion evidence) is
  implemented.
- Installation impossible without approval of the displayed revision
  and permissions: CHECKED. `EvmCurseInstall` calls
  `checkInstallApproval` in code and throws `install-refused`
  otherwise; the UI additionally disables the button. Verified by
  inspection, no browser needed.
- Reload, cleanup, and irreversible effects explained accurately:
  CHECKED. The semantics above are implemented in the runner
  (verified cleanup, explicit non-revert list) and stated in the UI
  copy and this doc.
