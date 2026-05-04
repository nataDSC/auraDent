---
name: gateway-session-state
description: Use when working on apps/gateway/src/index.ts — adding session behaviors, modifying session lifecycle, or debugging state transitions. Covers GatewaySessionState invariants, extraction sequencing, and the session stop sequence.
---

# Gateway Session State

## The `GatewaySessionState` Type

Every field and its invariant:

```typescript
type GatewaySessionState = {
  // Identity
  activeSessionId?: string;           // set on session.start, updated per-session

  // Demo mode
  audioInterval?: NodeJS.Timeout;     // mock audio level emitter; cleared by stopDemoSession()
  demoTimers: NodeJS.Timeout[];       // all demo setTimeout handles; cleared by stopDemoSession()

  // Live mode / Deepgram
  deepgramSocket?: WebSocket;         // undefined when disconnected
  deepgramKeepAlive?: NodeJS.Timeout; // interval that sends KeepAlive every 3s when idle
  deepgramOpenedAt?: number;          // Date.now() at socket open, used for TTFT calculation
  deepgramReconnectAttempt: number;   // increments on each close, reset to 0 on open
  deepgramReconnectTimer?: NodeJS.Timeout; // pending reconnect setTimeout
  liveAudioSampleRate?: number;       // set from session.start audio.sampleRate

  // Audio
  lastAudioAt?: number;               // updated on every forwarded audio chunk

  // Extraction sequencing (critical invariants — see below)
  extractionChain: Promise<void>;     // always starts as Promise.resolve()
  extractionSequence: number;         // monotonically increasing, incremented per queueExtraction call
  completedExtractionSequence: number; // set to sequence number after each extraction finishes
  pendingExtractions: Set<Promise<void>>; // tracked for waitForPendingExtractions()

  // Transcript
  transcriptRevisions: TranscriptRevisionStore; // Map<utteranceId, {finalText?, partialText?}>
  transcriptCounter: number;          // fallback utterance ID counter when Deepgram lacks start time
  finalizedUtterances: Array<{ utteranceId: string; text: string; redactedText?: string }>;
                                      // rolling window of last 4 finalized utterances

  // Artifacts (accumulated for session-close payload)
  traceEvents: Array<{ step: string; detail: string; confidence?: number; ts: string }>;
  metrics: Array<{ name: string; value: number; unit: string; ts: string }>;
  findings: SessionClosePayload['structuredFindings']; // deduplicated on (sourceUtteranceId, toothNumber)

  // Flags
  hasEmittedTtft: boolean;            // emits TTFT metric only once per session
  isStopping: boolean;                // set true at session.stop, gates retry/reconnect logic
  autoPersistToPostgres: boolean;     // from session.start localPersistence.postgresOnStop
};
```

## Extraction Sequencing Invariants

These are the most subtle invariants. Violating them causes lost findings or race conditions.

**`queueExtraction(state, run)` — the only correct way to schedule extraction:**

```typescript
function queueExtraction(state: GatewaySessionState, run: () => Promise<void>) {
  const sequence = state.extractionSequence + 1;
  state.extractionSequence = sequence;

  const queued = state.extractionChain.then(async () => {
    await run();
    state.completedExtractionSequence = sequence;  // only set after completion
  });

  state.extractionChain = queued.catch(() => undefined);  // chain never rejects
  trackExtraction(state, queued);
}
```

Rules:
1. **Never call `runClinicalAgent` directly.** Always go through `queueExtraction`. This guarantees serial execution — extractions run one at a time, in utterance order.
2. `extractionChain` is a promise chain. Each new extraction is `.then()`-chained onto the previous one.
3. `completedExtractionSequence` increments only after the extraction actually finishes — not when it's queued.
4. `extractionChain` never rejects (`.catch(() => undefined)`) so the chain stays alive across failures.

**`waitForPendingExtractions(state)` — called at session stop:**

```typescript
async function waitForPendingExtractions(state: GatewaySessionState) {
  while (
    state.pendingExtractions.size > 0 ||
    state.completedExtractionSequence < state.extractionSequence
  ) {
    await Promise.allSettled(Array.from(state.pendingExtractions));
    await state.extractionChain;
  }
}
```

This drains the entire queue before building the session-close payload. New code must not bypass this.

## Event Emission

**Always use the `send()` closure, never write to `socket.send()` directly:**

```typescript
const send = (event: RealtimeEvent) => { /* accumulates state + sends */ };
const sendTrace = (step: string, detail: string, confidence?: number) =>
  send({ type: 'trace.event', step, detail, confidence, ts: new Date().toISOString() });
```

`send()` also:
- Pushes `trace.event` entries into `state.traceEvents`
- Pushes `metric` entries into `state.metrics`
- Deduplicates `chart.finding.staged` / `chart.finding.committed` into `state.findings` by `(sourceUtteranceId, toothNumber)` — the latest finding for that pair wins

## Session Stop Sequence

This sequence must not be reordered:

```typescript
state.isStopping = true;
stopDemoSession(state);        // clears audioInterval and demoTimers
finalizeDeepgram(state);       // sends Finalize message, closes socket after 250ms
await waitForRealtimeSettle(); // 350ms grace period for in-flight Deepgram messages
await waitForPendingExtractions(state);  // drains extraction queue
await publishSessionClose(...);          // builds payload, writes to disk, optionally SQS/Postgres
send({ type: 'session.closed', ... });
```

## Mode Branching

The `session.start` message `mode` field controls which path runs:

```typescript
if (payload.mode === 'live') {
  // Requires DEEPGRAM_API_KEY and payload.audio.sampleRate
  // Calls startLiveSession() → connectDeepgramSession()
} else {
  // Demo mode: mocked transcript timers, no real audio
  // Calls startDemoSession()
}
```

Never mix demo and live state. `resetSessionArtifacts()` is called before `startLiveSession` or `startDemoSession` to wipe all previous session state.

## Adding New Session Behavior

When adding a new behavior to the gateway:

1. Add any new state fields to `GatewaySessionState` and initialize them in the state literal (line ~112) and `resetSessionArtifacts()`.
2. If the behavior produces events, emit via `send()` or `sendTrace()`.
3. If the behavior must run before session-close, either call it inside `queueExtraction` or add it to the stop sequence before `publishSessionClose`.
4. If it owns timers or sockets, clear them in `teardownSession()`.
5. Check `state.isStopping` before starting any new async work that isn't part of the stop sequence.
