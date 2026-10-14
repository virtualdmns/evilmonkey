# EvilMonkey — Product and Implementation Specification

Version: 0.1
Status: Implementation brief for Claude Code, OpenAI Codex, and human developers

## 1. Product

EvilMonkey is a Violentmonkey fork with a built-in AI agent that investigates live websites, writes userscripts, tests them, and iterates until the requested enhancement works.

Userscripts are branded as **Curses**.

Tagline: **Cast Curses on the web.**

The product is not a screenshot-to-JavaScript chatbot. Agents must obtain actual browser evidence and verify their changes.

Example requests:
- Hide sponsored posts, including dynamically loaded posts.
- Automatically expand comments.
- Add download buttons where the underlying media supports downloading.
- Add download buttons/functionality where the host doesnt support downloading.
- Add sorting, filtering, shortcuts, or layout controls.
- Repair an existing Curse after a site changes.

## 2. Non-negotiable implementation direction

1. Fork and extend Violentmonkey. Preserve its userscript engine and supported GM APIs.
2. Reuse upstream AI Agent Access and `@violentmonkey/mcp` rather than designing a replacement MCP bridge.
3. Support Claude Code and OpenAI Codex first, then direct Anthropic and OpenAI API integrations.
4. Provide agent interaction inside the extension, not only through an external terminal.
5. Give agents deep, structured browser investigation and interaction tools.
6. Test generated Curses against the live page and report evidence, not unverified success.
7. Keep existing userscript-management features usable without an AI connection.
8. Inspect source and current official integration documentation before selecting SDKs, commands, or transport implementations. Do not invent upstream APIs or unsupported client capabilities.

## 3. Existing upstream foundation

The user-provided upstream AI Agent Access documentation describes:
- `@violentmonkey/mcp` for direct agent management of userscripts.
- Stdio and HTTP transport modes.
- Token-based connection and approval in extension settings.
- Listing, creating, editing, and fixing scripts through an agent.
- Connection settings and explicit disconnection.
- An in-memory connection lifecycle that requires reconnecting after browser restart.

Documented setup examples:

```sh
claude mcp add violentmonkey -- npx -y @violentmonkey/mcp -p 5678
```

```json
{
  "mcpServers": {
    "violentmonkey": {
      "command": "npx",
      "args": ["-y", "@violentmonkey/mcp", "-p", "5678"]
    }
  }
}
```

Documented connection URL shape:

```text
https://violentmonkey.github.io/mcp_connect.html?port=5678&token=<generated_token>
```

Documented HTTP server example:

```sh
VM_MCP_TOKEN=secret npx -y @violentmonkey/mcp -p 5678 --transport http
```

These examples describe upstream behavior, not a final EvilMonkey namespace or packaging decision. Verify the selected upstream revision before implementation. Do not silently change the connection URL or token lifecycle without adapting both sides.

### Required first deliverable: source-backed gap analysis

Inspect the extension and MCP server source and classify each feature as:
- Already implemented upstream.
- Implemented but requiring extension.
- New functionality.

Inventory script tools, schemas, message routing, connection approval, token handling, persistence, injection, GM APIs, and current browser support. Record the exact upstream commit used.

Do not build a second pairing system or userscript CRUD layer merely because this specification describes their responsibilities.

## 4. Agent backends and implementation priority

### Priority 1 — Claude Code

Users must be able to:
- Connect an existing Claude Code workflow to EvilMonkey through upstream MCP integration.
- Submit a task from the extension UI to a locally running Claude Code-backed session.
- See progress, tool activity, questions, results, and cancellation in the extension.
- Use their supported Claude Code authentication workflow; do not require a separate API key merely to use this backend.

### Priority 2 — OpenAI Codex

Provide equivalent external-agent and embedded-session workflows for OpenAI Codex.
- Support the user's installed Codex workflow and its supported authentication mechanism.
- Configure MCP using the current documented Codex mechanism, not a guessed Claude-compatible configuration.
- Preserve progress, questions, tool activity, cancellation, and session recovery in the extension UI.

### Priority 3 — Anthropic API

