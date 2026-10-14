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
      </div>
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
 * EvilMonkey workspace (Phase 1). Side panel UI for backend-neutral agent
 * sessions: list, inspect, checkpoint, stop, and recover sessions. All
 * actions go through the background session commands; tool calls pass the
 * shared policy gate. User-visible strings are English for now; full
 * localization is deferred to a later phase.
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

onMounted(refresh);
</script>

