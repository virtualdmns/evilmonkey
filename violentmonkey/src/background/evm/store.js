/**
 * EvilMonkey session persistence (Phase 1).
 *
 * Two tiers, per D6:
 *
 * - Ephemeral: chrome.storage.session (MV3 only). Holds live session records,
 *   budget counters, stop flags, and in-flight operations. It survives service
 *   worker restarts within a browser session and is cleared automatically on
 *   browser exit, which is exactly the lifetime live task state needs.
 *   Outside MV3 a memory shim is used so the module never crashes.
 * - Durable: browser.storage.local under the `evm:` prefix. Holds the session
 *   index, checkpoints, and event tails. Follows the existing bucket pattern
 *   (see ../utils/storage.js) without touching the script storage areas.
 *
 * U8 retention/quota/privacy design, decided here:
 *
 * - Retention: at most 20 checkpoints per session (oldest pruned); at most 50
 *   sessions in the index (oldest finished/interrupted pruned first); sessions
 *   older than 30 days pruned on startup. Event tails are capped at the last
 *   100 events per session and only persisted at checkpoints.
 * - Quota: live records are small JSON (well under 1 MB per session against
 *   the ~10 MB session quota); durable checkpoints are bounded by the caps
 *   above and stay far under the local quota alongside script storage.
 * - Privacy: never persist tokens, credentials, provider keys, or live
 *   browser handles (ports, tab objects). Targets store tabId, url, and
 *   origin only. Evidence is stored as references (descriptors and hashes),
 *   never raw page content. Payloads are redacted before persistence via
 *   policy.redactForProvider.
 */

import browser from '@/common/browser';

const PREFIX = 'evm:';
const K_INDEX = `${PREFIX}index`;
const K_LIVE = id => `${PREFIX}live:${id}`;
const K_CHECKPOINT = (id, n) => `${PREFIX}chk:${id}:${n}`;
const K_EVENTS = id => `${PREFIX}events:${id}`;

const MAX_CHECKPOINTS_PER_SESSION = 20;
const MAX_SESSIONS_IN_INDEX = 50;
const MAX_EVENT_TAIL = 100;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

/* Ephemeral area: chrome.storage.session in MV3, memory shim otherwise. */
function memoryArea() {
  const map = new Map();
  return {
    get: async keys => {
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (map.has(k)) out[k] = map.get(k);
      return out;
    },
    set: async obj => {
      for (const k of Object.keys(obj)) map.set(k, obj[k]);
    },
    remove: async keys => {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    },
  };
}

const sessionArea = __.MV3 && chrome.storage?.session
  ? chrome.storage.session
  : memoryArea();

const localArea = browser.storage.local;

async function localGet(key) {
  return (await localArea.get([key]))[key];
}

async function localSet(key, value) {
  await localArea.set({ [key]: value });
}

/** @returns {Promise<?Object>} live session record or null */
export async function getLiveSession(id) {
  return (await sessionArea.get(K_LIVE(id)))[K_LIVE(id)] || null;
}

export async function saveLiveSession(session) {
  await sessionArea.set({ [K_LIVE(session.id)]: session });
}

export async function removeLiveSession(id) {
  await sessionArea.remove(K_LIVE(id));
}

/** @returns {Promise<Object>} session index: { [id]: {id,status,updatedAt,recoverable} } */
export async function getIndex() {
  return (await localGet(K_INDEX)) || {};
}

async function saveIndex(index) {
  await localSet(K_INDEX, index);
}

export async function updateIndexEntry(session, recoverable) {
  const index = await getIndex();
  index[session.id] = {
    id: session.id,
    status: session.status,
    updatedAt: session.updatedAt,
    recoverable,
  };
  await saveIndex(pruneIndex(index));
  return index[session.id];
}

function pruneIndex(index) {
  const entries = Object.values(index).sort((a, b) => b.updatedAt - a.updatedAt);
  const kept = entries.slice(0, MAX_SESSIONS_IN_INDEX);
  // Drop expired sessions even if under the cap.
  const cutoff = Date.now() - SESSION_TTL_MS;
  return Object.fromEntries(
    kept.filter(e => e.updatedAt >= cutoff).map(e => [e.id, e]),
  );
}

/**
 * Write a durable checkpoint: full session snapshot plus the event tail.
 * Oldest checkpoints beyond the per-session cap are pruned.
 */
export async function saveCheckpoint(session) {
  const n = session.checkpointCount + 1;
  const snapshot = {
    ...session,
    // Live handles must never reach durable storage; targets are plain data already.
    inFlight: [],
    checkpointAt: Date.now(),
    checkpointSeq: n,
  };
  await localSet(K_CHECKPOINT(session.id, n), snapshot);
  await localSet(K_EVENTS(session.id), session.events.slice(-MAX_EVENT_TAIL));
  await pruneCheckpoints(session.id, n);
  return n;
}

async function pruneCheckpoints(sessionId, latest) {
  const keys = [];
  for (let n = 1; n <= latest - MAX_CHECKPOINTS_PER_SESSION; n += 1) {
    keys.push(K_CHECKPOINT(sessionId, n));
  }
  if (keys.length) await localArea.remove(keys);
}

/** @returns {Promise<?Object>} newest checkpoint snapshot or null */
export async function getLatestCheckpoint(sessionId, countHint) {
  // Walk back from the hinted count; checkpoints are sequential.
  const start = countHint || MAX_CHECKPOINTS_PER_SESSION;
  for (let n = start; n >= 1; n -= 1) {
    const snap = await localGet(K_CHECKPOINT(sessionId, n));
    if (snap) return snap;
  }
  return null;
}

/** @returns {Promise<Array>} persisted event tail or [] */
export async function getEventTail(sessionId) {
  return (await localGet(K_EVENTS(sessionId))) || [];
}

/** Remove all durable data for a session (used when pruning the index). */
export async function removeDurableSession(sessionId, checkpointCount) {
  const keys = [K_EVENTS(sessionId)];
  for (let n = 1; n <= (checkpointCount || MAX_CHECKPOINTS_PER_SESSION); n += 1) {
    keys.push(K_CHECKPOINT(sessionId, n));
  }
  await localArea.remove(keys);
  const index = await getIndex();
  delete index[sessionId];
  await saveIndex(index);
}
