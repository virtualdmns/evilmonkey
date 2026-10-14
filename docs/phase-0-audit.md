# Phase 0: Source and Integration Audit

Status: Complete, pending review
Audit date: 2026-10-14
Plan: `docs/evilmonkey-extension-plan.md`, Phase 0 ("Source and Integration Audit")
Objective from the plan: produce the required source-backed gap analysis and architecture decisions before adding agent architecture.

Reading rule used throughout: observed facts are labeled as observed; anything inferred is labeled as interpretation; anything not yet confirmed is labeled unverified. Do not treat this document's interpretations as established behavior.

## 1. Pinned source baseline

Observed:

- Repository path in this project: `violentmonkey/`
- Upstream project: `violentmonkey/violentmonkey`
- Pinned commit: `de690ecdf923dc444f402b91c1c7d8edd471f31a`
- Commit verified to exist upstream via the GitHub API. Message: "fix: string interpolation in JS mixed mode (#2705)". Commit date: 2026-10-13.
- `violentmonkey/package.json` at that commit: `"name": "violentmonkey"`, `"version": "2.49.0"`. The source self-identifies as Violentmonkey 2.49.0, matching the plan's record.
- Build tooling pinned by the baseline: Node `>= 24` (`engines`), `pnpm@12.4.2` (`packageManager`), MV3 build via `cross-env MV3=1 gulp build` (`build:mv3`).

Interpretation: the baseline is a normal upstream checkout, not a fork with local modifications. No EvilMonkey-specific source exists yet outside `docs/`, `img/`, and `reference/`. All gap analysis below is against this exact commit.

## 2. Upstream MCP server: `violentmonkey/mcp`

Observed (upstream repository `violentmonkey/mcp`, inspected at current main on 2026-10-14):

- Packages and versions: `@violentmonkey/mcp` 0.1.1 (the server), `@violentmonkey/mcp-client` 0.1.1 (the browser WebSocket client), `@violentmonkey/mcp-protocol` 0.1.1 (constants, types, zod schemas). The extension baseline depends on `@violentmonkey/mcp-client` `^0.1.1`.
- Server README documents the topology: the agent speaks MCP (stdio or HTTP) to a local `@violentmonkey/mcp` server process; the extension connects to that server over a WebSocket authenticated with a token. Quote of the architecture from the README, paraphrased: the server owns the tool list and schemas; agent tool calls are forwarded to the extension; results are returned.
- Components per `docs/design.md`:
  - `@violentmonkey/mcp-protocol`: pure TypeScript, no I/O. Constants (protocol version, error and close codes, `ToolCallError`) plus zod schemas in `packages/protocol/src`. The schemas file is described as the single source of truth.
  - `@violentmonkey/mcp` (server): MCP front end built on `@modelcontextprotocol/sdk` `McpServer` with `StdioServerTransport` or `StreamableHTTPServerTransport`; a Hono bridge on `@hono/node-server` plus `@hono/node-ws` exposing `GET /ws` (extension WebSocket), `POST|GET|DELETE /mcp` (Streamable HTTP, only with `--transport http`), and `GET /health` (unauthenticated liveness, returns only `{ "ok": true }`).
  - `@violentmonkey/mcp-client`: small browser WebSocket client, no Node dependencies. Performs handshake, dispatches calls to registered handlers, sends heartbeats, reconnects with backoff.
- CLI surface per README: `npx @violentmonkey/mcp [options]` with `-p/--port` (default 5678), `--host` (default 127.0.0.1), `--token` (fixed token, or `VM_MCP_TOKEN` env), `--readonly` (expose only read-only tools), `--transport` (`stdio` default or `http`).
- Transports:
  - stdio (default): the agent spawns the server as a child process. Server lifetime equals the agent session lifetime. Logs go to stderr; the connect URL is also printed to stderr at startup.
  - http: standalone server; Streamable HTTP MCP at `POST /mcp` on the same port as the extension WebSocket. Requests require `Authorization: Bearer <token>`. A restarted server invalidates the token, so fixed `--token` is required in this mode. Binding beyond localhost is the operator's responsibility (TLS via reverse proxy).
- Extension WebSocket protocol (`docs/protocol.md`): endpoint `ws://<host>:<port>/ws`, JSON text frames, protocol version integer `1`. Client must send `hello` as the first frame within 5 seconds; the token travels in the `hello` frame, not the URL. Server replies `ready` with the accepted tool subset, or closes with a close code (4000 malformed hello, 4001 replaced, 4002 intentional close, 4003 bad token or Origin, 4004 unsupported protocol version).
- Server checks the `Origin` header on upgrade and accepts only `chrome-extension://`, `moz-extension://`, and `extension://` schemes (missing `Origin` only with `VM_MCP_ALLOW_NO_ORIGIN=1`, documented as test-only). Token comparison is constant time. The server also validates the `Host` header against loopback or the configured `--host` (DNS-rebinding mitigation).
- Tool call flow: server validates params against the input schema before forwarding; sends `call{id,tool,params}`; 30 second timeout yields `504`; extension responds `result{id,ok,data|error}`; server validates the response against the output schema and a mismatch becomes `502`. Errors surface as MCP tool results with `isError: true` and text `[code] message`. Error codes: 400 invalid params, 403 denied by user or settings, 404 not found, 500 handler failure, 502 bad extension response, 503 not connected, 504 timeout.
- Capabilities negotiation: the client sends the handler names it supports in `hello`; the server exposes the intersection of that set with its own registry and emits MCP `tools/list_changed` when the connected set changes. Unknown client tool names are ignored. While disconnected, tools stay listed but calls fail with 503 (deliberate, so agents are not confused by a vanishing tool list). `vm_status` is always exposed and handled by the server itself, including while disconnected.
- Single connection: at most one extension connection. A new connection presenting the valid token replaces the old one (old socket closed with 4001). Design doc states this exists because MV3 service workers die and reconnect while the server may not have noticed the old socket is dead.
- Liveness: client pings every 20 seconds; server pongs; either side closes after 60 seconds of silence. The design doc notes the 20 second interval also keeps an MV3 service worker alive while connected. Client reconnect uses exponential backoff from 1 second to 30 seconds and stops on terminal close codes 4002 (user disconnected) and 4003 (bad token).
- Explicit non-goals in `docs/design.md`: multiple simultaneous extensions/browsers; persisting tokens or auto-reconnect across server restarts; running scripts in tabs and reading console logs (planned as later tools named `script_logs` and `tab_eval`).

