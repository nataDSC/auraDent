---
name: deepgram-live-transcription
description: Use when wiring or modifying Deepgram live transcription in apps/gateway/src/ — including the WebSocket client, transcript revision reconciliation, keepalive, reconnect logic, and extraction gating.
---

# Deepgram Live Transcription

**Read `gateway-session-state` skill first** — this skill builds on top of it.

## Deepgram WebSocket URL

The URL is already constructed in `connectDeepgramSession()`:

```typescript
const deepgramUrl = new URL('wss://api.deepgram.com/v1/listen');
deepgramUrl.searchParams.set('model', process.env.DEEPGRAM_MODEL ?? 'nova-3');
deepgramUrl.searchParams.set('language', 'en-US');
deepgramUrl.searchParams.set('encoding', 'linear16');
deepgramUrl.searchParams.set('sample_rate', String(audioSampleRate));
deepgramUrl.searchParams.set('interim_results', 'true');
deepgramUrl.searchParams.set('smart_format', 'true');
deepgramUrl.searchParams.set('punctuate', 'true');
```

The API key goes in the `Authorization` header, not a query param:

```typescript
const deepgramSocket = new WebSocket(deepgramUrl, {
  headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
});
```

## Incoming Message Shape

Deepgram sends JSON `Results` messages. The type is already defined:

```typescript
type DeepgramTranscriptMessage = {
  type?: string;           // 'Results' for transcript events
  is_final?: boolean;      // true when Deepgram has committed this utterance
  speech_final?: boolean;  // true at natural speech boundaries (end of sentence)
  start?: number;          // utterance start time in seconds (used for utterance ID)
  duration?: number;       // utterance duration in seconds (used for finalization latency)
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
    }>;
  };
};
```

**`is_final` vs `speech_final`:** Use `is_final` as the gate for finalization and extraction. `speech_final` is informational only. A message can have `speech_final: true` but `is_final: false` during interim processing.

**Utterance ID derivation** (use the existing `getUtteranceId()` helper):

```typescript
function getUtteranceId(message: DeepgramTranscriptMessage, state: GatewaySessionState) {
  if (typeof message.start === 'number') {
    return `utt-${Math.round(message.start * 1000)}`;  // milliseconds from start time
  }
  state.transcriptCounter += 1;
  return `utt-${String(state.transcriptCounter).padStart(4, '0')}`;  // fallback counter
}
```

## Message Handling Flow

The full flow for each incoming Deepgram message (already implemented — follow this when adding behavior):

```typescript
deepgramSocket.on('message', (message) => {
  const parsed = safeParseJson<DeepgramTranscriptMessage>(...);
  if (!parsed || parsed.type !== 'Results') return;  // ignore non-transcript messages

  const alternative = parsed.channel?.alternatives?.[0];
  const transcript = alternative?.transcript?.trim();
  if (!transcript) return;  // skip empty results

  const utteranceId = getUtteranceId(parsed, state);

  // 1. Run through transcript revision store (deduplicates partial/final updates)
  const revision = reconcileTranscriptRevision({
    utteranceId,
    text: transcript,
    isFinal: Boolean(parsed.is_final),
    store: state.transcriptRevisions,
  });
  state.transcriptRevisions = revision.nextStore;

  if (!revision.shouldEmit) return;  // identical to prior state — skip

  // 2. TTFT (emits once per session)
  if (!state.hasEmittedTtft && typeof state.deepgramOpenedAt === 'number') {
    state.hasEmittedTtft = true;
    send({ type: 'metric', name: 'ttft', value: Date.now() - state.deepgramOpenedAt, unit: 'ms', ts });
  }

  // 3. Emit transcript event (partial or final)
  const finalRedaction = parsed.is_final ? redactTranscriptPII(revision.text) : null;
  send(parsed.is_final
    ? { type: 'transcript.final', utteranceId, text: revision.text,
        redactedText: finalRedaction?.matches.length ? finalRedaction.text : undefined, ts }
    : { type: 'transcript.partial', utteranceId, text: revision.text, ts }
  );

  // 4. On final: record utterance, emit finalization latency, gate extraction
  if (parsed.is_final) {
    recordFinalUtterance(state, utteranceId, revision.text);
    sendTrace('transcript.finalized', `Deepgram finalized utterance ${utteranceId}.`, alternative?.confidence);

    // finalization latency metric
    if (typeof state.deepgramOpenedAt === 'number' && typeof parsed.start === 'number' && typeof parsed.duration === 'number') {
      send({ type: 'metric', name: 'finalization_latency',
             value: Math.max(0, Date.now() - state.deepgramOpenedAt - Math.round((parsed.start + parsed.duration) * 1000)),
             unit: 'ms', ts });
    }
  }

  // 5. Queue extraction only when revision says so (is_final + passes gating)
  if (revision.shouldQueueExtraction) {
    const transcriptWindow = getTranscriptWindow(state, utteranceId);
    queueExtraction(state, () => emitStructuredFindings({ send, sendTrace, sessionId, transcript: transcriptWindow, currentUtteranceText: revision.text, utteranceId }).catch(...));
  }
});
```