Provide a direct API-backed agent adapter with user-supplied credentials and model selection. API usage and billing must be clearly distinguished from Claude Code access.

### Priority 4 — OpenAI API

Provide equivalent direct API integration, clearly distinguished from Codex access and billing.

### Important distinction

An external agent consuming EvilMonkey's MCP tools is not the same thing as the extension launching or messaging that agent. Both workflows are required.

MCP supplies tools; it does not, by itself, make Claude Code or Codex an extension-controlled agent backend. Inspect each product's current supported SDK, subprocess, or application-server integration before implementing the embedded workflow.

Use a local companion only where needed for native process/session integration. Extend or compose with the existing MCP infrastructure rather than replacing it. A companion must not become a second independent implementation of browser tools.

Do not promise that CLI subscriptions authorize arbitrary API calls. Do not extract credentials from another product or emulate undocumented login endpoints.

### Common adapter contract

Each backend must implement equivalent capabilities where supported:

```ts
interface AgentBackend {
  capabilities(): Promise<BackendCapabilities>;
  connect(config: BackendConfig): Promise<void>;
  startSession(input: AgentSessionInput): Promise<{ sessionId: string }>;
  send(sessionId: string, message: UserMessage): Promise<void>;
  events(sessionId: string): AsyncIterable<AgentEvent>;
  respondToApproval(sessionId: string, response: ApprovalResponse): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  disconnect(): Promise<void>;
}
```

Types above are proposed EvilMonkey interfaces, not vendor SDK interfaces. Define them from verified backend capabilities. Normalize text output, tool events, approval requests, errors, usage when available, completion, and cancellation. Do not fabricate hidden reasoning or expose private chain-of-thought.

## 5. Core agent loop

1. User states intent.
2. Extension identifies target tab, frame, document, and allowed scope.
3. Agent captures relevant ground truth.
4. Tools return structured evidence with provenance.
5. Agent proposes implementation and observable tests.
6. Agent generates a candidate Curse.
7. Extension permits bounded testing within the approved scope.
8. Agent executes, interacts, verifies, captures failures, and revises.
9. User reviews exact code diff, permissions, results, and limitations.
10. User approves persistent installation of that exact version.

Default session scope is the selected tab/site, not all open tabs.

## 6. Extension UI

### Popup

Use the supplied Violentmonkey popup mockup as the placement reference. Put the agent interaction below the existing script-search area.

Include:
- Existing script controls, rebranded appropriately.
- Current site and relevant Curses.
- Backend selector: Claude Code, Codex, Anthropic API, OpenAI API.
- Connection/authentication status.
- Prompt box: “What should this website do?”
- Element picker.
- Start/continue action.
- Compact progress and stop control.
- Open-workspace action.

### Persistent workspace

Use a side panel or extension page for longer sessions:
- Conversation and task history.
- Investigation/tool timeline.
- Evidence viewer.
- Code editor and diff.
- Assertions and test artifacts.
- Permissions and approvals.
- Backend configuration.
- Session recovery.

Closing the popup must not cancel the session. Session orchestration must not depend on popup lifetime or an uninterrupted service-worker lifetime.

### Product vocabulary

- Curse: userscript.
- Conjure: generate or revise.
- Cast: enable.
- Disable: stop future execution; cleanup/reload may still be necessary.
- Banish: delete.
- Grimoire: script library.

Keep plain technical language for permissions and diagnostic controls. Do not obscure security decisions behind fantasy wording.

## 7. Architecture

```text
Popup / Side Panel / Workspace
                |
      Session Orchestrator + Policy Gate
                |
        Shared Browser/Curse Tools
        |          |             |
    Evidence    Inspection    Existing upstream
     Store      + Testing    userscript engine
                |
        Existing MCP integration
                |
   External Claude Code / Codex / other MCP clients

Backend adapters used by the embedded workspace:
- Claude Code integration
- Codex integration
- Anthropic API
- OpenAI API
```

The diagram describes logical responsibilities, not a mandatory single transport topology. Determine exact call routing after auditing upstream and vendor integration options. Avoid duplicate execution paths and inconsistent policies.

