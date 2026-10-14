/**
 * EvilMonkey session, target, event, evidence-reference, artifact, and
 * candidate-revision models (Phase 1: Chrome Workspace and Shared Session
 * Foundation).
 *
 * These are plain data factories. Persistence lives in ./store.js, lifecycle
 * in ./orchestrator.js, and access rules in ./policy.js. Nothing here touches
 * Chrome APIs, so the models stay testable without a browser.
 */

export const SESSION_ACTIVE = 'active';
export const SESSION_STOPPED = 'stopped';
export const SESSION_COMPLETED = 'completed';
export const SESSION_FAILED = 'failed';
export const SESSION_INTERRUPTED = 'interrupted';

export const SESSION_STATUSES = [
  SESSION_ACTIVE,
  SESSION_STOPPED,
  SESSION_COMPLETED,
  SESSION_FAILED,
  SESSION_INTERRUPTED,
];

/** Tool risk levels enforced by the shared policy gate. */
export const RISK_READ = 'read';
export const RISK_WRITE = 'write';
export const RISK_DESTRUCTIVE = 'destructive';
export const RISK_PRIVILEGED = 'privileged';

export const TOOL_RISKS = [RISK_READ, RISK_WRITE, RISK_DESTRUCTIVE, RISK_PRIVILEGED];

/** Backends a session may be driven by. 'none' until Phase 4/5/6. */
export const BACKEND_NONE = 'none';
export const BACKEND_EXTERNAL_MCP = 'external-mcp';
export const BACKEND_EMBEDDED = 'embedded';

export function newId() {
  return crypto.randomUUID();
}

function now() {
  return Date.now();
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (e) {
    return '';
  }
}

/**
 * The page a session is scoped to. Scope defaults to the selected tab at
 * session creation; the orchestrator updates url/origin on navigation and the
 * policy gate treats origin changes as re-approval triggers.
 */
export function createTarget({ tabId, url = '', documentEpoch = 0 } = {}) {
  const origin = originOf(url);
  return {
    tabId,
    url,
    origin,
    /** origin at session start; the policy gate re-requires approval on change */
    originAtStart: origin,
    documentEpoch,
    /** set when the tab navigated or was replaced since the session started */
    changed: false,
    /** last observed change, for the workspace UI */
    lastChange: null,
  };
}

/**
 * A unit of agent work. Owns its target, budget, checkpoints, and approval
 * state. Live state lives in chrome.storage.session; checkpoints and the
 * session index live in chrome.storage.local (see ./store.js and D6).
 */
export function createSession({
  tabId,
  url = '',
  backend = BACKEND_NONE,
  budget = {},
} = {}) {
  const t = now();
  return {
    id: newId(),
    createdAt: t,
    updatedAt: t,
    status: SESSION_ACTIVE,
    /** why a non-active session left the active state */
    statusReason: '',
    backend,
    target: createTarget({ tabId, url }),
    budget: {
      maxSteps: budget.maxSteps ?? 200,
      maxEvents: budget.maxEvents ?? 2000,
      maxMs: budget.maxMs ?? 30 * 60 * 1000,
      stepsUsed: 0,
      eventsUsed: 0,
      startedAt: t,
    },
    stopRequested: false,
    /** operations in flight when stop was requested (for the recall report) */
    inFlight: [],
    /** exact-revision install approvals: { [revisionId]: { approvedAt } } */
    revisionApprovals: {},
    /** event tail, newest last; persisted to durable storage at checkpoints */
    events: [],
    checkpointCount: 0,
    lastCheckpointAt: 0,
  };
}

/**
 * A timestamped session fact. Events are evidence of what happened, never
 * instructions to any backend.
 */
export function createEvent(sessionId, type, details = {}) {
  return {
    id: newId(),
    sessionId,
    type,
    at: now(),
    details,
  };
}

/**
 * A pointer to observed page facts. References carry descriptors and hashes,
 * never raw page content, so persisted evidence stays small and redacted.
 */
export function createEvidenceRef({
  kind,
  description = '',
  hash = '',
  target = null,
  warnings = [],
} = {}) {
  return {
    id: newId(),
    kind,
    description,
    hash,
    target,
    warnings,
    at: now(),
  };
}

/**
 * A bounded binary or text blob produced during a session (screenshots,
 * dumps, diffs). Artifacts record size and provenance; large blobs stay out
 * of the event tail.
 */
export function createArtifact({
  kind,
  name = '',
  mimeType = 'application/octet-stream',
  size = 0,
  evidenceRefId = '',
} = {}) {
  return {
    id: newId(),
    kind,
    name,
    mimeType,
    size,
    evidenceRefId,
    at: now(),
  };
}

/**
 * A candidate Curse revision proposed for testing and install. Identity is
 * the SHA-256 of code plus normalized metadata, so any edit invalidates
 * prior approvals (exact-revision install binding).
 */
export async function createCandidateRevision({ code = '', metadata = {} } = {}) {
  const normalized = JSON.stringify({
    code,
    name: metadata.name || '',
    namespace: metadata.namespace || '',
    version: metadata.version || '',
    matches: [...(metadata.matches || [])].sort(),
    grants: [...(metadata.grants || [])].sort(),
  });
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(normalized));
  const id = [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return {
    id,
    code,
    metadata,
    createdAt: now(),
  };
}

/** Recompute a revision id to verify an approval still binds. */
export async function revisionIdOf({ code = '', metadata = {} } = {}) {
  return (await createCandidateRevision({ code, metadata })).id;
}