## 3. Extension MCP client: `violentmonkey/src/background/utils/mcp.js`

Observed (baseline commit, file read in full):

- This file is an MCP **client**, built on `@violentmonkey/mcp-client` `createClient`. It connects **out** to the local server at `127.0.0.1:<port>` (host constant `HOST = '127.0.0.1'`). It is not a server and not an agent runtime.
- Connection initiation: `MCP_CONNECT_URL = 'https://violentmonkey.github.io/mcp_connect.html'`. `violentmonkey/src/background/utils/tab-redirector.js` registers a `webRequest.onBeforeRequest` observer on `${MCP_CONNECT_URL}*` (non-blocking in MV3). When the user navigates to the connect URL, `requestMcpConnection(url)` parses `port` and `token` from the query string, validates `0 < port < 65536` and a non-empty token, and stashes `{ port, token }` in the module-level `pending` variable. `openMcpAuthorization(tabId)` then navigates the tab to the extension's own settings MCP page. In MV3 the listener cannot block, so the stub page also loads; the design doc calls it "a static, harmless stub if the extension is not installed."
- Approval: background commands `McpApprove` (calls `connect(pending)`, clears `pending`), `McpReject` (clears `pending`), `McpDisconnect` (closes client, resets to idle), `McpGetState` (returns status, pending port, current port). The settings UI `violentmonkey/src/options/views/tab-settings/vm-mcp.vue` renders pending approval with Approve/Reject buttons, connection state (idle/connecting/open/closed) with Disconnect, and links to the upstream AI agent access guide. It polls state once per second while the settings tab is active.
- `connect({ port, token })`: closes any existing client, creates a new client via `createClient({ host, port, token, info: { name: 'Violentmonkey', version: __.VM_VER } })`, registers the five tool handlers, subscribes to status updates, and calls `client.connect()`.
- Registered handlers (the only tools the extension exposes): `scripts_list`, `scripts_get`, `scripts_write`, `scripts_set_enabled`, `scripts_delete`. Details in section 5.
- `@violentmonkey/mcp-client` 0.1.1 behavior (from `packages/client/src/index.ts`, read in full): `hello` frame carries protocol version, token, client info, and handler names; heartbeat ping every 20 seconds with close-if-silent logic at 3x the interval; reconnect with exponential backoff 1s to 30s on non-terminal close codes; terminal codes stop reconnecting; statuses `idle | connecting | open | closed`. The client is deliberately validation-free (the server validates) to stay small. All client state lives in closures; nothing is persisted.
- No MCP-related state is written to `chrome.storage` anywhere in the baseline. `pending`, `client`, `current`, and `status` are module-level variables in `mcp.js`. The only two files referencing the MCP background commands are `mcp.js` itself and `vm-mcp.vue`; there is no hidden reconnect or persistence path.

## 4. Responsibility separation: MCP server vs extension MCP client

This separation is load-bearing for the whole project. Stated plainly:

- The **MCP server** (`@violentmonkey/mcp`, a local Node process the agent runs) owns: the tool registry, the zod input/output schemas, tool descriptions, MCP transport to the agent (stdio/HTTP), the extension WebSocket bridge, token generation and verification, Origin/Host checks, param and response validation, timeouts, error mapping, `vm_status`, and the 503-while-disconnected behavior. It decides what the agent may call.
- The **extension MCP client** (`mcp.js` plus `@violentmonkey/mcp-client`) owns: opening the WebSocket with the user-approved token, answering the server's `hello`/`ready` handshake, dispatching `call` messages to its five registered handlers, heartbeats, and reconnect backoff. It exposes script-management **capabilities**; it defines no tools, no schemas, and no descriptions. Per the upstream design doc, this asymmetry is intentional: tool descriptions are injected into the agent's context, so letting the extension supply them would open a prompt-injection channel.
- Neither side is an agent session backend. The server does not run an agent loop; the client does not host Claude Code, Codex, or any model. An external agent (Claude Code, Codex CLI, any MCP client) connecting to the server is **using** EvilMonkey's script tools. That is not the same as the extension **driving** an agent session. The embedded-session work in Phases 4 and 5 must build a separate backend adapter on top of vendor-supported session integrations (sections 13 and 14), and must share one policy gate and one browser-tool implementation with the MCP path so external and embedded access cannot diverge.

