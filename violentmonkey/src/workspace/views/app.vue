<template>
  <div class="page-workspace flex flex-col">
    <h1>EvilMonkey Workspace</h1>
    <div class="ws-muted" v-if="!backendReady">
      No agent backend configured. Script management works as usual;
      connect an external agent via Settings if needed.
    </div>
    <div class="ws-actions">
      <button @click="onNewSession">New session on current tab</button>
      <button @click="refresh">Refresh</button>
    </div>
    <div class="ws-banner warn" v-if="error" v-text="error" />
    <h2>Sessions</h2>
    <div v-if="!sessions.length" class="ws-muted">No sessions yet.</div>
    <div
      v-for="s in sessions"
      :key="s.id"
      class="ws-card"
      :class="{ active: s.id === selectedId }"
      @click="select(s.id)">
      <div class="ws-row">
        <strong v-text="s.id.slice(0, 8)" />
        <span v-text="s.status" />
        <span v-if="s.status === 'interrupted'" class="ws-muted">
          ({{ s.recoverable ? 'recoverable from checkpoint' : 'unrecoverable' }})
        </span>
      </div>
      <div class="ws-muted ws-mono" v-text="new Date(s.updatedAt).toLocaleString()" />
    </div>
    <template v-if="detail">
      <h2>Session detail</h2>
      <div class="ws-card">
        <div class="ws-row"><strong>Status:</strong><span v-text="detail.session?.status || detail.status" /></div>
        <div class="ws-row" v-if="detail.recovery !== 'live'">
          <strong>Recovery:</strong><span v-text="detail.recovery" />
        </div>
        <template v-if="target">
          <div class="ws-row"><strong>Tab:</strong><span v-text="target.tabId" /></div>
          <div class="ws-mono" v-text="target.url" />
          <div class="ws-row"><strong>Origin:</strong><span class="ws-mono" v-text="target.origin" /></div>
          <div class="ws-banner warn" v-if="target.changed">
            Target changed since session start. Tool use needs re-approval on origin change.
          </div>
        </template>
        <template v-if="budget">
          <div class="ws-row">
            <strong>Budget:</strong>
            <span v-text="`${budget.stepsUsed}/${budget.maxSteps} steps`" />
            <span v-text="`${elapsed}`" />
          </div>
        </template>
        <div class="ws-actions">
          <button @click="onCheckpoint" :disabled="!isLive">Checkpoint</button>
          <button @click="onStop" :disabled="!isLive">Stop task</button>
          <button @click="onDescribeTarget" :disabled="!isLive">Describe target</button>
        </div>
        <div class="ws-banner" v-if="stopReport">
          <div><strong>Stop report</strong></div>
          <div v-text="`Cancelled: ${stopReport.recalled.length}`" />
          <div v-if="stopReport.notRecalled.length">
            <div>Could not be recalled:</div>
            <ul>
              <li v-for="op in stopReport.notRecalled" :key="op.id"
                  v-text="`${op.tool}: ${op.reason}`" />
            </ul>
          </div>
        </div>
        <div class="ws-banner" v-if="targetInfo">
          <div><strong>Target (gated tool result)</strong></div>
          <pre class="ws-mono" v-text="targetInfo" />
        </div>
        <h2>Evidence (Phase 2)</h2>
        <div class="ws-actions">
          <button @click="onCapabilities" :disabled="!isLive">Capabilities</button>
          <button @click="onSnapshot" :disabled="!isLive">Snapshot</button>
          <button @click="onConsoleRead" :disabled="!isLive">Read console</button>
        </div>
        <div class="ws-banner" v-if="evidenceInfo">
          <div><strong v-text="evidenceTitle" /></div>
          <pre class="ws-mono" v-text="evidenceInfo" />
        </div>
      </div>
        <h2>Curse (Phase 3)</h2>
        <div class="ws-actions">
          <button @click="showCandidateForm = !showCandidateForm" v-text="showCandidateForm ? 'Hide form' : 'New candidate'" />
          <button @click="onCandidateList" :disabled="!isLive">Refresh candidates</button>
        </div>
        <div v-if="showCandidateForm" class="ws-card">
          <div class="ws-row"><strong>Code</strong></div>
          <textarea v-model="newCode" rows="8" class="ws-mono ws-input" placeholder="// candidate userscript code; runs in the page during tests"></textarea>
          <div class="ws-row"><strong>Name</strong><input v-model="newName" class="ws-input" /></div>
          <div class="ws-row"><strong>Matches</strong><input v-model="newMatches" class="ws-input" placeholder="https://example.com/* (comma separated; defaults to session origin)" /></div>
          <div class="ws-row"><strong>Grants</strong><input v-model="newGrants" class="ws-input" placeholder="none (comma separated)" /></div>
          <div class="ws-row"><strong>Run at</strong>
            <select v-model="newRunAt" class="ws-input">
              <option value="document_idle">document_idle</option>
              <option value="document_end">document_end</option>
              <option value="document_start">document_start</option>
            </select>
          </div>
          <div class="ws-row"><strong>Assertions (JSON array)</strong></div>
          <textarea v-model="newAssertionsJson" rows="4" class="ws-mono ws-input" :placeholder="assertionPlaceholder"></textarea>
          <div v-if="reviseParent" class="ws-banner" v-text="`Revising ${reviseParent.slice(0, 8)} from failed assertions.`" />
          <div class="ws-actions">
            <button @click="onCandidateCreate" :disabled="!isLive || !newCode.trim()">Create candidate</button>
          </div>
        </div>
        <div v-if="!candidates.length" class="ws-muted">No candidates yet.</div>
        <div
          v-for="c in candidates"
          :key="c.id"
          class="ws-card"
          :class="{ active: c.id === selectedRev }"
          @click="onCandidateSelect(c.id)">
          <div class="ws-row">
            <strong v-text="c.id.slice(0, 8)" />
            <span v-text="c.name" />
            <span v-if="c.installed" class="ws-muted">(installed)</span>
            <span v-if="c.repairsFailure" class="ws-muted">(repair)</span>
          </div>
          <div class="ws-muted ws-mono" v-text="`${c.testCount} test(s)`" />
        </div>
        <template v-if="candidateDetail">
          <h2 v-text="`Candidate ${candidateDetail.id.slice(0, 8)}`" />
          <div class="ws-card">
            <div class="ws-row"><strong>Name:</strong><span v-text="candidateDetail.metadata.name" /></div>
            <div class="ws-row"><strong>Matches:</strong><span class="ws-mono" v-text="candidateDetail.metadata.matches.join(', ') || '(session origin)'" /></div>
            <div class="ws-row"><strong>Grants:</strong><span class="ws-mono" v-text="candidateDetail.metadata.grants.join(', ') || 'none'" /></div>
            <div class="ws-row"><strong>Run at:</strong><span v-text="candidateDetail.metadata.runAt" /></div>
            <div v-if="candidateDetail.externalDestinations.length" class="ws-banner warn">
              <div><strong>External destinations (heuristic scan):</strong></div>
              <ul>
                <li v-for="u in candidateDetail.externalDestinations" :key="u" class="ws-mono" v-text="u" />
              </ul>
            </div>
            <div class="ws-row"><strong v-text="candidateDetail.diff ? 'Code (diff vs parent):' : 'Code:'" /></div>
            <pre v-if="!candidateDetail.diff" class="ws-mono ws-scroll" v-text="candidateDetail.code" />
            <div v-else class="ws-mono ws-scroll"><div v-for="(l, idx) in candidateDetail.diff" :key="idx" :style="diffStyle(l.type)" v-text="`${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '} ${l.text}`" /></div>
            <div class="ws-banner warn">
              Test fidelity is unverified. Temporary execution does not reproduce GM APIs, @require/@resource loading, grant enforcement, or production run timing. Treat results as evidence from a bounded run, not as production equivalence.
            </div>
            <div class="ws-actions">
              <button @click="onTestAuthorize" :disabled="!isLive">Authorize test run</button>
              <button @click="onTestRun" :disabled="!isLive || !candidateDetail.testAuthorized">Run test</button>
              <button @click="onApproveInstall" :disabled="!isLive">Approve install</button>
              <button @click="onInstall" :disabled="!isLive || !candidateDetail.installApproved">Install</button>
              <button @click="onReviseFromFailure" :disabled="!isLive || !hasFailedAssertions">Revise from failure</button>
            </div>
            <div class="ws-row ws-muted" v-text="`Test authorized: ${candidateDetail.testAuthorized}; install approved: ${candidateDetail.installApproved}`" />
            <h2>Assertions</h2>
            <div v-if="!latestAssertions.length" class="ws-muted">No assertions defined.</div>
            <div v-for="a in latestAssertions" :key="a.id" class="ws-card">
              <div class="ws-row"><strong v-text="a.status" /><span v-text="a.description" /></div>
              <div class="ws-muted ws-mono" v-text="a.kind" />
              <pre class="ws-mono" v-text="JSON.stringify(a.evidence || {}, null, 2)" />
            </div>
            <h2>Test reports</h2>
            <div v-if="!candidateDetail.testReports.length" class="ws-muted">No test runs yet.</div>
            <div v-for="r in candidateDetail.testReports" :key="r.id" class="ws-card">
              <div class="ws-row"><strong>Fidelity:</strong><span v-text="r.fidelity.status" /></div>
              <div class="ws-muted ws-mono" v-text="new Date(r.at).toLocaleString()" />
              <div class="ws-row"><strong>Lifecycle:</strong><span class="ws-mono" v-text="lifecycleSummary(r.lifecycle)" /></div>
              <div v-for="m in r.fidelity.matrix" :key="m.dimension" class="ws-row">
                <span v-text="`${m.dimension}: ${m.status}`" />
              </div>
              <div v-if="r.irreversible" class="ws-banner warn">
                <div><strong>Irreversible effects</strong></div>
                <div>Cleaned up:</div>
                <ul><li v-for="(ci, i) in r.irreversible.cleanedUp" :key="i" v-text="ci" /></ul>
                <div>Not reverted:</div>
                <ul><li v-for="(ni, i) in r.irreversible.notReverted" :key="i" v-text="ni" /></ul>
              </div>
              <div v-if="r.warnings && r.warnings.length" class="ws-banner warn">
                <div><strong>Warnings</strong></div>
                <ul><li v-for="(w, i) in r.warnings" :key="i" v-text="w" /></ul>
              </div>
            </div>
          </div>
        </template>
      <h2>Events</h2>
      <ul class="ws-events">
        <li v-for="e in events" :key="e.id">
          <span class="ws-muted ws-mono" v-text="new Date(e.at).toLocaleTimeString()" />
          <span v-text="` ${e.type}`" />
        </li>
      </ul>
    </template>
  </div>