### Components

- Upstream userscript core: storage, metadata, execution, GM compatibility.
- Existing upstream MCP integration: connection and agent tool transport.
- Backend adapters: agent sessions and provider differences.
- Session orchestrator: state, budgets, cancellation, checkpoints.
- Policy gate: scope, permissions, sensitive data, approvals.
- Browser tools: inspection and interaction.
- Evidence store: facts, artifacts, provenance, navigation validity.
- Verification runner: assertions, flow replay, before/after comparisons.

## 8. Deep browser investigation requirement

Agents must have tools covering these DevTools areas:

| Area | Required capabilities |
| --- | --- |
| Elements | DOM, semantic structure, accessibility, attributes, computed styles, layout, event listeners, mutations |
| Console | Logs, warnings, exceptions, stacks, bounded evaluation |
| Sources | Loaded scripts, relevant source search, source maps when available, breakpoints, call stacks |
| Network | Requests, responses when available, timings, initiators, selected bodies, fetch/XHR/WebSocket investigation |
| Performance | Metrics, traces, long tasks, rendering/layout impact, before/after measurements |
| Memory | DOM growth and leaks, available memory measurements, heap snapshots/profiling where backend supports them |
| Application | Relevant storage, caches, workers, and application state |
| Security | Available connection/security metadata, issues, permission context |
| Lighthouse | Actual audit integration and reports, not a relabeled generic metric |
| Recorder | Record and replay relevant user flows with assertions |

### Capability truthfulness

This is a capability requirement, not a claim that every DevTools panel is directly exposed by a browser extension.

- Prefer browser instrumentation and structured tools over clicking DevTools UI.
- Feature-detect browser, transport, target, and protocol capabilities.
- Chrome debugger transport exposes a restricted protocol surface; do not assume unrestricted CDP.
- Full heap profiling, Security-domain access, Lighthouse, and Recorder integration need explicit investigation and may require a supported additional backend.
- Handle debugger detachment and possible interaction with an open DevTools session.
- Never treat protocol Audits as synonymous with Lighthouse.
- Inaccessible content, missing bodies, source maps, framework internals, and expired handles must be reported explicitly.
- Do not claim historical evidence was captured before instrumentation began.

Return a capability matrix at session start. Where unavailable, report the reason and a real fallback rather than pretending success.

## 9. Clever tools: optimize for useful evidence

Do not expose only an unrestricted JavaScript evaluator.

Implement task-oriented tools for:
- User-picked element plus semantic ancestors and repeated siblings.
- Stable selector proposals with uniqueness and reload/state validation.
- Repeated card/list/table detection.
- Correlation of actions with DOM changes, requests, exceptions, and timing.
- SPA route and document-epoch tracking.
- Dynamic-content investigation after scrolling.
- Event-listener and delegated-handler investigation.
- Relevant source and response-body search before model transmission.
- Before/after comparisons.
- Existing Curse conflict detection.
- Framework-state inspection where actually accessible.
- Targeted evidence retrieval instead of whole-page dumps.

Distinguish observed facts from inferred explanations. Correlation alone is not proof of causality.

### Proposed tool families

These names are proposed additions, not claims about existing upstream tools. Reuse existing equivalents.

```text
session: start, status, capabilities, stop
 targets: list, select, frames
 dom: snapshot, find, inspect, styles, listeners, observe
 selectors: propose, validate
 runtime: logs, exceptions, evaluate
 sources: list, search, read
 debugger: pause, resume, breakpoint
 network: start_capture, query, body, stop_capture
 page: click, type, scroll, navigate, wait
 application: inspect
 storage: list, read
 performance: measure, trace
 memory: inspect
 security: inspect
 lighthouse: run
 flows: start_recording, stop_recording, replay
 curses: list, read, draft, diff, test, install, disable, delete
 assertions: run
 evidence: search, read
 artifacts: read
```

Normalize public names for each client's supported tool naming rules.

### Tool contract

