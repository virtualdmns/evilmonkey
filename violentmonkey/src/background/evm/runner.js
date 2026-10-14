/**
 * EvilMonkey bounded Curse test runner (Phase 3: Curse Draft, Bounded
 * Test, and Approval Vertical Slice).
 *
 * The runner executes a candidate revision against the session target
 * using the existing chrome.userScripts engine, in the same USER_SCRIPT
 * world production Curses run in, then discards the temporary
 * registration. It never touches the persistent script store; install
 * is a separate, explicitly approved step (see EvmCurseInstall).
 *
 * D5 honesty rule: sharing the USER_SCRIPT world and engine is a strong
 * starting point for test fidelity, but it is a hypothesis, not a
 * completed compatibility proof. Every test report carries the
 * eight-dimension verification matrix and labels overall fidelity
 * 'unverified' until every dimension passes. Nothing here claims
 * production equivalence by construction.
 *
 * Irreversible effects: the runner removes its temporary registration
 * (verified) but does NOT revert DOM mutations, network requests,
 * downloads, or server-side changes the candidate made. The report says
 * so explicitly, and the workspace UI repeats it before install.
 */

import { RISK_WRITE } from './models';
import { registerTool } from './policy';
import { getLiveSession, saveLiveSession } from './store';
import {
  ASSERT_INCONCLUSIVE,
  ASSERT_NOT_RUN,
  createCandidate,
  markNotRun,
  parseMetablock,
  scoreAssertion,
} from './curse';