</template>

<script setup>
/**
 * EvilMonkey workspace (Phase 1 + Phase 2). Side panel UI for
 * backend-neutral agent sessions: list, inspect, checkpoint, stop, recover,
 * and run browser evidence tools. All actions go through the background
 * session commands; tool calls pass the shared policy gate. User-visible
 * strings are English for now; full localization is deferred to a later
 * phase.
 */
import { computed, onMounted, ref } from 'vue';
import { sendCmdDirectly } from '@/common';
import { showMessage } from '@/common/ui';

const sessions = ref([]);
const selectedId = ref('');
const detail = ref(null);
const error = ref('');
const stopReport = ref(null);
const targetInfo = ref('');
const evidenceInfo = ref('');
const evidenceTitle = ref('');
const candidates = ref([]);
const selectedRev = ref('');
const candidateDetail = ref(null);
const showCandidateForm = ref(false);
const newCode = ref('');
const newName = ref('Untitled Curse');
const newMatches = ref('');
const newGrants = ref('none');
const newRunAt = ref('document_idle');
const newAssertionsJson = ref('');
const reviseParent = ref('');
const reviseContext = ref(null);
const assertionPlaceholder = '[{"kind":"selector-hidden","description":"Sponsored cards are hidden","selector":".sponsored-card"}]  // kinds: selector-hidden, selector-count, selector-visible, selector-text, js-eval';