Every tool declares:
- Typed input/output schema.
- Required capabilities and permissions.
- Explicit target and scope.
- Read/write risk and possible side effects.
- Timeout, cancellation, output budget, and pagination.
- Redaction policy.

Results include status, target, document epoch, evidence references, warnings, limitations, and next-page cursor when applicable.

Unsupported tools return a structured capability error. Never silently fall back to a broader or riskier action.

## 10. Evidence model

Capture ground truth as ranked, retrievable facts:
- Candidate nodes and selector strategies.
- Relevant text, accessibility, and structure.
- Mutation and route behavior.
- Existing handlers and script interactions.
- Relevant API endpoints and response shapes.
- Timing and failure evidence.

Example:

```json
{
  "evidenceId": "ev_123",
  "sessionId": "session_1",
  "documentEpoch": 4,
  "kind": "target_candidate",
  "target": { "tabId": 12, "frameId": 0, "origin": "https://example.com" },
  "summary": "Repeated feed cards include a Sponsored label",
  "selectorCandidates": [
    {
      "selector": "[data-testid='feed-card']",
      "matchCount": 18,
      "stability": "not_yet_tested"
    }
  ],
  "provenance": { "tool": "dom.find", "capturedAt": "ISO-8601" },
  "limitations": ["Only currently loaded cards inspected"]
}
```

Use progressive disclosure. Keep large traces, snapshots, and bodies as artifacts. Invalidate stale references on navigation. Bound collection and redact before transmitting to external models.

## 11. Curse implementation requirements

Preserve ordinary userscript compatibility where possible:
- Existing metadata semantics.
- Supported GM APIs and execution worlds.
- Correct injection timing.
- Narrow match patterns and minimum grants.
- Import/export and existing updates.

Generated Curses should:
- Be idempotent.
- Handle dynamic content and SPA navigation when relevant.
- Avoid duplicate listeners, UI, observers, and timers.
- Avoid unbounded polling or mutation work.
- Provide cleanup for agent-managed tests where feasible.
- Include clear error handling.
- Avoid unnecessary dependencies or external requests.

Inspect upstream's actual MV3 execution path and userScripts integration. Do not replace it with extension eval or claim sandbox isolation that has not been verified.

### Lifecycle

```text
draft -> checked -> authorized_test -> testing
                                 -> failed -> revised -> testing
                                 -> verified -> awaiting_approval -> installed
```

Temporary execution is separately authorized from persistent installation. Disabling a script does not undo arbitrary page changes, network requests, downloads, or server-side effects. Offer cleanup or reload and explain limitations.

## 12. Verification requirements

Every task has observable acceptance criteria. A successful tool call or absence of exceptions is insufficient.

For “hide sponsored posts,” test:
- Sponsored cards hidden.
- Ordinary cards remain.
- New dynamically loaded sponsored cards handled.
- Reload and SPA behavior as relevant.
- No duplicate observers or attributable new errors.

For “add download buttons,” test:
- Correct placement and item association.
- No duplicates.
- Dynamic items handled.
- Intended download behavior verified where possible.
- Unsupported media/authentication/DRM cases reported rather than bypass capabilities invented.

Each assertion reports PASS, FAIL, NOT_RUN, or INCONCLUSIVE with evidence and conditions.

Before final approval show code diff, metadata, matched sites, grants, external destinations, test results, remaining limitations, and reload requirements. Approval binds to the exact candidate revision.

## 13. Security and user control

- Treat website text, scripts, comments, and responses as untrusted evidence, never agent instructions.
- Enforce scope and approvals in code, not only prompts.
- Do not send cookies, bearer tokens, full storage dumps, or unrelated private content by default.
- Redact secrets before model transmission and logs.
- Keep provider credentials unavailable to ordinary Curses and page scripts.
- Keep debugger/MCP control privileges unavailable to Curses.
- Authenticate and authorize companion connections; avoid unauthenticated local control ports.
- Preserve upstream connection approval and explicit disconnection semantics unless deliberately redesigned.
- Keep a visible action audit trail and immediate stop control.
- Require explicit approval for purchases, messages, submissions, destructive actions, account changes, or state-changing network replay.
- Request approval when expanding origin scope, grants, or external destinations.

