/**
 * EvilMonkey session orchestrator (Phase 1: Chrome Workspace and Shared
 * Session Foundation).
 *
 * Backend-neutral session lifecycle: create, list, get, checkpoint, stop,
 * revision approval, and gated tool invocation. All state lives in storage
 * (see ./store.js) so sessions tolerate MV3 service worker suspension.
 * Recovery states distinguish sessions resumable from a checkpoint from
 * sessions lost before their first checkpoint.
 *
 * The existing MCP settings approval and explicit disconnect flow in
 * ../utils/mcp.js are untouched; no new tools are wired into the MCP server
 * path (D9 registration decision is still open).
 */

import browser from '@/common/browser';
import { getActiveTab } from '@/common';
import { addOwnCommands, initDependency } from '../utils/init';
import {
  BACKEND_NONE,
  RISK_READ,
  SESSION_ACTIVE,
  SESSION_FAILED,
  SESSION_INTERRUPTED,
  SESSION_STOPPED,
  createEvent,
  createSession,
} from './models';
import {
  approveRevision,
  checkInstallApproval,
  invokeTool,
  registerTool,
} from './policy';
import { getCapabilities } from './evidence';
import './runner';
import {
  buildInstallSource,
  createCandidate,
  lineDiff,
  scanExternalDestinations,
} from './curse';
import { parseScript } from '../utils/db';
import {
  getEventTail,
  getIndex,
  getLatestCheckpoint,
  getLiveSession,
  removeLiveSession,
  saveCheckpoint,
  saveLiveSession,
  updateIndexEntry,
} from './store';

function touch(session) {
  session.updatedAt = Date.now();
  return session;
}

async function appendEvent(session, type, details) {
  session.events.push(createEvent(session.id, type, details));
  session.budget.eventsUsed = session.events.length;
  if (session.events.length > 2000) {
    session.events = session.events.slice(-2000);
  }
}

/** Budget enforcement: exceeding any budget fails the session. */
function checkBudget(session) {
  const { budget } = session;
  if (budget.stepsUsed >= budget.maxSteps) return 'steps-exceeded';
  if (budget.eventsUsed >= budget.maxEvents) return 'events-exceeded';
  if (Date.now() - budget.startedAt >= budget.maxMs) return 'time-exceeded';
  return '';
}

async function failOnBudget(session) {
  const reason = checkBudget(session);
  if (!reason) return false;
  session.status = SESSION_FAILED;
  session.statusReason = `budget-${reason}`;
  await appendEvent(touch(session), 'budget-exceeded', { reason });
  await saveLiveSession(session);
  await updateIndexEntry(session, session.checkpointCount > 0);
  return true;
}

async function resolveTargetTab(tabId) {
  if (tabId != null) {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (tab) return tab;
  }
  // Session scope defaults to the selected tab.
  const tab = await getActiveTab().catch(() => null);
  return tab;
}

