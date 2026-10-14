/**
 * EvilMonkey shared policy gate (Phase 1).
 *
 * This is the single choke point for agent and browser tool access. Both the
 * external MCP path and future embedded backends must route tool calls
 * through invokeTool; no tool may bypass it. Per D9 the registration decision
 * for exposing new tools over external MCP is still open, so this module is
 * backend-neutral: it knows nothing about MCP, Claude Code, or Codex.
 *
 * Enforced rules:
 * 1. Session must exist and be active.
 * 2. Selected-tab scope: the call target must be the session's target tab.
 * 3. Origin changes since session start require explicit re-approval.
 * 4. Tool risk levels: read/write are allowed (write is redacted),
 *    destructive/privileged require explicit approval.
 * 5. Redaction: sensitive fields are stripped before any payload reaches a
 *    provider or durable storage.
 * 6. Exact-revision install binding: an install approval is bound to the
 *    SHA-256 revision id; any code or metadata change invalidates it.
 */

import {
  RISK_DESTRUCTIVE,
  RISK_PRIVILEGED,
  RISK_READ,
  RISK_WRITE,
  SESSION_ACTIVE,
  TOOL_RISKS,
} from './models';
import { redactForProvider } from './redact';
import { getLiveSession, saveLiveSession } from './store';

export { redactForProvider };

/** Tools registered for gated invocation. Backend-neutral by design. */
const tools = new Map();

/**
 * @param {string} name
 * @param {{ risk: string, invoke: (args: Object, ctx: { session: Object }) => Promise<?> }} def
 */
export function registerTool(name, { risk, invoke }) {
  if (!TOOL_RISKS.includes(risk)) {
    throw new Error(`Unknown tool risk level: ${risk}`);
  }
  if (typeof invoke !== 'function') {
    throw new Error(`Tool ${name} has no invoke function`);
  }
  tools.set(name, { risk, invoke });
}

export function listTools() {
  return [...tools.keys()];
}

/**
 * Evaluate a tool call against the session policy without executing it.
 * @returns {{ allowed: boolean, reason?: string, requiresApproval?: string, redactedArgs?: Object }}
 */
export function checkPolicy(session, { tool, risk, tabId, origin, args }) {
  if (!session) {
    return { allowed: false, reason: 'no-session' };
  }
  if (session.status !== SESSION_ACTIVE) {
    return { allowed: false, reason: `session-not-active:${session.status}` };
  }
  if (session.stopRequested) {
    return { allowed: false, reason: 'stop-requested' };
  }
  // Selected-tab scope: the session is bound to its target tab.
  if (tabId != null && session.target && tabId !== session.target.tabId) {
    return { allowed: false, reason: 'target-tab-changed' };
  }
  // Origin changes require explicit re-approval before further tool use.
  // Compared against the origin at session start, not the current target
  // origin, so navigation cannot silently re-scope the session.
  const startOrigin = session.target && (session.target.originAtStart || session.target.origin);
  if (origin && startOrigin && origin !== startOrigin) {
    return { allowed: false, requiresApproval: 'origin-change', reason: 'origin-changed' };
  }
  if (risk === RISK_DESTRUCTIVE || risk === RISK_PRIVILEGED) {
    return { allowed: false, requiresApproval: 'risk', reason: `risk:${risk}` };
  }
  if (risk !== RISK_READ && risk !== RISK_WRITE) {
    return { allowed: false, reason: `unknown-risk:${risk}` };
  }
  return { allowed: true, redactedArgs: redactForProvider(args || {}) };
}

/**
 * The single gated entry point for tool invocation. Every backend, present
 * and future, calls this; tools cannot be reached any other way.
 */
export async function invokeTool(sessionId, name, args = {}, callCtx = {}) {
  const tool = tools.get(name);
  if (!tool) {
    return { ok: false, reason: 'unknown-tool' };
  }
  const session = await getLiveSession(sessionId);
  const decision = checkPolicy(session, {
    tool: name,
    risk: tool.risk,
    tabId: callCtx.tabId ?? session?.target?.tabId,
    origin: callCtx.origin,
    args,
  });
  if (!decision.allowed) {
    return { ok: false, ...decision };
  }
  const op = {
    id: `op-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    tool: name,
    risk: tool.risk,
    at: Date.now(),
    externalEffect: tool.risk !== RISK_READ,
    done: false,
  };
  session.inFlight.push(op);
  session.budget.stepsUsed += 1;
  await saveLiveSession(session);
  try {
    const data = await tool.invoke(decision.redactedArgs, { session });
    op.done = true;
    return { ok: true, data };
  } catch (err) {
    return { ok: false, reason: 'tool-error', message: `${err?.message || err}` };
  } finally {
    const fresh = await getLiveSession(sessionId);
    if (fresh) {
      fresh.inFlight = fresh.inFlight.filter(o => o.id !== op.id);
      fresh.updatedAt = Date.now();
      await saveLiveSession(fresh);
    }
  }
}

/**
 * Bind an install approval to an exact candidate revision. Any code or
 * metadata change produces a new revision id and invalidates the approval.
 */
export async function approveRevision(sessionId, revisionId) {
  const session = await getLiveSession(sessionId);
  if (!session || session.status !== SESSION_ACTIVE) return false;
  session.revisionApprovals[revisionId] = { approvedAt: Date.now() };
  session.updatedAt = Date.now();
  await saveLiveSession(session);
  return true;
}

/** The install gate: only an approved exact revision may be installed. */
export async function checkInstallApproval(sessionId, revisionId) {
  const session = await getLiveSession(sessionId);
  if (!session || session.status !== SESSION_ACTIVE) {
    return { allowed: false, reason: 'session-not-active' };
  }
  if (!session.revisionApprovals[revisionId]) {
    return { allowed: false, reason: 'revision-not-approved' };
  }
  return { allowed: true };
}