## 5. MCP tool inventory

Schemas observed in `violentmonkey/mcp` `packages/protocol/src/tools.ts` (zod, single source of truth). Extension handler behavior observed in `violentmonkey/src/background/utils/mcp.js`.

| Tool | Input | Output | Annotations | Extension handler behavior |
|---|---|---|---|---|
| `vm_status` | (server-defined) | connected flag, version, connect URL | read-only | Handled by the server itself; works while disconnected. The extension registers no handler for it. |
| `scripts_list` | `query` optional string, case-insensitive name filter | `{ scripts: scriptSummary[] }` | read-only | Filters out removed scripts; maps to `{ id, name, namespace?, version?, enabled, matches }`. |
| `scripts_get` | `id` integer | `{ script: scriptDetail }` (summary plus `code`) | read-only | Throws 404 `ToolCallError` if missing or removed; reads code from the `S_CODE` storage bucket. |
| `scripts_write` | `code` non-empty string, `id` optional integer, `enabled` optional boolean | `{ script: scriptSummary, created: boolean }` | idempotent | Parses via `parseScript` with `bumpDate: true, reloadTab: true`; without `id` it matches by `@name`/`@namespace` or creates. Parse failure becomes a 400 `ToolCallError` with Violentmonkey's message. |
| `scripts_set_enabled` | `id` integer, `enabled` boolean | `{ script: scriptSummary }` | idempotent | Updates config and `lastModified`. |
| `scripts_delete` | `id` integer | `{ id }` | destructive | Marks removed, splices from alive scripts, then removes. |

`scriptSummary` shape: `{ id: int, name: string, namespace?: string, version?: string, enabled: boolean, matches: string[] }`.

Interpretation: the tool surface covers script CRUD completely and nothing else. There are no browser-investigation tools, no tab tools, no console tools, no test-run tools. The upstream non-goals list confirms `script_logs` and `tab_eval` are planned but absent. Every Phase 2 and Phase 3 browser tool is therefore new work, not an extension of these handlers.

## 6. Pairing, token lifecycle, and restart behavior

Observed:

- Token origin: the server generates a random 32-byte base64url token at startup unless `--token` or `VM_MCP_TOKEN` supplies a fixed one. The token is delivered to the agent via `vm_status` and to stderr at startup, then embedded by the agent's user in the connect URL.
- Token scope: loopback only by default (`127.0.0.1`); `Origin` restricted to extension schemes; `Host` header validated. The token is sent in the `hello` frame, never in the WebSocket URL, so it does not land in access logs.
- Token lifetime: per server start. It is not single-use: a new connection presenting the valid token replaces the existing one. A restarted stdio server gets a new token by design; HTTP mode needs a fixed token to survive restarts.
- Approval: every connection requires the user to open the connect URL and click Approve in extension settings. The authorization page shows the port (observed in `vm-mcp.vue` via `labelMcpPending` with the port; the upstream security doc recommends also showing the requested tool set).
- Persistence: none. `pending`, `client`, `current`, and `status` live in `mcp.js` module memory; the client library keeps everything in closures. Nothing is written to `chrome.storage`.
- Restart behavior, traced:
  - While connected, the 20 second ping/pong keeps the MV3 service worker alive (each incoming message resets the idle timer), so mid-session worker death is unlikely but not impossible.
  - If the worker dies (browser restart, or suspension despite heartbeats), the connection is gone and nothing recreates it: no persisted token, no persisted pending approval, no startup reconnect. Status resets to `idle`.
  - Recovery is manual: the user re-opens the connect URL and re-approves. Within one server lifetime the same token still validates, and the new connection replaces the stale server-side socket (close 4001). With a stdio server the agent session usually ends with the browser session anyway, so a fresh token is the normal case.
- Disconnect: `McpDisconnect` closes the client with close code 4002 ("user disconnected"), which is terminal for the client's reconnect logic. The server then reports 503 for all tools except `vm_status` until the extension returns.

Interpretation: the lifecycle is secure by default (no persisted credentials, explicit approval per connection) at the cost of manual recovery after browser restart. Phase 1 should design the workspace's disconnected state around this: show "not connected" with the exact recovery steps rather than a spinner. Any future auto-reconnect would need persisted-token UX with explicit user consent, per the upstream security recommendations, and is out of scope for the first release.

## 7. Injection engine inventory

Observed in `violentmonkey/src/common/browser-scripts-api.js` and `violentmonkey/src/background/utils/preinject-core.js`:

- MV3 execution uses `chrome.userScripts` exclusively:
  - `registerInjector` registers `INJECTED_API_ID` (`'1001'`) at `document_start`, `allFrames: true`, `matches: ['<all_urls>']`, with `js: [{ file: 'injected-web.js' }, { file: 'injected.js' }]`. It first calls `api.configureWorld` with a custom CSP (`script-src 'self' 'unsafe-inline' 'unsafe-eval'`, `style-src * 'unsafe-inline' data: blob:`) and `messaging: true`.
  - Per-navigation script data is registered under `INJECTED_DATA_ID + url` (`'1000' + url`) with the URL escaped for matches, then `chrome.userScripts.update` widens the API script's matches. Unregistration removes the per-URL data script.
  - `executeScript(tabId, code, runAt, frameId)` calls `chrome.userScripts.execute` with `injectImmediately` set when `runAt` is `document_start` or truthy, returning the first result. This is the function `injectContentRealm` uses for content-realm injection.
  - Registration failure handling: if `chrome.userScripts` is unavailable, the code shows a localized `userScriptsPermissionNote`, choosing a newer variant for Chrome >= 138 and an older one below. Observed code behavior only; the exact Chrome 138 platform change behind the two notes is unverified (open item U8).