/** @namespace Commands */
addOwnCommands({
  /** Create a session scoped to the given tab, or the selected tab. */
  async EvmSessionCreate({ tabId, budget } = {}) {
    const tab = await resolveTargetTab(tabId);
    if (!tab) throw new Error('No target tab available');
    const session = createSession({
      tabId: tab.id,
      url: tab.pendingUrl || tab.url || '',
      backend: BACKEND_NONE,
      budget,
    });
    // Session start report: distinguish available, unavailable, and
    // not-yet-instrumented capabilities (Phase 2 acceptance criterion).
    // Best-effort: a failed probe must not fail session creation.
    let capabilities = null;
    try {
      const caps = await getCapabilities(session);
      capabilities = {
        available: caps.items.filter(i => i.status === 'available').map(i => i.name),
        unavailable: caps.items.filter(i => i.status === 'unavailable').map(i => i.name),
        notInstrumented: caps.items.filter(i => i.status === 'not-instrumented').map(i => i.name),
      };
    } catch (e) {
      capabilities = { error: `${e?.message || e}` };
    }
    await appendEvent(session, 'session-created', {
      tabId: tab.id,
      url: session.target.url,
      epoch: session.target.documentEpoch,
      capabilities,
    });
    await saveLiveSession(session);
    await updateIndexEntry(session, false);
    return session;
  },

  /** List known sessions with their recovery state. */
  async EvmSessionList() {
    const index = await getIndex();
    return Object.values(index).sort((a, b) => b.updatedAt - a.updatedAt);
  },

  /** Full session detail, including recovery info for interrupted sessions. */
  async EvmSessionGet({ id } = {}) {
    const session = await getLiveSession(id);
    if (session) {
      return { session, recovery: 'live', eventTail: [] };
    }
    const index = await getIndex();
    const entry = index[id];
    if (!entry) return null;
    const checkpoint = await getLatestCheckpoint(id);
    return {
      session: checkpoint,
      recovery: checkpoint ? 'recoverable' : 'unrecoverable',
      eventTail: checkpoint ? await getEventTail(id) : [],
    };
  },

  /** Persist a durable checkpoint of the session. */
  async EvmSessionCheckpoint({ id } = {}) {
    const session = await getLiveSession(id);
    if (!session) throw new Error('No live session');
    const n = await saveCheckpoint(session);
    session.checkpointCount = n;
    session.lastCheckpointAt = Date.now();
    await appendEvent(touch(session), 'checkpoint', { seq: n });
    await saveLiveSession(session);
    await updateIndexEntry(session, true);
    return { seq: n };
  },

  /**
   * Stop an active task. Cancellation cannot recall completed external
   * actions, so the response reports which in-flight operations were
   * cancelled and which effects could not be recalled.
   */
  async EvmSessionStop({ id, reason = 'user-requested' } = {}) {
    const session = await getLiveSession(id);
    if (!session) throw new Error('No live session');
    session.stopRequested = true;
    const inFlight = session.inFlight || [];
    const recalled = inFlight.filter(op => !op.done && !op.externalEffect)
      .map(op => op.id);
    const notRecalled = inFlight
      .filter(op => op.done || op.externalEffect)
      .map(op => ({
        id: op.id,
        tool: op.tool,
        reason: op.done
          ? 'operation already completed'
          : 'external effects cannot be recalled after dispatch',
      }));
    session.inFlight = [];
    session.status = SESSION_STOPPED;
    session.statusReason = reason;
    await appendEvent(touch(session), 'session-stopped', {
      reason,
      recalled: recalled.length,
      notRecalled: notRecalled.length,
    });
    await saveLiveSession(session);
    await updateIndexEntry(session, session.checkpointCount > 0);
    return { stopped: true, recalled, notRecalled };
  },

  /** Bind an install approval to an exact candidate revision id. */
  async EvmSessionApproveRevision({ id, revisionId } = {}) {
    if (!revisionId) throw new Error('revisionId is required');
    return { approved: await approveRevision(id, revisionId) };
  },

  /** Install gate check: only an approved exact revision passes. */
  async EvmSessionCheckInstall({ id, revisionId } = {}) {
    return checkInstallApproval(id, revisionId);
  },

  /**
   * Create a candidate Curse revision on a session. Links an optional
   * parent revision and repair context (failed assertion evidence) so a
   * failed assertion can feed a revision cycle: fail -> evidence ->
   * new revision -> re-test.
   */
  async EvmCandidateCreate({
    id, code, metadata, assertions, parentRevisionId, repairContext,
  } = {}) {
    const session = await getLiveSession(id);
    if (!session) throw new Error('No live session');
    if (session.status !== SESSION_ACTIVE) {
      throw new Error(`session-not-active:${session.status}`);
    }
    if (!code) throw new Error('code is required');
    const candidate = await createCandidate({
      code: String(code),
      metadata: metadata || {},
      assertions: assertions || [],
      parentRevisionId: parentRevisionId || '',
      repairContext: repairContext || null,
    });
    session.candidates = session.candidates || {};
    session.candidates[candidate.id] = candidate;
    await appendEvent(touch(session), 'candidate-created', {
      revisionId: candidate.id.slice(0, 12),
      parent: (parentRevisionId || '').slice(0, 12) || null,
      repairsFailure: !!repairContext,
      assertionCount: candidate.assertions.length,
    });
    await saveLiveSession(session);
    return { revisionId: candidate.id, metadata: candidate.metadata };
  },

  /** List candidate revision summaries for a session. */
  async EvmCandidateList({ id } = {}) {
    const session = await getLiveSession(id);
    if (!session) return [];
    return Object.values(session.candidates || {}).map(c => ({
      id: c.id,
      name: c.metadata.name,
      version: c.metadata.version,
      createdAt: c.createdAt,
      parentRevisionId: c.parentRevisionId || null,
      repairsFailure: !!c.repairContext,
      testCount: (c.testReports || []).length,
      lastTestAt: c.testReports && c.testReports.length
        ? c.testReports[c.testReports.length - 1].at
        : 0,
      installed: !!c.installed,
    })).sort((a, b) => b.createdAt - a.createdAt);
  },

  /**
   * Full candidate detail for the approval UI: code (or diff against the
   * parent revision), metadata, grants, matched sites, heuristic external
   * destinations, assertions with their latest results, test reports, and
   * the current authorization states.
   */
  async EvmCandidateGet({ id, revisionId } = {}) {
    const session = await getLiveSession(id);
    if (!session) throw new Error('No live session');
    const candidate = session.candidates && session.candidates[revisionId];
    if (!candidate) throw new Error(`unknown revision: ${revisionId}`);
    const parent = candidate.parentRevisionId
      && session.candidates[candidate.parentRevisionId];
    return {
      id: candidate.id,
      metadata: candidate.metadata,
      assertions: candidate.assertions,
      parentRevisionId: candidate.parentRevisionId || null,
      repairContext: candidate.repairContext,
      testReports: candidate.testReports || [],
      installed: candidate.installed,
      createdAt: candidate.createdAt,
      code: candidate.code,
      parentCode: parent ? parent.code : null,
      diff: parent ? lineDiff(parent.code, candidate.code) : null,
      externalDestinations: scanExternalDestinations(candidate.code),
      testAuthorized: !!(session.testApprovals && session.testApprovals[revisionId]),
      installApproved: !!(session.revisionApprovals && session.revisionApprovals[revisionId]),
    };
  },

  /**
   * Explicit test authorization for one candidate revision. Recorded
   * separately from install approval: authorizing a test run never
   * implies install approval.
   */
  async EvmTestAuthorize({ id, revisionId } = {}) {
    if (!revisionId) throw new Error('revisionId is required');
    const session = await getLiveSession(id);
    if (!session || session.status !== SESSION_ACTIVE) {
      return { authorized: false };
    }
    if (!session.candidates || !session.candidates[revisionId]) {
      throw new Error(`unknown revision: ${revisionId}`);
    }
    session.testApprovals = session.testApprovals || {};
    session.testApprovals[revisionId] = { approvedAt: Date.now() };
    await appendEvent(touch(session), 'test-authorized', {
      revisionId: revisionId.slice(0, 12),
    });
    await saveLiveSession(session);
    return { authorized: true };
  },

  /**
   * Install a candidate as a persistent userscript through the
   * baseline script store. The gate is enforced here, in code, not just
   * in the UI: without an approval bound to this exact revision id,
   * installation is refused.
   */
  async EvmCurseInstall({ id, revisionId } = {}) {
    const gate = await checkInstallApproval(id, revisionId);
    if (!gate.allowed) {
      throw new Error(
        `install-refused:${gate.reason}; installation requires approval of the exact displayed revision and its permissions`,
      );
    }
    const session = await getLiveSession(id);
    const candidate = session.candidates && session.candidates[revisionId];
    if (!candidate) throw new Error(`unknown revision: ${revisionId}`);
    const source = buildInstallSource(candidate);
    let result;
    try {
      result = await parseScript({
        code: source,
        message: '',
        bumpDate: true,
        reloadTab: false,
        config: { enabled: 1 },
      });
    } catch (e) {
      throw new Error(`install failed: ${e && e.message ? e.message : e}`);
    }
    candidate.installed = {
      scriptId: result.where.id,
      installedAt: Date.now(),
      revisionId,
    };
    await appendEvent(touch(session), 'curse-installed', {
      revisionId: revisionId.slice(0, 12),
      scriptId: result.where.id,
    });
    await saveLiveSession(session);
    await updateIndexEntry(session, session.checkpointCount > 0);
    return { installed: true, scriptId: result.where.id };
  },

  /**
   * Gated tool invocation for the workspace and future backends.
   * Every tool call passes through the shared policy gate.
   */
  async EvmToolInvoke({ sessionId, tool, args } = {}) {
    const session = await getLiveSession(sessionId);
    if (!session) return { ok: false, reason: 'no-session' };
    if (await failOnBudget(session)) {
      return { ok: false, reason: `session-not-active:${session.status}` };
    }
    const res = await invokeTool(sessionId, tool, args, {
      tabId: session.target.tabId,
      origin: session.target.origin,
    });
    const fresh = await getLiveSession(sessionId);
    if (fresh) {
      await appendEvent(touch(fresh), 'tool-invoked', { tool, ok: res.ok });
      await saveLiveSession(fresh);
      await failOnBudget(fresh);
    }
    return res;
  },
});

