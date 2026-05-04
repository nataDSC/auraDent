---
name: auradent-parallel-dispatch
description: Use when tasked with completing multiple in-progress items across different workstreams simultaneously, or when starting a feature that touches gateway, agent-core, and frontend together. Defines safe parallelization boundaries and dispatch order.
---

# AuraDent Parallel Agent Dispatch

## The Three Independent Workstreams

These workstreams do not write to each other's files and can run in parallel:

| Workstream | Files owned | Companion skill |
|---|---|---|
| A — Real-time path | `apps/gateway/src/` | `gateway-session-state`, `deepgram-live-transcription` |
| B — AI agent path | `packages/agent-core/src/` | `ai-sdk-agent-orchestration` |
| C — Async backend | `apps/worker/src/`, `infra/aws/` | `worker-persistence-hardening` |

Cross-cutting (sequential, not parallel):

| Area | Files owned | Companion skill |
|---|---|---|
| Shared contracts | `packages/shared/src/` | (must land before A/B/C use new types) |
| Tests | `**/*.test.ts` | `auradent-test-writing` |
| Frontend | `apps/web/src/` | (depends on shared event types) |

## When to Parallelize

**Safe to parallelize:**
- A + B (gateway changes + agent-core changes that share no in-flight file edits)
- A + C (gateway session-close + worker hardening)
- B + C (agent orchestration + persistence hardening)
- A + B + C simultaneously when all changes are in owned files only

**Must be sequential:**
- Any change to `packages/shared/src/events.ts` or `schemas.ts` → must merge before dispatching agents that consume the new type
- Frontend changes that consume new `RealtimeEvent` types → must wait for shared contract change
- Test coverage for a new feature → must wait for the feature to exist

## Dispatch Protocol

### Step 1: Check for shared contract changes

If the task requires a new event type, schema field, or exported type in `packages/shared/`:

1. Make and merge that change first (single agent or inline).
2. Run `npm run typecheck` to confirm the change compiles.
3. Only then dispatch parallel agents for A, B, C.

### Step 2: Dispatch parallel agents

Each agent dispatch must include:
- The relevant companion skill for its workstream
- `auradent-test-writing` skill (all agents should add tests)
- A clear file boundary statement: "Only modify files in `apps/gateway/src/`"

Example dispatch plan:

```
Agent A (Workstream A — Real-time):
  Skills: gateway-session-state, deepgram-live-transcription, auradent-test-writing
  Task: Wire Deepgram live transcription — replace TODO stubs in connectDeepgramSession()
  File boundary: apps/gateway/src/ only

Agent B (Workstream B — Agent):
  Skills: ai-sdk-agent-orchestration, auradent-test-writing
  Task: Complete Vercel AI SDK orchestration path — ensure AI gateway path works end-to-end
  File boundary: packages/agent-core/src/ only

Agent C (Workstream C — Backend):
  Skills: worker-persistence-hardening, auradent-test-writing
  Task: Add approximateReceiveCount logging and DLQ-safe error propagation
  File boundary: apps/worker/src/ only
```

### Step 3: Review checkpoint

After all parallel agents complete:

```bash
npm run typecheck          # catches cross-boundary type errors
npm run test               # full suite: unit + integration
npm run build              # ensures no import resolution issues
```

Fix any failures before proceeding. Cross-boundary type errors (e.g., agent B added a new field to `ClinicalAgentResult` that agent A now reads incorrectly) surface here.

### Step 4: Integration smoke test

If gateway + agent-core both changed:

```bash
npm run dev:gateway &
# Then test via the UI or send a WebSocket session.start message
# Confirm trace events flow correctly end-to-end
```

If worker changed:

```bash
npm run run:worker-local -- "<repo-root>/tmp/session-close/latest-session-close.json"
# Confirm summary output matches expected fields
```

## File Ownership Reference

An agent must not write to files outside its assigned workstream. If a task requires a cross-boundary change, escalate — don't silently cross the boundary.

```
apps/gateway/src/          → Workstream A only
apps/web/src/              → Frontend only (sequential)
apps/worker/src/           → Workstream C only
packages/agent-core/src/   → Workstream B only
packages/ingestion/src/    → Workstream C (ingestion is part of the worker pipeline)
packages/shared/src/       → Sequential pre-step only
infra/aws/                 → Workstream C only
test/                      → Sequential post-step or cross-cutting
```

## Common Parallel Scenarios

### Completing all remaining in-progress items

Sequential first:
1. Verify `packages/shared` has all needed types (check `events.ts`, `schemas.ts`)

Parallel batch 1:
- Agent A: Deepgram live transcription + transcript revision wiring
- Agent B: AI SDK agent orchestration (full path, not just fallback)
- Agent C: Worker audit metadata + DLQ-safe error handling

Sequential after batch 1:
- `npm run typecheck && npm run test`

Parallel batch 2:
- Agent A (tests): gateway test coverage for new Deepgram behavior
- Agent B (tests): agent-core test for AI SDK path
- Agent C (tests): worker persistence + replay test hardening

### Adding a new finding type to the clinical model

Sequential:
1. Add new fields to `PerioFindingSchema` and `AgentExtractionSchema` in `packages/shared/src/schemas.ts`
2. `npm run typecheck`

Parallel:
- Agent B: update `runClinicalAgent` extraction logic and heuristic fallback
- Agent C: update `normalizeExtraction` in `packages/ingestion` and persistence schema if needed

Sequential after:
- Agent A: update `emitStructuredFindings` and `PersistedFindingPayload` in gateway to surface new fields
- Frontend: update chart card rendering in `apps/web/src/App.tsx`
