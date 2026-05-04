# AuraDent Agentic Harness Plan

## Goal

Add a `.claude/skills/` directory with purpose-built skill files that give Claude (and dispatched subagents) the domain context needed to complete the remaining in-progress implementation work without repeatedly re-deriving project conventions.

## Why Skills Over CLAUDE.md Alone

CLAUDE.md covers universal project rules (commands, TypeScript conventions, test runner). Skills go further: they encode the *how* for specific domains — the exact API shape of Deepgram's WebSocket protocol, the Vercel AI SDK v5 call patterns, the invariants of `GatewaySessionState`, the SQS idempotency requirements. Without these, an agent working on any of the in-progress items will either hallucinate conventions or spend many turns re-reading source before making useful progress.

---

## In-Progress Work That Needs Coverage

From `docs/implementation-plan.md`:

| Area | In-Progress Item |
|---|---|
| Gateway | Deepgram live transcription wiring |
| Gateway | Transcript revision reconciliation for partials/finals |
| Gateway | Session lifecycle shape + Deepgram reconnect/retry handling |
| Agent Core | Replace heuristic fallback with Vercel AI SDK orchestration |
| Agent Core | Typed practice-management tool definitions + execution flow |
| Agent Core | Validate extraction output with shared Zod schemas |
| Ingestion | Provenance + replay support for normalized records |
| Worker/Infra | Harden PostgreSQL rollout, SQS retry semantics, audit metadata |
| Stage 7 | Expand unit + integration test coverage across all packages |
| Stage 7 | DLQ operational coverage and observability hardening |

These cluster into three largely independent workstreams plus one cross-cutting concern:

```
Workstream A: Real-time path      — gateway, Deepgram, transcript revisions
Workstream B: AI agent path       — agent-core, Vercel AI SDK, tool registry
Workstream C: Async backend       — worker, PostgreSQL, SQS/DLQ, infra
Cross-cutting: Test coverage      — Node test runner, co-location, integration tests
```

Workstreams A, B, and C are safe to parallelize — they share contracts via `packages/shared` but do not write to each other's files during implementation.

---

## Proposed Skills

### Skill 1: `deepgram-live-transcription.md`

**Trigger:** Working on `apps/gateway/src/` to wire live Deepgram streaming, or modifying transcript revision/reconnect logic.

**What it encodes:**
- Deepgram streaming WebSocket URL format and query parameter conventions (`encoding`, `sample_rate`, `model`, `interim_results`, `endpointing`).
- The shape of Deepgram `TranscriptMessage` JSON — `channel.alternatives[0].transcript`, `is_final`, `speech_final` fields.
- How partial vs. final events map to `transcript.partial` / `transcript.final` realtime events in `packages/shared/src/events.ts`.
- How to call `reconcileTranscriptRevision()` in `transcript-revisions.ts` on each incoming Deepgram message and when to trigger extraction.
- Deepgram KeepAlive message timing (every 8–10 s while silent).
- How to integrate with `getDeepgramReconnectDelayMs()` / `shouldRetryDeepgramSession()` from `deepgram-retry.ts` — the hooks already exist, just need to be called from the right places.
- Where to gate structured extraction calls (`hasClinicalSignal`, `isReadyForStructuredExtraction` in `extraction-gating.ts`).
- Which fields in `GatewaySessionState` own Deepgram lifecycle state (`deepgramSocket`, `deepgramKeepAlive`, `deepgramOpenedAt`, `deepgramReconnectAttempt`, `deepgramReconnectTimer`).

**Why a dedicated skill:** Deepgram's WebSocket API has non-obvious quirks (keepalive cadence, `speech_final` vs. `is_final` semantics, binary audio framing). Without this, an agent will write plausible-looking but subtly wrong integration code.

---

### Skill 2: `ai-sdk-agent-orchestration.md`

**Trigger:** Working on `packages/agent-core/src/index.ts` to replace or extend the heuristic fallback with real Vercel AI SDK orchestration.