/**
 * Internal read-only tool used by the workspace to describe the session
 * target. Registered through the same gate every future tool must use.
 */
registerTool('target.describe', {
  risk: RISK_READ,
  async invoke(args, { session }) {
    const tab = await browser.tabs.get(session.target.tabId).catch(() => null);
    return {
      tabId: session.target.tabId,
      url: session.target.url,
      origin: session.target.origin,
      changed: session.target.changed,
      epoch: session.target.documentEpoch,
      live: !!tab,
      liveUrl: tab ? tab.pendingUrl || tab.url || '' : '',
    };
  },
});

/**
 * Track navigation on session target tabs. URL/origin changes update the
 * target, record an event, bump the document epoch (so evidence refs from
 * the old document fail clearly as stale), and (on origin change) arm the
 * policy gate's re-approval requirement for further tool use.
 */
function watchTargets() {
  const noteNavigation = async ({ tabId, url, frameId }, via) => {
    if (frameId !== 0 || !url) return;
    const index = await getIndex();
    for (const entry of Object.values(index)) {
      if (entry.status !== SESSION_ACTIVE) continue;
      const session = await getLiveSession(entry.id);
      if (!session || session.target.tabId !== tabId) continue;
      if (session.target.url === url) continue;
      const prevOrigin = session.target.origin;
      try {
        session.target.origin = new URL(url).origin;
      } catch (e) {
        session.target.origin = '';
      }
      session.target.url = url;
      session.target.changed = true;
      session.target.documentEpoch += 1;
      session.target.lastChange = {
        at: Date.now(),
        via,
        originChanged: prevOrigin !== session.target.origin,
      };
      await appendEvent(touch(session), 'target-changed', {
        url,
        via,
        epoch: session.target.documentEpoch,
        originChanged: session.target.lastChange.originChanged,
      });
      await saveLiveSession(session);
    }
  };
  if (chrome.webNavigation?.onCommitted) {
    chrome.webNavigation.onCommitted.addListener(details => noteNavigation(details, 'committed'));
  } else if (browser.tabs?.onUpdated) {
    browser.tabs.onUpdated.addListener((tabId, info) => {
      if (info.url) noteNavigation({ tabId, url: info.url, frameId: 0 }, 'tabs-updated');
    });
  }
  // SPA route changes do not commit a new document, but they replace the
  // content evidence was collected against, so they bump the epoch too.
  // The url guard inside noteNavigation keeps back/forward (which may fire
  // both events) from double-bumping.
  if (chrome.webNavigation?.onHistoryStateUpdated) {
    chrome.webNavigation.onHistoryStateUpdated.addListener(
      details => noteNavigation(details, 'history'));
  }
}

/**
 * Reconcile after worker startup: sessions marked active in the durable
 * index but missing from session storage were interrupted by a browser
 * restart (session storage is cleared on browser exit). Mark them
 * interrupted with their recovery state; live ones keep running.
 */
async function reconcileOnStartup() {
  const index = await getIndex();
  for (const entry of Object.values(index)) {
    if (entry.status !== SESSION_ACTIVE) continue;
    const live = await getLiveSession(entry.id);
    if (live) continue;
    const checkpoint = await getLatestCheckpoint(entry.id);
    entry.status = SESSION_INTERRUPTED;
    entry.updatedAt = Date.now();
    entry.recoverable = !!checkpoint;
    entry.statusReason = checkpoint
      ? 'worker-restart:recoverable-from-checkpoint'
      : 'worker-restart:no-checkpoint';
    const fresh = await getIndex();
    fresh[entry.id] = entry;
    // Direct write to avoid re-pruning mid-loop.
    await browser.storage.local.set({ 'evm:index': fresh });
  }
}

async function initEvm() {
  watchTargets();
  await reconcileOnStartup();
}

initDependency(initEvm());