- Pre-injection pipeline (`preinject-core.js`): `webRequest.onSendHeaders`/`onHeadersReceived` listeners prepare per-URL script bags, with CSP/nonce detection (`detectStrictCsp`), an XHR-inject fallback path, and blob-rule revocation for MV3. A 5-minute in-memory cache holds prepared bags.
- The plan's Chrome 135 floor traces to exactly one call: `chrome.userScripts.execute`, which Chrome documents as available from Chrome 135. Supporting version facts from current Chrome docs: `chrome.userScripts` base API from Chrome 120; `configureWorld` `worldId` and `getWorldConfigurations` from Chrome 133; `execute()` from Chrome 135. The MV3 manifest floor of 135 is therefore required by `executeScript`, not by the registration path.

## 8. Storage inventory

Observed:

- `violentmonkey/src/background/utils/storage.js`: script code and values live in named `VMStorageArea` buckets keyed by prefix (e.g. `S_CODE` for script source, used by the `scripts_get` handler), backed by `browser.storage.local`. The manifest requests `unlimitedStorage`.
- Script metadata and lifecycle live in `violentmonkey/src/background/utils/db.js` (imported by `mcp.js` as `getScriptById`, `getScripts`, `parseScript`, `removeScripts`, `updateScriptInfo`).
- No MCP, session, or agent state is persisted today. Phase 1 session persistence must follow the existing bucket pattern or record a deliberate new one, and must never persist tokens or live browser handles.

## 9. GM API inventory

Observed in `violentmonkey/src/injected/web/gm-api.js` (exported surfaces):

- `GM_API_CTX_GM4ASYNC`: `GM_cookie`, `GM_deleteValue`, `GM_deleteValues`, `GM_getValue`, `GM_getValues`, `GM_listValues`, `GM_setValue`, `GM_setValues`, `GM_download`.
- `GM_API_CTX`: `GM_addValueChangeListener`, `GM_removeValueChangeListener`, `GM_getResourceText`, `GM_getResourceURL`, `GM_registerMenuCommand`, `GM_unregisterMenuCommand`, `GM_notification`, `GM_xmlhttpRequest` (plus `GM4_ALIAS` async aliases).
- `GM_API`: `GM_addElement`, `GM_addStyle`, `GM_openInTab`, `GM_setClipboard`, `GM_log`.

Interpretation: the full GM surface must be preserved as-is. The candidate test runner (Phase 3) executes in the same USER_SCRIPT world via the same engine, so GM API behavior during tests matches production by construction. Do not reimplement GM APIs for the agent path.

## 10. Manifest, permissions, and build targets

Observed in `violentmonkey/src/manifest.yml` plus the MV3 transform in `violentmonkey/scripts/manifest-helper.js`:

- MV2 base permissions: `tabs`, `<all_urls>`, `webRequest`, `webRequestBlocking`, `notifications`, `storage`, `unlimitedStorage`, `clipboardWrite`, `contextMenus`, `cookies`; optional: `downloads`.
- MV3 generated manifest: `manifest_version: 3`, `minimum_chrome_version: '135.0'`, background `service_worker: 'sw.js'`, `incognito: 'split'`, content scripts removed (replaced by `chrome.userScripts`), `host_permissions: ['<all_urls>']`, and permissions = base minus `<all_urls>`/`webRequestBlocking`, plus `alarms`, `declarativeNetRequestWithHostAccess`, `declarativeNetRequestFeedback` (non-production builds only), `identity`, `offscreen`, `userScripts`, `webNavigation`.
- Effective MV3 permission set: `tabs`, `webRequest`, `notifications`, `storage`, `unlimitedStorage`, `clipboardWrite`, `contextMenus`, `cookies`, `alarms`, `declarativeNetRequestWithHostAccess`, `identity`, `offscreen`, `userScripts`, `webNavigation`, with `<all_urls>` host access.
- Deliberately absent from the generated manifest: `debugger`, `sidePanel`, `scripting`. No `side_panel` manifest key exists.
- Build targets: `getBrowserTargets` reports `Chrome >= 135` from the MV3 floor; the MV2 base still declares Firefox `strict_min_version: 68.0`. The MV3 path is Chrome-only in practice.

## 11. Feature classification

Classification key: **upstream complete** (works today, preserve it), **upstream requiring extension work** (exists but needs EvilMonkey-side changes), **new** (design and build).