const backendReady = computed(() => false); // no agent backend in Phase 1
const target = computed(() => detail.value?.session?.target);
const budget = computed(() => detail.value?.session?.budget);
const isLive = computed(() => detail.value?.recovery === 'live'
  && detail.value?.session?.status === 'active');
const events = computed(() => {
  const live = detail.value?.session?.events || [];
  const tail = detail.value?.eventTail || [];
  return [...tail, ...live].slice(-100);
});
const elapsed = computed(() => {
  const b = budget.value;
  if (!b) return '';
  const ms = Date.now() - b.startedAt;
  return `${Math.floor(ms / 60000)}m ${Math.floor(ms / 1000) % 60}s elapsed`;
});

async function refresh() {
  error.value = '';
  try {
    sessions.value = await sendCmdDirectly('EvmSessionList');
    if (selectedId.value) await select(selectedId.value, true);
  } catch (e) {
    error.value = `${e?.message || e}`;
  }
}

async function select(id, keep = false) {
  selectedId.value = id;
  stopReport.value = null;
  targetInfo.value = '';
  evidenceInfo.value = '';
  candidates.value = [];
  selectedRev.value = '';
  candidateDetail.value = null;
  showCandidateForm.value = false;
  reviseParent.value = '';
  reviseContext.value = null;
  try {
    detail.value = await sendCmdDirectly('EvmSessionGet', { id });
  } catch (e) {
    if (!keep) error.value = `${e?.message || e}`;
  }
}