**What it encodes:**
- Vercel AI SDK v5 call patterns: `generateObject()` with `zodSchema()`, `generateText()` with `tool()` definitions, `streamText()` if streaming output is needed.
- How `tool()` is typed — `inputSchema`, `execute` async function, return type — using the existing `check_patient_history` and `update_perio_chart` stubs as canonical models.
- `AgentExtractionSchema` / `PerioFindingSchema` from `packages/shared/src/schemas.ts` — these are the output schemas; `generateObject` should target `AgentExtractionSchema` directly.
- Confidence scoring policy: how confidence maps from model output to the `confidence` field on `PerioFinding`.
- Trace event emission pattern: each agent step should push to `traceEvents[]` with the `step` / `detail` / `confidence` shape matching `AgentTraceEvent`.
- The heuristic fallback contract in `runHeuristicFallback()` — new code must preserve the same `ClinicalAgentResult` return shape so the gateway doesn't need to change.
- When `AI_GATEWAY_API_KEY` is absent, fall through to heuristic immediately (existing guard, must be preserved).
- Model selection via `AURADENT_AGENT_MODEL` env var — the provider prefix format (`openai/gpt-4.1-mini`, `anthropic/claude-...`) expected by the AI gateway.

**Why a dedicated skill:** Vercel AI SDK v5 has a different API surface than v3/v4. The `zodSchema()` wrapper, the `tool()` type parameters, and `generateObject` output modes are easy to get wrong. This skill gives an agent the exact call signatures so it doesn't have to guess or use outdated patterns.

---

### Skill 3: `gateway-session-state.md`

**Trigger:** Any work touching `apps/gateway/src/index.ts` — adding new session behaviors, modifying the session lifecycle, or debugging state transitions.

**What it encodes:**
- The full `GatewaySessionState` type and what each field is responsible for — especially the ones with subtle invariants (`extractionChain`, `pendingExtractions`, `completedExtractionSequence`, `isStopping`).
- The extraction sequencing contract: each extraction must await the previous chain link; `completedExtractionSequence` must increment monotonically; results arriving out of order must be discarded.
- Session stop sequence: drain pending extractions, build session-close payload via `buildSessionClosePayload()`, write to disk, optionally enqueue to SQS, optionally call `withSessionPersistence()` for local PostgreSQL — in that order.
- Demo vs. live mode branching: `mode === 'demo'` drives the mock event loop; `mode === 'live'` drives Deepgram + extraction. The gate is `ClientSocketMessage.mode`.
- Event emission helper — the `send(event: RealtimeEvent)` closure pattern used throughout the handler — new code should use it, not write directly to the socket.
- Safety fields: `isStopping` guards against concurrent stop calls; `demoTimers` must be cleared on stop; `deepgramReconnectTimer` must be cleared on stop.

**Why a dedicated skill:** `GatewaySessionState` has ~20 fields with non-obvious invariants. An agent adding a new behavior without knowing the extraction sequencing contract will introduce race conditions that are hard to catch in unit tests.

---

### Skill 4: `worker-persistence-hardening.md`

**Trigger:** Working on `apps/worker/src/`, `infra/aws/`, or adding PostgreSQL / SQS retry semantics.

**What it encodes:**
- SQS visibility timeout and retry contract: messages become visible again after timeout expires; the Lambda handler must be idempotent. The `dedupeKey` hash in `NormalizedPerioRecord.provenance` is the idempotency anchor — upsert on it, don't insert blindly.
- DLQ threshold: after `maxReceiveCount` (set in CDK), SQS moves the message to the DLQ. The worker should emit a structured log line on each receive so the receive count is observable.
- Audit metadata fields that are in-progress: processing duration (`startedAt` / `completedAt`), receive count (from SQS `ApproximateReceiveCount` attribute), payload integrity hash (SHA-256 of raw SQS body), record integrity hash (SHA-256 of serialized `NormalizedPerioRecord[]`).
- PostgreSQL upsert pattern for the `perio_findings` table: `INSERT ... ON CONFLICT (dedupe_key) DO UPDATE SET ...` — never a plain insert.
- `withSessionPersistence()` wrapper contract: it wraps `processSessionClosePayload()` and the persistence call; new persistence paths should go inside it, not alongside it.
- Local vs. Lambda path: `AURADENT_DATABASE_URL` present → PostgreSQL; absent → JSONL fallback at `AURADENT_PERSISTENCE_FILE`. Both paths must produce the same `SessionRecord` shape.
- Artifact storage: `artifact-store.ts` owns all PDF write logic. Don't write artifact files elsewhere.

**Why a dedicated skill:** SQS idempotency + PostgreSQL upsert semantics are easy to implement incorrectly. A naive insert-on-conflict will silently drop revised findings. This skill prevents that class of bugs.

---

### Skill 5: `auradent-test-writing.md`

**Trigger:** Adding or modifying any test file in the project.

