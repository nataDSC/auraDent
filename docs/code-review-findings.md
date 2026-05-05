# AuraDent — Code Review Findings

**Date:** 2026-05-04  
**Scope:** Full source tree — `apps/`, `packages/`, `infra/`  
**Reviewer:** Static analysis pass covering all production source files

---

## Summary

Thirteen findings across three severity levels. The three critical issues share a common theme: **the session boundary is underspecified** — what leaves the gateway and what enters the backend lacks runtime validation, carries hardcoded identity, and silently truncates data. Resolving them in order (add `patientId` to the contract → validate the contract at runtime → accumulate the full transcript) addresses the highest-risk issues without cascading changes across other layers.

| # | Finding | Severity | File |
|---|---|---|---|
| 1 | Transcript truncated to last 4 utterances in session-close payload | Critical | `apps/gateway/src/index.ts` |
| 2 | No Zod validation at WebSocket boundaries (both sides) | Critical | `apps/gateway/src/index.ts`, `apps/web/src/App.tsx` |
| 3 | `patientId` hardcoded; never flows client → backend | Critical | `apps/gateway/src/index.ts`, `packages/shared/src/events.ts` |
| 4 | `bleedingOnProbing` OR logic overwrites dedup winner's value | Medium | `packages/ingestion/src/index.ts` |
| 5 | `x ?? x` tautology for `approximateReceiveCount` in worker log | Medium | `apps/worker/src/index.ts` |
| 6 | Audio streaming begins before Deepgram is ready — first words silently dropped | Medium | `apps/web/src/App.tsx`, `apps/gateway/src/index.ts` |
| 7 | DDL executes on every PostgreSQL connection, not just migrations | Medium | `apps/worker/src/persistence.ts` |
| 8 | `ScriptProcessorNode` is deprecated; runs on the main thread | Low | `apps/web/src/App.tsx` |
| 9 | Canvas dimensions force a layout reflow on every animation frame | Low | `apps/web/src/App.tsx` |
| 10 | Realistic-looking fake PHI hardcoded in version-controlled demo script | Low | `apps/gateway/src/index.ts` |
| 11 | 350 ms magic-number sleep in the session stop path | Low | `apps/gateway/src/index.ts` |
| 12 | Module-scope `/g` regexes — latent `lastIndex` hazard | Low | `packages/shared/src/redaction.ts` |
| 13 | O(n²) byte-offset loop in stub PDF builder | Low | `packages/ingestion/src/index.ts` |

---

## Critical

### 1 — Transcript truncated to last 4 utterances in the session-close payload