async function onNewSession() {
  error.value = '';
  try {
    const session = await sendCmdDirectly('EvmSessionCreate', {});
    await refresh();
    await select(session.id);
  } catch (e) {
    error.value = `${e?.message || e}`;
  }
}

async function onCheckpoint() {
  try {
    await sendCmdDirectly('EvmSessionCheckpoint', { id: selectedId.value });
    await select(selectedId.value, true);
    showMessage('Checkpoint saved');
  } catch (e) {
    error.value = `${e?.message || e}`;
  }
}

async function onStop() {
  try {
    const report = await sendCmdDirectly('EvmSessionStop', { id: selectedId.value });
    await refresh();
    stopReport.value = report;
  } catch (e) {
    error.value = `${e?.message || e}`;
  }
}

async function onDescribeTarget() {
  targetInfo.value = '';
  try {
    const res = await sendCmdDirectly('EvmToolInvoke', {
      sessionId: selectedId.value,
      tool: 'target.describe',
      args: {},
    });
    targetInfo.value = res.ok
      ? JSON.stringify(res.data, null, 2)
      : `denied: ${res.reason}${res.requiresApproval ? ` (approval: ${res.requiresApproval})` : ''}`;
  } catch (e) {
    error.value = `${e?.message || e}`;
  }
}

async function runEvidenceTool(title, tool, args) {
  evidenceInfo.value = '';
  evidenceTitle.value = title;
  try {
    const res = await sendCmdDirectly('EvmToolInvoke', {
      sessionId: selectedId.value,
      tool,
      args: args || {},
    });
    evidenceInfo.value = res.ok
      ? JSON.stringify(res.data, null, 2)
      : `denied: ${res.reason}${res.detail ? ` (${res.detail})` : ''}${res.requiresApproval ? ` (approval: ${res.requiresApproval})` : ''}`;
  } catch (e) {
    error.value = `${e?.message || e}`;
  }
}

async function onCapabilities() {
  await runEvidenceTool('Capabilities', 'evidence.capabilities', {});
}

async function onSnapshot() {
  await runEvidenceTool('DOM snapshot', 'page.snapshot', { limit: 50 });
}

async function onConsoleRead() {
  await runEvidenceTool('Console', 'console.read', {});
}

const latestAssertions = computed(() => {
  const d = candidateDetail.value;
  if (!d) return [];
  const reports = d.testReports || [];
  if (reports.length) return reports[reports.length - 1].assertions || [];
  return (d.assertions || []).map(a => ({ ...a, status: 'NOT_RUN', evidence: {} }));
});
const hasFailedAssertions = computed(
  () => latestAssertions.value.some(a => a.status === 'FAIL'),
);

function diffStyle(type) {
  if (type === 'add') return { color: '#1a7f37' };
  if (type === 'del') return { color: '#b42318' };
  return {};
}

function lifecycleSummary(lc) {
  if (!lc) return '';
  return [
    `authorized:${!!lc.authorized}`,
    `registered:${!!lc.registered}`,
    `executed:${!!lc.executed}`,
    `unregistered:${!!lc.unregistered}`,
    `cleanup:${lc.cleanupVerified ? 'verified' : 'unverified'}`,
  ].join(' ');
}

async function onCandidateList() {
  try {
    candidates.value = await sendCmdDirectly('EvmCandidateList', { id: selectedId.value });
  } catch (e) {
    error.value = `${e?.message || e}`;
  }
}

