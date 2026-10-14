/**
 * EvilMonkey candidate Curse model (Phase 3: Curse Draft, Bounded Test,
 * and Approval Vertical Slice).
 *
 * A candidate is a proposed userscript revision: code plus normalized
 * metadata. Revision identity is the SHA-256 of code plus normalized
 * metadata (see createCandidateRevision in ./models.js), so any edit to
 * code, name, namespace, version, matches, or grants produces a new id
 * and invalidates prior test and install approvals.
 *
 * This module is pure data plus small static analyses. Execution lives
 * in ./runner.js, access rules in ./policy.js, lifecycle in
 * ./orchestrator.js. Nothing here touches Chrome APIs.
 */

import { createCandidateRevision } from './models';

/** Assertion lifecycle states. INCONCLUSIVE means the check could not be
 * evaluated (evaluator error, timeout, missing evidence); NOT_RUN means
 * the runner skipped it (epoch changed mid-test, aborted run). */
export const ASSERT_PASS = 'PASS';
export const ASSERT_FAIL = 'FAIL';
export const ASSERT_NOT_RUN = 'NOT_RUN';
export const ASSERT_INCONCLUSIVE = 'INCONCLUSIVE';

export const ASSERTION_STATUSES = [
  ASSERT_PASS,
  ASSERT_FAIL,
  ASSERT_NOT_RUN,
  ASSERT_INCONCLUSIVE,
];

/** Assertion kinds the bounded runner can evaluate. */
export const ASSERT_HIDDEN = 'selector-hidden';
export const ASSERT_COUNT = 'selector-count';
export const ASSERT_VISIBLE = 'selector-visible';
export const ASSERT_TEXT = 'selector-text';
export const ASSERT_JS = 'js-eval';

export const ASSERTION_KINDS = [
  ASSERT_HIDDEN,
  ASSERT_COUNT,
  ASSERT_VISIBLE,
  ASSERT_TEXT,
  ASSERT_JS,
];

/**
 * A candidate Curse revision proposed for testing and install.
 * Stored on the session (ephemeral tier); never persisted durably until
 * installed as a real userscript.
 */
export async function createCandidate({
  code = '',
  metadata = {},
  assertions = [],
  parentRevisionId = '',
  repairContext = null,
} = {}) {
  const revision = await createCandidateRevision({ code, metadata });
  return {
    ...revision,
    metadata: normalizeMetadata(metadata),
    assertions: (assertions || []).map(normalizeAssertion),
    /** revision id this candidate revises, if any (the repair chain) */
    parentRevisionId,
    /** evidence that motivated this revision: { fromRevisionId, failedAssertionIds, note } */
    repairContext,
    /** test reports, newest last */
    testReports: [],
    /** install record once installed: { scriptId, installedAt } */
    installed: null,
  };
}

function normalizeMetadata(metadata = {}) {
  return {
    name: metadata.name || 'Untitled Curse',
    namespace: metadata.namespace || '',
    version: metadata.version || '1.0.0',
    matches: [...(metadata.matches || [])],
    grants: [...(metadata.grants || [])],
    runAt: metadata.runAt || 'document_idle',
    allFrames: !!metadata.allFrames,
    /** candidate-declared side effects, e.g. ['dom', 'network', 'storage'] */
    sideEffects: [...(metadata.sideEffects || [])],
  };
}

function normalizeAssertion(a = {}) {
  const kind = ASSERTION_KINDS.includes(a.kind) ? a.kind : ASSERT_JS;
  return {
    id: a.id || `a-${Math.random().toString(36).slice(2, 10)}`,
    kind,
    description: a.description || kind,
    selector: a.selector || '',
    expected: a.expected,
    mode: a.mode || 'eq',
    contains: a.contains || '',
    js: a.js || '',
  };
}

/**
 * Evaluate one assertion definition against an observed result produced
 * by the page-side evaluator. Pure function; the page call itself lives
 * in ./runner.js.
 */
export function scoreAssertion(assertion, observed) {
  const conditions = observed.conditions || {};
  if (observed.error) {
    return {
      ...assertion,
      status: ASSERT_INCONCLUSIVE,
      evidence: { error: observed.error },
      conditions,
    };
  }
  const ev = observed.evidence || {};
  let pass = false;
  switch (assertion.kind) {
    case ASSERT_HIDDEN:
      pass = (ev.matchedTotal | 0) === 0;
      break;
    case ASSERT_COUNT: {
      const n = ev.matchedTotal | 0;
      const expected = +assertion.expected || 0;
      pass = assertion.mode === 'gte' ? n >= expected
        : assertion.mode === 'lte' ? n <= expected
          : n === expected;
      break;
    }
    case ASSERT_VISIBLE:
      pass = (ev.matchedVisible | 0) > 0;
      break;
    case ASSERT_TEXT:
      pass = typeof ev.text === 'string'
        && ev.text.includes(assertion.contains || '');
      break;
    case ASSERT_JS:
      pass = !!ev.value;
      break;
    default:
      pass = false;
  }
  return {
    ...assertion,
    status: pass ? ASSERT_PASS : ASSERT_FAIL,
    evidence: ev,
    conditions,
  };
}