| Feature | Class | Basis |
|---|---|---|
| Userscript registration, execution, and lifecycle via `chrome.userScripts` | Upstream complete | Section 7 |
| GM API surface | Upstream complete | Section 9 |
| Script storage, metadata DB, import/export conventions | Upstream complete | Section 8; import/export per plan product goals, file-level verification deferred to Phase 1 |
| External agent script management via `@violentmonkey/mcp` (stdio and HTTP) | Upstream complete | Section 2; verified against upstream README and protocol docs |
| MCP pairing, approval UI, token lifecycle, disconnect | Upstream complete | Section 6; keep compatible, do not fork |
| MV3 build, service worker, `<all_urls>` host model | Upstream complete | Section 10 |
| Side Panel workspace | Upstream requiring extension work | No `sidePanel` permission or `side_panel` key; Chrome 114+ requirement is below the 135 floor, so no floor change is needed |
| Extension-page workspace fallback | Upstream requiring extension work | Options page infrastructure exists (`options/index.html`); a workspace route is new |
| MCP reconnection UX after worker/browser restart | Upstream requiring extension work | Lifecycle is manual today (section 6); the workspace must surface disconnected state and recovery steps |
| Extension-side read-only MCP mode | Upstream requiring extension work | Recommended by upstream `docs/security.md` (reject writes with 403); not implemented in `mcp.js` |
| Chrome 138 `userScripts` permission-note flow | Upstream requiring extension work | Branch exists in `browser-scripts-api.js`; platform behavior unverified (U8) |
| Persistent agent workspace (Side Panel) | New | Nothing in the baseline |
| Session orchestrator, checkpoints, budgets, cancellation | New | Nothing in the baseline; must survive worker suspension via persisted state |
| Policy gate (scope, approvals, redaction, exact-revision install) | New | Nothing in the baseline |
| Browser evidence and investigation tools | New | Upstream explicitly lists `script_logs`/`tab_eval` as future, not present |
| Candidate Curse test runner with observable assertions | New | `chrome.userScripts.execute` exists as a primitive; the authorized test lifecycle around it is new |
| Evidence and artifact store | New | Nothing in the baseline |
| Embedded Claude Code backend adapter | New | Requires companion (section 13) |
| Embedded Codex backend adapter | New | Requires companion (section 14) |
| Direct Anthropic/OpenAI API backends | New | Phase 6; user-supplied credentials, in-extension `fetch` |

## 12. Chrome tool capability matrix

Verified against current Chrome extension documentation on 2026-10-14. "Fallback" means what EvilMonkey can use if the first-choice API is unavailable or rejected.

| Capability | API | Permission / manifest | Availability and limits | Fallback |
|---|---|---|---|---|
| Persistent workspace UI | `chrome.sidePanel` | `sidePanel` permission, `side_panel.default_path` manifest key | MV3, Chrome 114+. Panel persists while browsing, unlike the popup. Per-tab or global via `setOptions`. Programmatic open is gesture-gated; verify exact rules in Phase 1. | Extension page (e.g. options workspace route or dedicated tab). Popup alone is not viable: it closes on focus loss and cannot host long sessions. |
| Userscript execution | `chrome.userScripts` | `userScripts` permission | Chrome 120+; `execute()` Chrome 135+ (drives the 135 floor). Requires the user to enable "Allow User Scripts" in `chrome://extensions`; the extension cannot enable it programmatically. `getScripts`/`register`/`update`/`unregister`/`configureWorld` available. | None for the engine itself; the permission note flow in `browser-scripts-api.js` is the UX path. |
| One-shot script injection | `chrome.scripting` | `scripting` permission (not declared) | Available MV3 Chrome 88+. Runs in ISOLATED world by default, separate from the USER_SCRIPT world. | Not needed for Curse execution (use `userScripts`); may be considered in Phase 2 for evidence collection where world isolation is acceptable. |
| Deep page instrumentation (network, runtime, DOM snapshots, performance) | `chrome.debugger` | `debugger` permission, **not declarable as optional** (verified in the official permissions reference, which lists `debugger` among permissions that cannot be optional) | Restricted CDP domain allow-list (Accessibility, Audits, CacheStorage, Console, CSS, Database, Debugger, DOM, DOMDebugger, DOMSnapshot, Emulation, Fetch, IO, Input, Inspector, Log, Network, Overlay, Page, Performance, Profiler, Runtime, Storage, Target, Tracing, WebAudio, WebAuthn). Shows a visible "is being debugged" infobar; detaches when DevTools opens; blocked entirely by some enterprise policies (`runtime_blocked_hosts` fails attach on all hosts per third-party reports on Chrome 155 behavior, unverified). Cannot be requested at runtime; install-time only, with a strong warning. | Ship the no-debugger slice first: structured DOM via content-script evidence tools, console via page listeners, timing via `webNavigation` plus in-page measurement. Add debugger only behind the explicit Phase-gated permission decision. |
| Tab targeting and metadata | `chrome.tabs` | `tabs` permission (declared) | `query`, `update`, `sendMessage` available with `<all_urls>` host access. | None needed. |
| Navigation and route-change tracking | `chrome.webNavigation` | `webNavigation` (declared) | Main-frame and sub-frame commit events for document-epoch tracking. | `tabs.onUpdated` as a coarser signal. |
| Network observation (non-blocking) | `chrome.webRequest` | `webRequest` (declared) | In MV3, observation only; no blocking. Already used by the preinject pipeline. | `declarativeNetRequestWithHostAccess` (declared) for rule-based handling; debugger Fetch/Network domains for full bodies (see debugger row). |
| Timers across worker suspension | `chrome.alarms` | `alarms` (declared) | Survives worker unload; clamped to a 30 second minimum. | `setTimeout` only while the worker is alive. |
| Ephemeral session state | `chrome.storage.session` | `storage` (declared) | MV3-only, in-memory, survives worker restarts within a browser session, cleared on browser exit. | `chrome.storage.local` for durable checkpoints. |
| Durable state | `chrome.storage.local` | `storage` + `unlimitedStorage` (declared) | Already the script store backend. | None needed. |
| Long-lived connections (if needed) | Offscreen documents | `offscreen` (declared) | For audio, DOM parsing, or sockets that must outlive the worker. | Service worker with heartbeat traffic; prefer not to need it. |
| Service worker lifecycle | n/a | n/a | Chrome terminates the worker when idle (commonly observed around 30 seconds; no fixed guarantee, do not hard-code the number). A single event or API call is capped (commonly ~5 minutes). Incoming events and API calls reset the idle timer, which is why the 20 second MCP heartbeat keeps the worker alive while connected. | Persist checkpoints; treat live handles as disposable; never keep the only copy of task state in module memory. |
| Identity / sync | `chrome.identity` | `identity` (declared) | Used by the existing `@usync` cloud-sync path. | Out of scope for agent work. |
| Clipboard, notifications, menus, cookies | n/a | `clipboardWrite`, `notifications`, `contextMenus`, `cookies` (declared) | Back the existing GM APIs. | None needed. |