**File:** [`apps/gateway/src/index.ts:813-823`](../apps/gateway/src/index.ts#L813)

```typescript
state.finalizedUtterances = [
  ...state.finalizedUtterances.filter((entry) => entry.utteranceId !== utteranceId),
  { utteranceId, text, redactedText: ... },
].slice(-4);   // ← only the last 4 utterances survive
```

`state.finalizedUtterances` is passed directly to `buildSessionClosePayload` as `transcriptEntries` at session stop. The resulting `transcript.finalText` in the session-close payload contains only the last ~4 spoken sentences of the entire session. The PDF post-op instructions and the SQS payload are both built from this truncated text — a 10-minute dental exam produces a 4-sentence record.

The rolling window exists for a valid reason: `getTranscriptWindow` limits the context sent to the clinical agent on every utterance, which is correct. But the session-close payload needs the full transcript. These two concerns need to be separated: keep a narrow rolling window for extraction input, and accumulate all utterances in a separate unbounded list for the close payload.

**Fix:** Add a second unbounded list (e.g. `allFinalizedUtterances`) accumulated without `.slice(-4)`, and use it when building the session-close payload. Keep `finalizedUtterances` as the extraction window.

---

### 2 — No runtime validation at WebSocket message boundaries

**Files:** [`apps/gateway/src/index.ts:208`](../apps/gateway/src/index.ts#L208), [`apps/web/src/App.tsx:110`](../apps/web/src/App.tsx#L110)

```typescript
// gateway — casts without validation
const payload = JSON.parse(normalizeSocketMessage(raw)) as ClientSocketMessage;

// frontend — casts without validation
const event = JSON.parse(message.data) as RealtimeEvent;
```

Both sides cast parsed JSON to typed union types with no runtime validation. A malformed message (version mismatch, malicious client, network corruption) will silently produce `undefined` field reads or drop into the wrong `switch` branch. `packages/shared/src/schemas.ts` defines Zod schemas for extraction output but defines no schema for `ClientSocketMessage` or `RealtimeEvent`.

**Fix:** Add `ClientSocketMessageSchema` and `RealtimeEventSchema` to `packages/shared/src/schemas.ts`. Use `safeParse` at each boundary; log and discard messages that fail.

---

### 3 — `patientId` hardcoded as `'demo-patient'` — patient identity is architecturally absent

**Files:** [`apps/gateway/src/index.ts:686`](../apps/gateway/src/index.ts#L686), [`apps/gateway/src/index.ts:866`](../apps/gateway/src/index.ts#L866), [`packages/shared/src/events.ts`](../packages/shared/src/events.ts)

The `ClientSocketMessage` union type for `session.start` has no `patientId` field:

```typescript
// packages/shared/src/events.ts
| {
    type: 'session.start';
    sessionId: string;
    mode: 'demo' | 'live';
    localPersistence?: { postgresOnStop?: boolean };
    audio?: { encoding: 'linear16'; sampleRate: number };
  }
  // ← no patientId
```

Because the identity never arrives, the gateway hardcodes `'demo-patient'` in `runClinicalAgent`, `buildSessionClosePayload`, and `publishSessionClose`. This propagates through the SQS payload, the `NormalizedPerioRecord`, and the PostgreSQL row. Every persisted session record is tagged with a meaningless identifier. For a healthcare application this is fundamental, not cosmetic.

**Fix:** Add `patientId: string` to the `session.start` variant of `ClientSocketMessage`. Thread it through `GatewaySessionState.activePatientId`. Use it everywhere `'demo-patient'` appears today.

---

## Medium

### 4 — `bleedingOnProbing` OR logic overwrites the dedup winner's value

**File:** [`packages/ingestion/src/index.ts:278`](../packages/ingestion/src/index.ts#L278)

```typescript
return {
  ...winner,
  bleedingOnProbing: group.some((finding) => finding.bleedingOnProbing),
```

`selectPreferredFinding` picks the highest-confidence finding as the winner, but then `bleedingOnProbing` is immediately replaced by the OR of all candidates in the group. If an early low-confidence partial said "bleeding" and the final corrected utterance (the winner) explicitly does not, the persisted record still shows `bleedingOnProbing: true`. The work `selectPreferredFinding` does on `bleedingOnProbing` is always discarded.

This may be intentional — conservative clinical policy: flag bleeding if any utterance mentions it. But that intent is neither documented nor obvious from the code, and it contradicts the stated deduplication resolution policy of "highest-confidence-then-latest."

**Fix:** Either document the conservative-OR policy with a comment and name the constant, or change the dedup to trust the winner's `bleedingOnProbing` field, consistent with how every other field is resolved.

---

### 5 — `approximateReceiveCount ?? approximateReceiveCount` tautology in the worker log

**File:** [`apps/worker/src/index.ts:30-31`](../apps/worker/src/index.ts#L30) and [`apps/worker/src/index.ts:58-59`](../apps/worker/src/index.ts#L58)

```typescript
approximateReceiveCount:
  record.attributes.ApproximateReceiveCount ?? record.attributes?.ApproximateReceiveCount,
```

Both sides of `??` access the same property — one with optional chaining, one without. Since `record.attributes` is always defined on a valid SQS record (it is a required field of `SQSRecord`), the optional chaining is redundant and the whole expression is `x ?? x`. This appears in two places, indicating a copy-paste. The correct form used one block earlier (line 12) is `Number(record.attributes.ApproximateReceiveCount ?? 0) || undefined`.

**Fix:** Replace both occurrences with `record.attributes.ApproximateReceiveCount` (or the typed `Number(...)` form if numeric coercion is needed).

---

### 6 — Audio streaming begins before Deepgram is ready; first words are silently dropped

**Files:** [`apps/web/src/App.tsx:267`](../apps/web/src/App.tsx#L267), [`apps/gateway/src/index.ts:632`](../apps/gateway/src/index.ts#L632)

The frontend sends `session.start` and immediately begins streaming PCM chunks in `onaudioprocess` without waiting for a `session.started` acknowledgement. The gateway's `forwardAudioChunk` silently discards chunks when `deepgramSocket.readyState !== OPEN`:

```typescript
function forwardAudioChunk(state: GatewaySessionState, raw: SocketMessage) {
  if (!state.deepgramSocket || state.deepgramSocket.readyState !== WebSocket.OPEN) {
    return;  // silently dropped — no feedback to the client
  }
  // ...
}
```

Deepgram's WebSocket handshake takes 100–500 ms. The first spoken words of every live session are lost with no indication to the user.

**Fix:** Either (a) buffer incoming audio chunks in `GatewaySessionState` until `deepgramSocket` opens and flush them on the `open` event, or (b) have the gateway emit a dedicated `deepgram.ready` trace event and have the frontend delay `onaudioprocess` streaming until it receives it.

---

### 7 — DDL runs on every PostgreSQL connection, not only during migration

**File:** [`apps/worker/src/persistence.ts:41`](../apps/worker/src/persistence.ts#L41)

```typescript
await client.query(CREATE_AURADENT_SESSION_RECORDS_TABLE_SQL);
```

`createPostgresPersistenceAdapter` runs `CREATE TABLE IF NOT EXISTS` on every connection open — every Lambda cold start, every `run:worker-local`, and every gateway session stop with Postgres-on-stop enabled. While harmless due to `IF NOT EXISTS`, this adds DDL round-trip latency to every invocation and couples schema management to the application startup path. A schema change would require coordinating application and migration deployments.

**Fix:** Remove the DDL call from `createPostgresPersistenceAdapter`. Ensure the table exists via a dedicated migration step (the `migrate:worker-local` script already exists locally; the equivalent should run once at deploy time via CDK or a migration Lambda, not on every connection).

---

## Low

### 8 — `ScriptProcessorNode` is deprecated; it runs on the main thread

**File:** [`apps/web/src/App.tsx:240`](../apps/web/src/App.tsx#L240)

```typescript
const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
```

`ScriptProcessorNode` is deprecated in the Web Audio specification and runs on the browser's main JavaScript thread. Under any significant CPU load — React re-renders, tab switches, garbage collection pauses — it produces audio dropouts that manifest as gaps in the Deepgram transcript. `AudioWorkletNode` runs on a dedicated audio rendering thread and is the correct replacement.

**Fix:** Migrate to `AudioWorkletNode` with a small worklet script that encodes float samples to PCM16 and posts them via `port.postMessage`.

---

### 9 — Canvas dimensions force a layout reflow on every animation frame

**File:** [`apps/web/src/App.tsx:192`](../apps/web/src/App.tsx#L192)

```typescript
const render = () => {
  const width = canvas.width = canvas.clientWidth;    // layout read + write on every frame
  const height = canvas.height = canvas.clientHeight;
  // ...
  animation = requestAnimationFrame(render);
};
```

Reading `clientWidth`/`clientHeight` and then assigning to `canvas.width`/`canvas.height` inside the `requestAnimationFrame` loop forces a layout reflow ~60 times per second. Assigning to `canvas.width` also clears the canvas (intentional) but triggering a full layout read-write cycle on every frame is wasteful.

**Fix:** Cache `width` and `height` outside the loop. Use a `ResizeObserver` on the canvas element to update cached dimensions and reset `canvas.width`/`canvas.height` only when the element actually resizes.

---

### 10 — Realistic-looking fake PHI hardcoded in the demo transcript script

**File:** [`apps/gateway/src/index.ts:313`](../apps/gateway/src/index.ts#L313)

```typescript
partial: 'Patient James Brown. Phone number',
final:   'Patient James Brown. Phone number, 415-555-1212.',
```

A real name format and a real-looking phone number are embedded in a version-controlled source file. This content appears in gateway logs, PII redaction test output, session-close payloads, and saved JSON fixtures under `tmp/`. For a healthcare-adjacent codebase, demo fixtures should use identifiers that are obviously synthetic.

**Fix:** Replace with clearly fictional identifiers: `Patient DEMO-001`, phone `555-0100`, consistent with the `'demo-patient'` pattern used elsewhere.

---

### 11 — 350 ms magic-number sleep in the session stop path

**File:** [`apps/gateway/src/index.ts:1025`](../apps/gateway/src/index.ts#L1025)

```typescript
async function waitForRealtimeSettle() {
  await delay(350);
}
```

`finalizeDeepgram` already sends a `Finalize` message and closes the socket after 250 ms. This additional 350 ms delay is unexplained and adds visible latency on every session stop. If it is waiting for Deepgram's final `Results` message to arrive before the extraction queue drains, that should be documented. If it is redundant given the 250 ms close delay, it should be removed.

**Fix:** Either remove the delay (if `finalizeDeepgram`'s 250 ms is sufficient) or replace the magic number with a named constant and a comment explaining why the wait is needed and how the value was chosen.

---

### 12 — Module-scope regex objects with `/g` flag — latent `lastIndex` hazard

**File:** [`packages/shared/src/redaction.ts:26`](../packages/shared/src/redaction.ts#L26)

```typescript
const REDACTION_RULES: RedactionRule[] = [
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, ... },
  { pattern: /(?<!\w)(?:\+?1[-.\s]?)?...\d{4}\b/g, ... },
  // ...
];
```

Regex objects with the `/g` flag maintain a `lastIndex` cursor on the object itself. When used only with `String.prototype.replace()` (as they are today), this is safe — `.replace()` resets `lastIndex` after completing. However, these are module-level singletons. If any future code calls `.test()` or `.exec()` on them without manually resetting `lastIndex`, alternating calls will silently skip matches. This is a common source of hard-to-reproduce redaction failures.

**Fix:** Either construct the regexes fresh on each `redactTranscriptPII` call, or use `new RegExp(source, 'g')` inside the function to ensure no shared state.

---

### 13 — O(n²) byte-offset calculation in the stub PDF builder

**File:** [`packages/ingestion/src/index.ts:196`](../packages/ingestion/src/index.ts#L196)

```typescript
for (const object of objects) {
  offsets.push(Buffer.byteLength(chunks.join('\n'), 'utf8') + 1);
  chunks.push(object);
}
```

`chunks.join('\n')` is recomputed from scratch for every object as `chunks` grows, making the loop O(n²) in total byte length. At five objects this is trivially fast, but the pattern is structurally wrong.

**Fix:** Accumulate a running byte-length counter instead of recomputing the join each iteration:

```typescript
let runningOffset = Buffer.byteLength(chunks[0] + '\n', 'utf8');
for (const object of objects) {
  offsets.push(runningOffset);
  runningOffset += Buffer.byteLength(object + '\n', 'utf8');
  chunks.push(object);
}
```

---

## Recommended Fix Order

The three critical findings are the most impactful and establish the foundation for everything else:

1. **Finding #3** — Add `patientId` to `ClientSocketMessage` and thread it through `GatewaySessionState`. This is a shared contract change and must land before other agents touch the gateway or frontend.
2. **Finding #2** — Add Zod schemas for `ClientSocketMessage` and `RealtimeEvent`; validate at both WebSocket boundaries.
3. **Finding #1** — Separate the extraction rolling window from the full transcript accumulation in `GatewaySessionState`.

The medium findings (#4–#7) can be addressed in parallel across their respective workstreams. The low findings (#8–#13) are incremental improvements that do not block any functional milestone.