/** Short id for temporary registrations; never collides with real scripts. */
function tempScriptId() {
  return `evm-test-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function normalizeRunAt(runAt) {
  const v = String(runAt || 'document_idle').replace(/-/g, '_');
  return v === 'document_start' || v === 'document_end' || v === 'document_idle'
    ? v
    : 'document_idle';
}

function matchesFor(session, metadata) {
  if (metadata.matches && metadata.matches.length) return [...metadata.matches];
  const origin = session.target.origin;
  return origin ? [`${origin}/*`] : ['<all_urls>'];
}

function userScriptsAvailable() {
  return !!(chrome.userScripts && chrome.userScripts.register && chrome.userScripts.execute);
}

/**
 * Page-side assertion evaluator. Runs in the USER_SCRIPT world via
 * chrome.userScripts.execute, the same world the candidate ran in.
 * Fully self-contained: plain function/var only, no module references.
 * `new Function` is used for the js-eval kind; the baseline configures
 * the USER_SCRIPT world CSP with 'unsafe-eval', and any failure degrades
 * to INCONCLUSIVE rather than breaking the run.
 */
function evmEvaluateAssertion(assertion) {
  function visible(el) {
    try {
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      var cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    } catch (e) {
      return false;
    }
  }
  function all(selector) {
    try {
      return document.querySelectorAll(selector || '___evm_never_matches___');
    } catch (e) {
      throw new Error('invalid selector: ' + selector);
    }
  }
  var ev = {};
  switch (assertion.kind) {
    case 'selector-hidden': {
      var h = all(assertion.selector);
      var hv = 0;
      for (var i = 0; i < h.length; i++) if (visible(h[i])) hv++;
      ev = { selector: assertion.selector, matchedTotal: h.length, matchedVisible: hv };
      break;
    }
    case 'selector-count': {
      var c = all(assertion.selector);
      ev = { selector: assertion.selector, matchedTotal: c.length };
      break;
    }
    case 'selector-visible': {
      var v = all(assertion.selector);
      var vv = 0;
      for (var j = 0; j < v.length; j++) if (visible(v[j])) vv++;
      ev = { selector: assertion.selector, matchedTotal: v.length, matchedVisible: vv };
      break;
    }
    case 'selector-text': {
      var el = null;
      try {
        el = document.querySelector(assertion.selector || '___evm_never_matches___');
      } catch (e) {
        throw new Error('invalid selector: ' + assertion.selector);
      }
      ev = {
        selector: assertion.selector,
        found: !!el,
        text: el ? String(el.textContent || '').slice(0, 500) : '',
      };
      break;
    }
    case 'js-eval': {
      var fn;
      try {
        fn = new Function('document', 'window', '"use strict"; return (' + assertion.js + ')');
      } catch (e) {
        throw new Error('invalid js snippet: ' + (e && e.message));
      }
      var val = fn(document, window);
      ev = { value: !!val, raw: String(val).slice(0, 500) };
      break;
    }
    default:
      throw new Error('unknown assertion kind: ' + assertion.kind);
  }
  return ev;
}

/** Serialize the evaluator plus one assertion into executable code.
 * The evaluated script resolves to { evidence } or { error }; execute
 * rejections are also caught by the caller and degrade to INCONCLUSIVE. */
function evaluatorCode(assertion) {
  const payload = JSON.stringify(assertion).replace(/<\/script/gi, '<\\/script');
  return `(function(){ try { return { evidence: (${evmEvaluateAssertion.toString()})(${payload}) }; } catch (e) { return { error: String((e && e.message) || e) }; } })();`;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}-timeout`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The D5 verification matrix. Each dimension reports verified,
 * unverified, or not-applicable with the reason. Only dimensions the
 * runner can actually demonstrate programmatically are marked verified;
 * everything else stays unverified with a note on what live testing
 * would demonstrate. The overall status is 'verified' only when every
 * applicable dimension passes.
 */
export function checkFidelity(candidate, runCtx) {
  const meta = parseMetablock(candidate.code);
  const declaresRequire = !!(meta && meta.require && meta.require.length);
  const declaresResource = !!(meta && meta.resources && meta.resources.length);
  const matrix = [
    {
      dimension: 'GM APIs',
      status: 'unverified',
      detail: 'Temporary execution runs raw candidate code in the USER_SCRIPT world without the Violentmonkey GM API bindings. A candidate calling GM_* functions throws ReferenceError during the test; the runner surfaces that as INCONCLUSIVE, it does not shim the APIs. Demonstrate by running a GM-using candidate in test and in persistent install and comparing.',
    },
    {
      dimension: '@require',
      status: 'unverified',
      detail: declaresRequire
        ? 'Candidate declares @require entries and the bounded runner does not fetch or inject them.'
        : 'Runner does not load @require scripts; equivalence with production load order and timing is not demonstrated.',
    },
    {
      dimension: '@resource',
      status: 'unverified',
      detail: declaresResource
        ? 'Candidate declares @resource entries and the bounded runner does not resolve them.'
        : 'Runner provides no resource resolution; GM_getResourceText/URL behavior is not demonstrated.',
    },
    {
      dimension: 'grants',
      status: 'unverified',
      detail: 'Grant enforcement (including @grant none semantics) is Violentmonkey engine behavior. Raw temporary registration does not enforce the candidate grant set; the runner records grants but cannot prove identical enforcement.',
    },
    {
      dimension: 'run timing',
      status: 'unverified',
      detail: `Runner executes immediately for observation and registers the temporary script with runAt=${runCtx.runAt}. Equivalence of document_start/document_end/document_idle and injectImmediately behavior with production install is not demonstrated.`,
    },
    {
      dimension: 'frames',
      status: 'unverified',
      detail: `Runner executes on the main frame (frameIds [0]); registration passes allFrames=${runCtx.allFrames} through. Per-frame isolation and allFrames targeting equivalence are not demonstrated.`,
    },
    {
      dimension: 'cleanup',
      status: runCtx.cleanupVerified ? 'verified' : 'unverified',
      detail: runCtx.cleanupVerified
        ? 'Temporary registration was unregistered and absence confirmed via chrome.userScripts.getScripts.'
        : 'Cleanup verification did not complete; the temporary registration state is unknown.',
    },
    {
      dimension: 'navigation',
      status: 'unverified',
      detail: 'The bounded run does not test reload or SPA route-change behavior of the candidate. Reload semantics are documented (unregister removes the registration, so reload does not re-run the candidate) but not demonstrated against production.',
    },
  ];
  const applicable = matrix.filter(m => m.status !== 'not-applicable');
  const status = applicable.every(m => m.status === 'verified') ? 'verified' : 'unverified';
  return { status, matrix };
}

/**
 * Run one bounded test of a candidate revision.
 * @returns the test report (also appended to candidate.testReports).
 */
export async function runCandidateTest(session, candidate, { timeoutMs = 10000 } = {}) {
  const startedAt = Date.now();
  const startEpoch = session.target.documentEpoch;
  const startUrl = session.target.url;
  const report = {
    id: `test-${Date.now().toString(36)}`,
    sessionId: session.id,
    revisionId: candidate.id,
    at: startedAt,
    epoch: startEpoch,
    url: startUrl,
    lifecycle: {
      authorized: false,
      registered: false,
      executed: false,
      unregistered: false,
      cleanupVerified: false,
    },
    assertions: [],
    fidelity: { status: 'unverified', matrix: [] },
    irreversible: {
      cleanedUp: [],
      notReverted: [
        'DOM mutations made by the candidate persist until the page is reloaded; the runner does not snapshot or restore the DOM.',
        'Network requests, downloads, and server-side changes made during the test cannot be rolled back.',
      ],
      declared: [...(candidate.metadata.sideEffects || [])],
    },
    limitations: [
      'Test fidelity is unverified (see matrix); do not treat results as production-equivalent.',
      'The candidate ran in the USER_SCRIPT world without Violentmonkey GM API bindings.',
      'Reloading the page after the test does not re-run the candidate: the temporary registration is removed at test end.',
    ],
    warnings: [],
  };

  // Explicit test authorization, separate from install approval.
  if (!session.testApprovals || !session.testApprovals[candidate.id]) {
    throw new Error('test-not-authorized: run EvmTestAuthorize for this revision first; test authorization never implies install approval');
  }
  report.lifecycle.authorized = true;

  if (!userScriptsAvailable()) {
    throw new Error('userscripts-unavailable: chrome.userScripts is not available; the user must enable "Allow User Scripts" in chrome://extensions');
  }

  const meta = parseMetablock(candidate.code);
  if (meta && ((meta.require && meta.require.length) || (meta.resources && meta.resources.length))) {
    report.warnings.push('candidate declares @require/@resource entries, which the bounded runner does not load; related assertions may fail for that reason alone');
  }

  const runAt = normalizeRunAt(candidate.metadata.runAt);
  const matches = matchesFor(session, candidate.metadata);
  const scriptId = tempScriptId();
  const runCtx = { runAt, allFrames: !!candidate.metadata.allFrames, cleanupVerified: false };

  const currentEpoch = async () => {
    const fresh = await getLiveSession(session.id);
    return fresh ? fresh.target.documentEpoch : startEpoch;
  };

  try {
    // 1. Temporary registration (lifecycle path; takes effect on navigation).
    await chrome.userScripts.register([{
      id: scriptId,
      js: [{ code: candidate.code }],
      matches,
      runAt,
      allFrames: !!candidate.metadata.allFrames,
    }]);
    report.lifecycle.registered = true;

    // 2. Immediate execution in the current document (observation path).
    const execRes = await withTimeout(
      chrome.userScripts.execute({
        js: [{ code: candidate.code }],
        injectImmediately: true,
        target: { tabId: session.target.tabId, frameIds: [0] },
      }),
      timeoutMs,
      'candidate-execute',
    ).catch(err => ({ __evmError: `${err && err.message ? err.message : err}` }));
    if (execRes && execRes.__evmError) {
      report.warnings.push(`candidate execution reported an error: ${execRes.__evmError}; assertions still evaluated against the observed page`);
    }
    report.lifecycle.executed = true;

    // 3. Evaluate assertions, epoch-guarded.
    const results = [];
    for (const assertion of candidate.assertions) {
      const epochNow = await currentEpoch();
      const conditions = { epoch: startEpoch, url: startUrl, frameId: 0 };
      if (epochNow !== startEpoch) {
        results.push(...markNotRun([assertion], 'epoch-changed: the page navigated mid-test; evidence from this document no longer applies', conditions));
        continue;
      }
      let observed;
      try {
        const res = await withTimeout(
          chrome.userScripts.execute({
            js: [{ code: evaluatorCode(assertion) }],
            injectImmediately: true,
            target: { tabId: session.target.tabId, frameIds: [0] },
          }),
          timeoutMs,
          'assertion-eval',
        );
        const value = Array.isArray(res) ? res[0] && res[0].result : undefined;
        observed = { evidence: value && value.evidence ? value.evidence : {}, error: value && value.error ? value.error : '', conditions };
        if (!value) {
          observed = { evidence: {}, error: 'evaluator returned no result', conditions };
        }
      } catch (err) {
        observed = { evidence: {}, error: `${err && err.message ? err.message : err}`, conditions };
      }
      results.push(scoreAssertion(assertion, observed));
    }
    report.assertions = results;
  } finally {
    // 4. Cleanup: always unregister, then verify absence.
    try {
      await chrome.userScripts.unregister({ ids: [scriptId] });
      report.lifecycle.unregistered = true;
    } catch (e) {
      report.warnings.push(`unregister failed: ${e && e.message ? e.message : e}; the temporary script may still be registered`);
    }
    try {
      const remaining = await chrome.userScripts.getScripts({ ids: [scriptId] });
      runCtx.cleanupVerified = Array.isArray(remaining) && remaining.length === 0;
      report.lifecycle.cleanupVerified = runCtx.cleanupVerified;
      if (runCtx.cleanupVerified) {
        report.irreversible.cleanedUp.push('temporary userscript registration removed (verified via getScripts)');
      } else {
        report.warnings.push('cleanup unverified: the temporary registration may still exist');
      }
    } catch (e) {
      report.warnings.push(`cleanup verification failed: ${e && e.message ? e.message : e}`);
    }
  }

  report.fidelity = checkFidelity(candidate, runCtx);
  report.durationMs = Date.now() - startedAt;
  return report;
}

/**
 * The gated test tool. RISK_WRITE passes the policy gate's risk check;
 * the explicit per-revision test authorization is enforced here, inside
 * the invoke, so no backend can run a candidate without it. Test
 * authorization never implies install approval (separate approval map).
 */
registerTool('curse.test', {
  risk: RISK_WRITE,
  async invoke(rawArgs, { session }) {
    const args = rawArgs || {};
    const revisionId = args.revisionId;
    if (!revisionId) throw new Error('revisionId is required');
    const candidate = session.candidates && session.candidates[revisionId];
    if (!candidate) throw new Error(`unknown revision: ${revisionId}`);
    const report = await runCandidateTest(session, candidate, {
      timeoutMs: args.timeoutMs || 10000,
    });
    candidate.testReports.push(report);
    const fresh = await getLiveSession(session.id);
    if (fresh && fresh.candidates && fresh.candidates[revisionId]) {
      fresh.candidates[revisionId].testReports = candidate.testReports;
      fresh.updatedAt = Date.now();
      await saveLiveSession(fresh);
    }
    return report;
  },
});

/**
 * Draft tool: create a candidate revision through the gate (for future
 * backends). The workspace UI uses EvmCandidateCreate directly.
 */
registerTool('curse.draft', {
  risk: RISK_WRITE,
  async invoke(rawArgs, { session }) {
    const args = rawArgs || {};
    if (!args.code) throw new Error('code is required');
    const candidate = await createCandidate({
      code: String(args.code),
      metadata: args.metadata || {},
      assertions: args.assertions || [],
      parentRevisionId: args.parentRevisionId || '',
      repairContext: args.repairContext || null,
    });
    const fresh = await getLiveSession(session.id);
    if (!fresh) throw new Error('session ended during draft');
    fresh.candidates = fresh.candidates || {};
    fresh.candidates[candidate.id] = candidate;
    fresh.updatedAt = Date.now();
    await saveLiveSession(fresh);
    return { revisionId: candidate.id, metadata: candidate.metadata };
  },
});