async function onCandidateSelect(revId) {
  selectedRev.value = revId;
  try {
    candidateDetail.value = await sendCmdDirectly('EvmCandidateGet', {
      id: selectedId.value,
      revisionId: revId,
    });
  } catch (e) {
    error.value = `${e?.message || e}`;
  }
}

async function onCandidateCreate() {
  error.value = '';
  let assertions = [];
  try {
    if (newAssertionsJson.value.trim()) {
      assertions = JSON.parse(newAssertionsJson.value);
      if (!Array.isArray(assertions)) throw new Error('assertions JSON must be an array');
    }
  } catch (e) {
    error.value = `bad assertions JSON: ${e?.message || e}`;
    return;
  }
  try {
    const res = await sendCmdDirectly('EvmCandidateCreate', {
      id: selectedId.value,
      code: newCode.value,
      metadata: {
        name: newName.value.trim() || 'Untitled Curse',
        matches: newMatches.value.split(',').map(s => s.trim()).filter(Boolean),
        grants: newGrants.value.split(',').map(s => s.trim()).filter(Boolean),
        runAt: newRunAt.value,
      },
      assertions,
      parentRevisionId: reviseParent.value,
      repairContext: reviseContext.value,
    });
    newCode.value = '';
    newAssertionsJson.value = '';
    reviseParent.value = '';
    reviseContext.value = null;
    showCandidateForm.value = false;
    await onCandidateList();
    await onCandidateSelect(res.revisionId);
  } catch (e) {
    error.value = `${e?.message || e}`;
  }
}

async function onTestAuthorize() {
  try {
    await sendCmdDirectly('EvmTestAuthorize', {
      id: selectedId.value,
      revisionId: selectedRev.value,
    });
    await onCandidateSelect(selectedRev.value);
    showMessage('Test run authorized for this revision');
  } catch (e) {
    error.value = `${e?.message || e}`;
  }
}

async function onTestRun() {
  try {
    const res = await sendCmdDirectly('EvmToolInvoke', {
      sessionId: selectedId.value,
      tool: 'curse.test',
      args: { revisionId: selectedRev.value },
    });
    if (!res.ok) {
      error.value = `test failed: ${res.reason}${res.message ? ` (${res.message})` : ''}`;
    }
    await onCandidateList();
    await onCandidateSelect(selectedRev.value);
  } catch (e) {
    error.value = `${e?.message || e}`;
  }
}

async function onApproveInstall() {
  try {
    const res = await sendCmdDirectly('EvmSessionApproveRevision', {
      id: selectedId.value,
      revisionId: selectedRev.value,
    });
    if (!res.approved) {
      error.value = 'install approval was not recorded (session may no longer be active)';
    } else {
      showMessage('Install approved for the exact displayed revision');
    }
    await onCandidateSelect(selectedRev.value);
  } catch (e) {
    error.value = `${e?.message || e}`;
  }
}

async function onInstall() {
  try {
    const res = await sendCmdDirectly('EvmCurseInstall', {
      id: selectedId.value,
      revisionId: selectedRev.value,
    });
    showMessage(`Installed as userscript id ${res.scriptId}`);
    await onCandidateList();
    await onCandidateSelect(selectedRev.value);
  } catch (e) {
    error.value = `${e?.message || e}`;
  }
}

function onReviseFromFailure() {
  const d = candidateDetail.value;
  if (!d) return;
  const failed = latestAssertions.value.filter(a => a.status === 'FAIL');
  reviseParent.value = d.id;
  reviseContext.value = {
    fromRevisionId: d.id,
    failedAssertionIds: failed.map(a => a.id),
    failedAssertions: failed.map(a => ({
      id: a.id,
      kind: a.kind,
      description: a.description,
      evidence: a.evidence,
      conditions: a.conditions,
    })),
    note: 'manual revision from failed assertions; edit the code to address the evidence, then create the candidate',
  };
  newCode.value = d.code;
  newName.value = d.metadata.name;
  newMatches.value = (d.metadata.matches || []).join(', ');
  newGrants.value = (d.metadata.grants || []).join(', ');
  newRunAt.value = d.metadata.runAt || 'document_idle';
  newAssertionsJson.value = JSON.stringify(d.assertions || [], null, 2);
  showCandidateForm.value = true;
}

onMounted(refresh);
</script>