## 13. Claude Code integration paths

Verified against current official documentation on 2026-10-14.

- **External workflow (supported today, no extension changes):** Claude Code speaks MCP natively. The upstream server README documents `claude mcp add violentmonkey -- npx -y @violentmonkey/mcp -p 5678` and the equivalent `mcpServers` JSON for stdio clients. Once the user completes the extension approval flow (section 6), Claude Code can list, read, write, enable, disable, and delete Curses through the existing tools. This path is backend-agnostic on the extension side and must keep working unchanged.
- **Embedded workflow (requires a local companion):** the supported programmatic surfaces are the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` for TypeScript, `claude-agent-sdk` for Python; documented at the official Agent SDK overview) and the CLI in non-interactive mode (`claude -p "prompt"` with `--output-format`, `--resume`, `--mcp-config`, and related flags; documented in the official headless/CLI reference). Both require a native process runtime: the SDK runs the agent loop in Node.js/Python, and the CLI is a local binary. A Chrome extension cannot spawn processes, so an in-extension Claude Code session is not a supported topology. The embedded adapter must talk to a local companion that hosts the SDK or CLI. Candidate companion shapes: a Native Messaging host (per-OS manifest install, highest friction), or a loopback HTTP service the extension calls (simpler install, must authenticate callers and bind loopback-only). The choice is a Phase 4 decision; Phase 0 records that a companion is required, not optional.
- **Sessions:** the SDK and CLI support continuing and resuming sessions by ID, which maps to the plan's session-recovery requirement. Session transcripts live outside the extension; the extension persists only its own checkpoint metadata and the backend session identifier.
- **Authentication:** the SDK reads `ANTHROPIC_API_KEY` or the Claude Code OAuth token from the environment. Per Anthropic's documented terms, third-party products should use API-key authentication rather than reselling claude.ai login rate limits. The plan already requires this: present Claude Code access and Anthropic API billing as distinct choices, never infer API entitlement from a subscription, and never extract credentials from another product.

## 14. Codex integration paths

Verified against current official and primary-source documentation on 2026-10-14.

- **External workflow (supported today, no extension changes):** Codex CLI supports MCP servers in `~/.codex/config.toml` under `[mcp_servers.<name>]`, for both stdio (`command`/`args`/`env`) and streamable HTTP (`url`, `bearer_token_env_var`, headers) servers, configurable via `codex mcp add <name> -- <command>` or by editing the file (official Codex MCP docs). The upstream `@violentmonkey/mcp` server can therefore be registered with Codex exactly as with Claude Code: stdio via `npx -y @violentmonkey/mcp -p 5678`, or HTTP transport with a fixed token. Phase 5 must use this documented mechanism, not a Claude-shaped config.
- **Embedded workflow (requires a local companion):** the supported programmatic surfaces are the Codex SDK (`@openai/codex-sdk` for TypeScript, Node 18+, with `startThread`/`resumeThread`/`run`; Python SDK experimental), the app server (`codex app-server`: persistent local JSON-RPC 2.0 over stdio/WebSocket/Unix socket, the same interface that powers the VS Code extension, with threads persisted as JSONL), and non-interactive `codex exec --json` (official app-server, SDK, and non-interactive docs). As with Claude Code, all of these require a native process runtime the extension does not have, so the embedded Codex adapter also goes through the local companion. The companion can share its transport and lifecycle code with the Claude path while keeping provider adapters separate.
- **Sessions:** threads persist as JSONL and support resume by ID, mapping to the plan's recovery requirement.
- **Authentication:** the user's installed Codex workflow: ChatGPT plan sign-in or `CODEX_API_KEY`. ChatGPT subscription quota and OpenAI API billing are separate; the extension must describe them as distinct choices and must not promise that a subscription authorizes arbitrary API calls.

## 15. Architecture decisions

Each decision records the chosen path, the alternatives considered, and the consequence. Unresolved items are collected in section 18, not buried here.

**D1: Reuse the upstream MCP server and pairing flow unchanged.**
Pin `@violentmonkey/mcp` 0.1.1 / protocol version 1 / tool negotiation as the compatibility contract. Extend the extension's registered handlers only where a measured gap exists. Alternatives: fork the server (rejected: diverges schemas, duplicates approval, loses upstream fixes); design a second pairing system (rejected by the spec's non-negotiables). Consequence: external Claude Code and Codex access works with zero extension changes; EvilMonkey must track upstream protocol changes and re-audit on version bumps.

**D2: Embedded agent sessions require a local companion; the extension never hosts an agent runtime.**
Observed vendor docs offer no in-browser session runtime for Claude Code or Codex. Alternatives: direct-API-only embedded sessions (kept as Phase 6, separate choice, not a substitute); extension-hosted WASM agent loop (rejected: no vendor support, fabricated capability). Consequence: the companion is a hard distribution dependency for the embedded workflows; its install, update, and uninstall story must be designed in Phase 4. The companion must not reimplement browser tools: it calls the extension's single tool service through one authenticated channel, and the policy gate applies equally to companion-driven and MCP-driven calls.

**D3: Chrome Side Panel hosts the persistent workspace; an extension page is the fallback.**
Side Panel needs only the `sidePanel` permission and `side_panel` manifest key at Chrome 114+, below the 135 floor, so no floor change. Alternatives: popup-only (rejected: popups close on focus loss and cannot host long sessions); full-tab workspace as primary (kept as fallback, not primary, because the side panel keeps the target page visible). Consequence: Phase 1 adds the permission and manifest key, verifies `sidePanel.open` gesture behavior, and builds the workspace against the existing Vue/options UI conventions.

**D4: No `debugger` permission in the first release.**
The permission cannot be requested as optional (verified in the official permissions reference), shows a strong install warning, detaches when DevTools opens, and is subject to enterprise policy blocks. Alternatives: request it upfront (rejected: warning cost and policy risk before the feature set justifies it); never use it (rejected: the advanced track legitimately needs network bodies and heap data). Consequence: the Phase 3 vertical slice ships on the no-debugger capability matrix; debugger-backed tools are an explicit, separately approved phase gate with their own UX, warning copy, and detach handling.

**D5: Candidate Curse tests run through the existing userscript engine, with test authorization separate from install authorization.**
Use `chrome.userScripts.execute` and temporary registrations for bounded test runs, then discard them; persistent install happens only after exact-revision approval. Alternatives: `chrome.scripting.executeScript` (rejected: ISOLATED world, different isolation semantics than the USER_SCRIPT world Curses run in); testing in the live persistent script (rejected: conflates test with install). Consequence: test fidelity matches production GM behavior by construction; the runner must still report what cannot be rolled back (network effects, server-side changes, downloads).

**D6: Session state is persisted in `chrome.storage` (session for ephemeral, local for checkpoints); tokens and live handles are never persisted.**
Follows the existing storage-bucket pattern. Alternatives: module-memory only (rejected: worker suspension loses tasks); persisting the MCP token for auto-reconnect (rejected: contradicts the upstream security model without explicit user consent). Consequence: the workspace can recover transcripts and checkpoints after worker death; reconnecting the MCP server remains a manual, approved step.

**D7: Direct Anthropic/OpenAI API backends are explicit, separately configured choices in Phase 6.**
User-supplied keys, model selection, usage display where the provider exposes it. Alternatives: inferring API access from CLI subscriptions (rejected: billing misrepresentation); extracting credentials from installed CLIs (rejected: credential theft by design). Consequence: backend failures never silently switch provider or cost basis.

**D8: Keep the Chrome 135 minimum until evidence supports changing it.**
The floor is traced to `chrome.userScripts.execute` (section 7). Alternatives: lower the floor and degrade `executeScript` (rejected: breaks the shared injection path the test runner depends on). Consequence: revisit only if the `execute()` usage can be isolated or Chrome backports it; Side Panel work does not affect the floor.

## 16. Security boundaries

- Website text, scripts, network responses, and existing Curses are untrusted inputs. They are evidence, never instructions. Tool descriptions stay server-defined (section 4).
- Provider credentials, MCP tokens, and (if ever approved) debugger control live in privileged extension or companion contexts. They are never exposed to Curses, page scripts, evidence payloads, or ordinary logs.
- Target scope defaults to the selected tab and origin. Expanding scope requires explicit approval. The policy gate enforces scope, tool risk, redaction, and exact-revision install binding; model output never overrides it.
- Redaction happens before evidence reaches any provider: no cookies, authorization headers, or full storage dumps by default.
- Install approval binds to the exact candidate revision (code plus metadata, match patterns, and grants). Any change invalidates the approval.
- Cancellation stops supported work; it cannot recall completed external actions. The UI must say which operations could not be recalled.
- The local companion, when built, must authenticate its extension channel, bind loopback-only, and never expose an unauthenticated control port.

## 17. Distribution assumptions

- First release is Chrome MV3 via unpacked load (documented steps) with Chrome Web Store packaging evaluated in Phase 7. Unpacked load requires Developer Mode; the `userScripts` permission additionally requires the user to flip "Allow User Scripts" in `chrome://extensions`, which cannot be automated.
- The 135 floor excludes older Chrome and all non-Chromium browsers for the MV3 build. Firefox remains on the MV2 path and is explicitly deferred.
- The local companion has no distribution story yet: Native Messaging host manifests are per-OS (registry keys on Windows, JSON manifests on macOS/Linux) and per-browser install locations. This is the largest unresolved distribution item and gates the embedded workflows, not the external MCP workflows.
- Upstream MCP server distribution rides on `npx @violentmonkey/mcp`, which requires Node.js on the agent machine. The extension does not bundle it and should not.

