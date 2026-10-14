/**
 * Redaction for provider-bound and persisted payloads (Phase 1).
 *
 * Shared by the policy gate and the storage layer: sensitive fields are
 * stripped before evidence reaches any provider or durable storage, and
 * long strings are truncated so payloads stay bounded.
 */

const SENSITIVE_KEY_RE = /cookie|authorization|[^a-z]token$|token[^a-z]|secret|password|passwd|api[_-]?key|bearer|sessionid|csrf/i;
const MAX_STRING = 4000;
const MAX_DEPTH = 8;
const MAX_KEYS = 200;

function isSensitiveKey(key) {
  return SENSITIVE_KEY_RE.test(key);
}

function redactValue(value, depth) {
  if (depth > MAX_DEPTH) return '[truncated:depth]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}[truncated:${value.length}]`
      : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_KEYS).map(v => redactValue(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out = {};
    let n = 0;
    for (const key of Object.keys(value)) {
      if (n >= MAX_KEYS) {
        out['[truncated:keys]'] = true;
        break;
      }
      out[key] = isSensitiveKey(key) ? '[redacted]' : redactValue(value[key], depth + 1);
      n += 1;
    }
    return out;
  }
  return value;
}

/** Deep-clone with sensitive fields redacted and sizes bounded. */
export function redactForProvider(payload) {
  if (payload == null) return payload;
  return redactValue(payload, 0);
}