## Transcript Revision Reconciliation

`reconcileTranscriptRevision()` in `transcript-revisions.ts` handles the Deepgram partial→final update problem. Call it for every non-empty transcript and use the result:

```typescript
const revision = reconcileTranscriptRevision({
  utteranceId,
  text: transcript,
  isFinal: Boolean(parsed.is_final),
  store: state.transcriptRevisions,
});
state.transcriptRevisions = revision.nextStore;  // always update the store

// revision.shouldEmit — false if text is identical to prior state
// revision.shouldQueueExtraction — true only for is_final events that changed
// revision.text — the normalized (trimmed) text to use
// revision.type — 'partial' | 'final'
```

Key rules the reconciler enforces:
- A partial that arrives after a final for the same utteranceId is silently dropped (`shouldEmit: false`).
- A duplicate final (same text, same utteranceId) is silently dropped.
- `shouldQueueExtraction` is only `true` on `is_final` events that changed the store.

## Extraction Gating

Before queuing extraction, `emitStructuredFindings()` runs two checks from `extraction-gating.ts`:

```typescript
// Check 1: does the redacted transcript contain any clinical terms?
if (!isReadyForStructuredExtraction(redaction.text)) {
  if (hasClinicalSignal(redaction.text)) {
    sendTrace('agent.deferred', 'Deferred: clinical signal present but no explicit tooth reference.', 0.88);
  }
  return;  // bail without calling runClinicalAgent
}
```

`isReadyForStructuredExtraction` requires both a clinical signal (pocket depth, bleeding, recession, etc.) AND an explicit tooth reference (`tooth 14`, `#14`, `tooth fourteen`). Speech without a tooth number is deferred, not dropped.

## KeepAlive

The keepalive interval runs every 3 seconds and sends a `KeepAlive` JSON message only when the audio has been idle for ≥3 seconds:

```typescript
state.deepgramKeepAlive = setInterval(() => {
  if (!state.deepgramSocket || state.deepgramSocket.readyState !== WebSocket.OPEN) return;
  if (Date.now() - (state.lastAudioAt ?? 0) >= 3000) {
    state.deepgramSocket.send(JSON.stringify({ type: 'KeepAlive' }));
  }
}, 3000);
```

`state.lastAudioAt` is updated on every forwarded audio chunk in `forwardAudioChunk()`.

## Reconnect Logic

Reconnect is fully implemented via three helpers in `deepgram-retry.ts`:

```typescript
MAX_DEEPGRAM_RETRY_ATTEMPTS = 3

getDeepgramReconnectDelayMs(attempt: number): number
// Exponential backoff: 500ms, 1000ms, 2000ms, capped at 4000ms

shouldRetryDeepgramSession({ attempt, hasAudioSampleRate, isStopping }): boolean
// Returns false if: isStopping, no audio sample rate, or attempt >= MAX
```

On socket `close`, the handler checks `shouldRetryDeepgramSession` and schedules a `setTimeout` via `state.deepgramReconnectTimer`. The retry calls `connectDeepgramSession()` with `isRetry: true`.

**When adding new reconnect behavior:** modify `shouldRetryDeepgramSession` or `getDeepgramReconnectDelayMs` in `deepgram-retry.ts` — don't add reconnect logic directly into the `close` handler.

## Sending Audio to Deepgram

`forwardAudioChunk()` already handles binary WebSocket messages:

```typescript
function forwardAudioChunk(state: GatewaySessionState, raw: SocketMessage) {
  if (!state.deepgramSocket || state.deepgramSocket.readyState !== WebSocket.OPEN) return;
  state.lastAudioAt = Date.now();
  const chunk = toBuffer(raw);
  if (chunk.byteLength === 0) return;
  state.deepgramSocket.send(chunk);  // raw linear16 PCM bytes
}
```

The browser sends PCM16 chunks as binary WebSocket frames. The gateway's `socket.on('message')` handler checks `isBinary` and routes to `forwardAudioChunk`.

## Finalizing Deepgram on Session Stop

```typescript
function finalizeDeepgram(state: GatewaySessionState) {
  if (!state.deepgramSocket || state.deepgramSocket.readyState !== WebSocket.OPEN) return;
  state.deepgramSocket.send(JSON.stringify({ type: 'Finalize' }));
  setTimeout(() => { state.deepgramSocket?.close(); }, 250);
}
```

The `Finalize` message tells Deepgram to flush its buffer and return any pending transcript. The 250ms delay allows the final `Results` message to arrive before the socket is closed.