## 18. Unresolved items and risks

Explicit open items. Each names what is unknown and what would resolve it.

- **U1: Upstream MCP protocol evolution.** The audit pins `@violentmonkey/mcp` 0.1.1 and wire protocol 1. Upstream may add tools (e.g. the planned `script_logs`, `tab_eval`) or bump the protocol. Resolution: re-audit on every upstream version bump before adopting; the `hello`/`ready` negotiation absorbs additive changes, but new tools need policy-gate review.
- **U2: Companion transport and packaging.** Native Messaging vs loopback HTTP service is undecided (D2). Resolution: Phase 4 spike with install/uninstall/upgrade tested on the target OSes before the embedded adapter is built.
- **U3: `sidePanel.open` gesture rules.** The API and manifest requirements are verified; the exact user-gesture conditions for programmatic open across Chrome versions are not. Resolution: verify in Phase 1 against the 135 floor; design the workspace entry point (action click behavior) accordingly.
- **U4: Chrome 138 `userScripts` behavior.** `browser-scripts-api.js` branches its permission note at Chrome 138, but the platform change behind it was not verified in this audit. Resolution: test the Allow User Scripts flow on Chrome 135 through current stable during Phase 1 and document the exact UX.
- **U5: Debugger enterprise and version behavior.** Third-party sources report Chrome 155 all-or-nothing `runtime_blocked_hosts` enforcement for `chrome.debugger` and Chrome 136 ignoring `--remote-debugging-port` on the default profile. Not verified against primary sources in this audit. Resolution: verify before the debugger phase gate; treat as risk, not fact, until then.
- **U6: Codex app-server stability.** The app server is documented as the rich-client interface but described by third parties as experimental. Resolution: verify the current stability statement in the official app-server docs during Phase 5 planning; prefer the SDK surface that is documented as stable.
- **U7: Anthropic commercial terms for SDK use in a distributed product.** The docs direction is API-key auth for third-party products; the exact terms text was not re-read in this audit. Resolution: read the current Commercial Terms before Phase 4 ships anything that bundles or recommends the SDK.
- **U8: `chrome.storage.session` vs `local` split for session data.** The pattern is chosen (D6) but retention, quota, and privacy disclosures are not specified. Resolution: Phase 1 data-retention design.
- **U9: Exact upstream server version at implementation time.** This audit inspected upstream `main` on 2026-10-14 and the extension's pinned `^0.1.1` client. If implementation starts against a newer server release, re-run the tool-schema and protocol diff (sections 2 and 5) first.