/** Mark assertions NOT_RUN when the document epoch changed mid-test. */
export function markNotRun(assertions, reason, conditions = {}) {
  return (assertions || []).map(a => ({
    ...a,
    status: ASSERT_NOT_RUN,
    evidence: { reason },
    conditions,
  }));
}

/**
 * Minimal line diff for the approval UI. Returns an array of
 * { type: 'same'|'add'|'del', text }. Not a full Myers implementation;
 * good enough for short candidate scripts and labeled as such.
 */
export function lineDiff(oldCode = '', newCode = '') {
  const a = String(oldCode).split('\n');
  const b = String(newCode).split('\n');
  // Longest common subsequence on lines, capped for sanity.
  const n = Math.min(a.length, 2000);
  const m = Math.min(b.length, 2000);
  const aa = a.slice(0, n);
  const bb = b.slice(0, m);
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aa[i] === bb[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aa[i] === bb[j]) {
      out.push({ type: 'same', text: aa[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: aa[i++] });
    } else {
      out.push({ type: 'add', text: bb[j++] });
    }
  }
  while (i < n) out.push({ type: 'del', text: aa[i++] });
  while (j < m) out.push({ type: 'add', text: bb[j++] });
  if (a.length > n || b.length > m) {
    out.push({ type: 'same', text: '...[diff truncated: script exceeds 2000 lines]' });
  }
  return out;
}

/** Parse a ==UserScript== metadata block, if the code carries one. */
export function parseMetablock(code = '') {
  const m = String(code).match(/\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/);
  if (!m) return null;
  const meta = { matches: [], grants: [], require: [], resources: [] };
  for (const line of m[1].split('\n')) {
    const mm = line.match(/\/\/\s*@(\S+)\s+(.*)/);
    if (!mm) continue;
    const [, key, value] = mm;
    const v = value.trim();
    if (key === 'match') meta.matches.push(v);
    else if (key === 'grant') meta.grants.push(v);
    else if (key === 'require') meta.require.push(v);
    else if (key === 'resource') {
      const parts = v.split(/\s+/);
      meta.resources.push({ name: parts[0] || '', url: parts.slice(1).join(' ') });
    } else {
      meta[key] = v;
    }
  }
  return meta;
}

/**
 * Heuristic scan for external destinations in candidate code. Labels
 * itself heuristic: static analysis cannot see dynamically built URLs.
 * The approval UI shows these so the user knows what to check.
 */
export function scanExternalDestinations(code = '') {
  const src = String(code);
  const found = new Set();
  const patterns = [
    /fetch\s*\(\s*['"`]([^'"`]+)['"`]/g,
    /GM_xmlhttpRequest\s*\(\s*\{[^}]*url\s*:\s*['"`]([^'"`]+)['"`]/g,
    /new\s+WebSocket\s*\(\s*['"`]([^'"`]+)['"`]/g,
    /new\s+EventSource\s*\(\s*['"`]([^'"`]+)['"`]/g,
    /\.open\s*\(\s*['"](?:GET|POST|PUT|DELETE|HEAD)['"]\s*,\s*['"`]([^'"`]+)['"`]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) {
      const url = m[1].trim();
      if (url && !url.startsWith('data:') && !url.startsWith('blob:')) {
        found.add(url);
      }
    }
  }
  // Bare absolute URLs are weaker signal; include separately labeled.
  const urlRe = /https?:\/\/[^\s'"`<>]+/g;
  let m;
  while ((m = urlRe.exec(src))) {
    found.add(m[0]);
  }
  return [...found].slice(0, 50);
}

/** Build a full installable userscript source from a candidate. */
export function buildInstallSource(candidate) {
  const { code, metadata } = candidate;
  if (/\/\/\s*==UserScript==/.test(code)) return code;
  const lines = [
    '// ==UserScript==',
    `// @name         ${metadata.name}`,
  ];
  if (metadata.namespace) lines.push(`// @namespace    ${metadata.namespace}`);
  lines.push(`// @version      ${metadata.version}`);
  for (const match of metadata.matches) lines.push(`// @match        ${match}`);
  for (const grant of metadata.grants) lines.push(`// @grant        ${grant}`);
  if (!metadata.grants.length) lines.push('// @grant        none');
  if (metadata.runAt && metadata.runAt !== 'document_idle') {
    lines.push(`// @run-at       ${metadata.runAt}`);
  }
  if (metadata.allFrames) lines.push('// @all-frames    true');
  lines.push('// ==/UserScript==', '');
  return `${lines.join('\n')}\n${code}`;
}