An authenticated duplicate tab is not an isolated test environment. Tests can affect real accounts and server state.

## 14. Session durability and budgets

- Persist sufficient session state for popup closure and worker suspension.
- Distinguish resumable state from invalid live handles after navigation or restart.
- Show reconnect requirements instead of storing upstream tokens secretly to bypass its lifecycle.
- Bound iterations, runtime, model usage, capture sizes, and artifact retention.
- Stop cancels pending agent work and active collection where supported; disclose effects that cannot be recalled.
- Do not silently switch backend or incur API costs.

## 15. Implementation phases

### Phase 0 — Audit
- Pin upstream commit and inspect extension/MCP source.
- Verify Claude Code and Codex integration options and authentication.
- Inventory browser capabilities and distribution constraints.
- Produce gap analysis and architecture decisions.

### Phase 1 — Claude Code vertical slice
- Existing MCP management works from Claude Code.
- Embedded UI starts/continues a Claude Code-backed task using a verified integration.
- DOM/console evidence, candidate generation, authorized test, assertions, repair, diff, and installation approval work end to end.

### Phase 2 — Codex parity
- Existing/new tools work through Codex MCP configuration.
- Embedded Codex-backed sessions support equivalent user-visible workflow.
- Backend switching does not alter browser permission enforcement.

### Phase 3 — Direct APIs
- Anthropic API adapter, then OpenAI API adapter.
- Explicit credentials, billing distinction, model settings, usage visibility, and cancellation.

### Parallel browser-tools track
- Deepen Network, Sources, frame/worker handling, SPA inspection, recording/replay, and diagnostics.
- Add optional supported backends for missing capabilities.
- Complete a tested matrix for every requested DevTools area.

Phases are delivery order, not permission to remove requested capabilities from the product scope.

## 16. Acceptance criteria

- Existing upstream script management and MCP access remain functional.
- Claude Code and Codex each work as external MCP agents.
- Claude Code and Codex each work from the built-in extension workflow, through verified native integration where needed.
- Anthropic and OpenAI direct APIs are separately selectable backends.
- User describes an enhancement in the popup/workspace.
- Agent investigates the real page and links decisions to evidence.
- Agent creates a compatible Curse and tests it within approved bounds.
- A detected failure triggers at least one demonstrated evidence-based repair.
- User sees exact code, permissions, results, and limitations before installation.
- Popup closure does not lose the session.
- Stop/reconnect/reload behavior is tested.
- Unsupported tools report explicit limitations.
- Existing Curses remain usable without AI.

## 17. Instructions to implementation agents

Read this specification, inspect the actual repository, and produce the gap analysis before architecture changes.

Do not rebuild existing upstream MCP functionality. Do not confuse an MCP tool server with an agent-session backend. Prioritize Claude Code, then OpenAI Codex, then Anthropic and OpenAI APIs.

Build one working vertical slice before broad scaffolding. Share browser tool implementations across embedded and external agents. Use structured evidence and observable tests. Never invent vendor interfaces, browser access, test results, or compatibility.

## 18. References and verification status

User-supplied upstream AI Agent Access documentation is the basis for the setup and transport descriptions above. Re-verify against the pinned source revision during Phase 0.

- Violentmonkey AI Agent Access: https://violentmonkey.github.io/guide/ai-agent-access/
- Violentmonkey source: https://github.com/violentmonkey/violentmonkey
- Official repository listing, including MCP: https://github.com/orgs/violentmonkey/repositories
- Claude MCP server guidance: https://claude.com/docs/connectors/building
- MCP development plugin: https://github.com/anthropics/claude-plugins-official/tree/main/plugins/mcp-server-dev
- Chrome debugger API and supported protocol domains: https://developer.chrome.com/docs/extensions/reference/api/debugger
- Chrome userScripts API: https://developer.chrome.com/docs/extensions/reference/api/userScripts

This document proposes integration requirements; it does not claim that Claude Code or Codex embedded session transports have already been selected or implemented. Verify their current official documentation before coding.