## 19. References

Local sources inspected (paths in the `evilmonkey` repo unless noted):

- `docs/evilmonkey-extension-plan.md` (this audit's tasking document)
- `docs/EvilMonkey-Specification.md` (product spec; sections 2-4 confirm the Phase 0 requirements and the external-vs-embedded distinction)
- `violentmonkey/package.json`, `violentmonkey/scripts/manifest-helper.js`, `violentmonkey/src/manifest.yml`
- `violentmonkey/src/background/utils/mcp.js`, `violentmonkey/src/background/utils/tab-redirector.js`
- `violentmonkey/src/common/browser-scripts-api.js`, `violentmonkey/src/background/utils/preinject-core.js`
- `violentmonkey/src/background/utils/storage.js`, `violentmonkey/src/injected/web/gm-api.js`
- `violentmonkey/src/options/views/tab-settings/vm-mcp.vue`, `violentmonkey/DEVELOPMENT.md`
- Upstream `violentmonkey/mcp`: `README.md`, `docs/design.md`, `docs/protocol.md`, `docs/security.md`, `packages/protocol/src/tools.ts`, `packages/protocol/src/wire.ts`, `packages/client/src/index.ts`, package versions for `@violentmonkey/mcp`, `@violentmonkey/mcp-client`, `@violentmonkey/mcp-protocol` (0.1.1 each)

Official documentation checked 2026-10-14 (claim-level verification, not exhaustive re-reads):

- https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- https://developer.chrome.com/docs/extensions/reference/api/userScripts
- https://developer.chrome.com/docs/extensions/reference/api/debugger
- https://developer.chrome.com/docs/extensions/reference/api/permissions
- https://developer.chrome.com/extensions/debugger.html
- https://docs.anthropic.com/en/docs/claude-code/cli-usage
- https://docs.anthropic.com/en/docs/mcp
- https://developers.openai.com/codex/mcp
- https://developers.openai.com/codex/sdk
- https://developers.openai.com/codex/app-server
- https://developers.openai.com/codex/noninteractive

## Appendix: acceptance criteria mapping

- Gap analysis naming source files and the exact source revision: sections 1-11. Every claim cites its file; the revision is `de690ecdf923dc444f402b91c1c7d8edd471f31a` (Violentmonkey 2.49.0), verified upstream.
- MCP server vs extension MCP client responsibilities clearly separated: section 4, with the explicit statement that neither is an agent-session backend.
- Claude Code and Codex embedded-session integration paths backed by current official documentation: sections 13 and 14, with links and the companion requirement derived from the documented native-process requirement.
- Chrome tool capability matrix with permissions, limitations, and viable fallbacks: section 12.
- Architecture decisions with alternatives and unresolved items: sections 15 and 18.