**What it encodes:**
- Test runner: Node.js built-in `node:test`, imported as `import { test, describe, it } from 'node:test'` and `import assert from 'node:assert/strict'`. No Jest, no Vitest, no `expect()`.
- File co-location: `src/**/*.test.ts` for unit/module tests. The only exception is `test/session-close-replay.test.ts` (cross-boundary integration).
- How to run a single test file: `tsx --test src/foo.test.ts`.
- The integration test pattern (`test/session-close-replay.test.ts` as the canonical model): load a fixture JSON payload, call the processing function directly, assert on the persisted output without spinning up a real server.
- Existing test files as models for each area:
  - PII redaction: `packages/shared/src/redaction.test.ts`
  - Extraction gating: `apps/gateway/src/extraction-gating.test.ts`
  - Session-close payload: `apps/gateway/src/session-close.test.ts`
  - Transcript revisions: `apps/gateway/src/transcript-revisions.test.ts`
  - Ingestion normalization: `packages/ingestion/src/index.test.ts`
  - Worker persistence: `apps/worker/src/process-session-close.test.ts`
- What NOT to test: internal helper functions that are not exported. Test the exported surface only.
- Fixture strategy: prefer inline data over external fixture files unless the fixture is large (>50 lines of JSON). The integration test is the exception.

**Why a dedicated skill:** Developers default to Jest patterns (`describe`/`it`/`expect`). The Node built-in runner has different import paths and assertion style. A skill prevents an agent from writing syntactically valid but incompatible test code.

---

### Skill 6: `auradent-parallel-dispatch.md`

**Trigger:** Tasked with completing multiple in-progress items across different workstreams simultaneously, or starting a large feature that touches gateway + agent-core + frontend.

**What it encodes:**
- The three independent workstreams and their file boundaries (A: gateway, B: agent-core, C: worker/infra).
- Dispatch order when working in parallel: always complete shared contract changes in `packages/shared` first (blocking), then dispatch A, B, C as parallel agents.
- Per-agent context to include: each agent should receive the relevant skill (Skill 1 for A, Skill 2 for B, Skill 4 for C) plus the general CLAUDE.md conventions.
- Review checkpoint: after each parallel batch, run `npm run typecheck` and `npm run test` before dispatching the next batch. Cross-boundary type errors surface here.
- When NOT to parallelize: if one workstream's output is another's input (e.g., a new event type in `packages/shared/events.ts` must be merged before gateway and frontend agents can consume it).

**Why a dedicated skill:** Without explicit dispatch instructions, a single agent working across all three areas will interleave changes, hit merge conflicts with itself, and produce harder-to-review diffs. This skill makes the parallelization strategy explicit.

---

## Proposed File Structure

```
.claude/
  skills/
    deepgram-live-transcription.md   # Workstream A — Deepgram protocol + transcript revisions
    ai-sdk-agent-orchestration.md    # Workstream B — Vercel AI SDK v5 patterns + tool registry
    gateway-session-state.md         # Workstream A — GatewaySessionState invariants
    worker-persistence-hardening.md  # Workstream C — SQS idempotency + PostgreSQL upsert + audit
    auradent-test-writing.md         # Cross-cutting — Node test runner patterns
    auradent-parallel-dispatch.md    # Meta — multi-agent coordination strategy
```

---

## Skill Trigger Map

| Task | Skills to invoke |
|---|---|
| Wire Deepgram live transcription | `deepgram-live-transcription` + `gateway-session-state` |
| Complete AI SDK agent orchestration | `ai-sdk-agent-orchestration` |
| Harden worker persistence + DLQ | `worker-persistence-hardening` |
| Add any test file | `auradent-test-writing` |
| Work on gateway session lifecycle | `gateway-session-state` |
| Multi-area feature (e.g., new finding type) | `auradent-parallel-dispatch` first, then area skills |

---

## Implementation Sequence (for when this plan is executed)

1. Create `.claude/skills/` directory.
2. Write `auradent-test-writing.md` first — it is the lowest-risk skill and validates the harness setup.
3. Write `gateway-session-state.md` — foundational for any gateway work.
4. Write `deepgram-live-transcription.md` — builds on session state skill.
5. Write `ai-sdk-agent-orchestration.md` — independent of gateway skills.
6. Write `worker-persistence-hardening.md` — independent of gateway/agent skills.
7. Write `auradent-parallel-dispatch.md` last — references the other five skills by name.

Each skill should be validated by using it on one real in-progress task before moving to the next.
