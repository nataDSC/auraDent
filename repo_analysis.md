# AuraDent — Repository Analysis

## What the Project Does

AuraDent is a real-time dental documentation platform. It captures live chairside speech, transcribes it, redacts PII, extracts structured periodontal findings via an AI agent, and animates those findings into a dental chart UI. At session close it enqueues a payload to AWS SQS for Lambda-based post-processing (PDF generation, insurance pre-auth, PostgreSQL persistence).

---

## Monorepo Layout

```
apps/
  gateway/    Fastify WebSocket server — Deepgram integration, PII redaction, agent orchestration, SQS publish
  web/        React + Vite ambient dashboard — waveform, transcript, trace, chart, metrics UI
  worker/     Lambda-style session wrap-up — PDF generation, insurance pre-auth, PostgreSQL persistence
packages/
  agent-core/ Vercel AI SDK clinical agent with heuristic fallback
  ingestion/  Normalization + deduplication of agent output into DB-ready records
  shared/     Typed event contracts, Zod schemas, PII redaction middleware
infra/
  aws/        CDK stack — SQS queue, DLQ, Lambda, event source mapping
docs/         Design doc, investor brief, implementation plan, HuggingFace deployment guide
test/         Cross-boundary integration test (gateway payload → worker persistence)
```

### Package dependency graph

```
apps/web         → packages/shared
apps/gateway     → packages/shared, packages/agent-core, apps/worker
apps/worker      → packages/shared, packages/ingestion
packages/agent-core  → packages/shared
packages/ingestion   → packages/shared
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript 5.8, ESNext modules |
| Frontend | React 19, Vite 7, Framer Motion 12 |
| Backend (gateway) | Fastify 5, `@fastify/websocket`, `ws` |
| AI agent | Vercel AI SDK v5 (`ai`), configurable model via `AURADENT_AGENT_MODEL` |
| Speech-to-text | Deepgram (WebSocket streaming, nova-3 model) |
| Schema validation | Zod 4 |
| AWS | `@aws-sdk/client-sqs`, AWS CDK (infra/aws) |
| Database | PostgreSQL via `pg`; JSONL file fallback for local dev |
| Package manager | npm 11 workspaces |
| Test runner | Node.js built-in `--test` runner via `tsx` |
| TypeScript execution | `tsx` (dev + scripts) |

---

## Key Source Files

| File | Responsibility |
|---|---|
| `packages/shared/src/events.ts` | `RealtimeEvent`, `ClientSocketMessage`, `SessionClosePayload` types |
| `packages/shared/src/schemas.ts` | Zod schemas: `AgentExtractionSchema`, `PerioFindingSchema` |
| `packages/shared/src/redaction.ts` | PII redaction middleware (regex-based, with regression tests) |
| `packages/agent-core/src/index.ts` | `runClinicalAgent()` — AI SDK agent with mock practice tools, heuristic fallback |
| `apps/gateway/src/index.ts` | WebSocket session handler, Deepgram integration, SQS publish on close |
| `apps/gateway/src/session-close.ts` | `buildSessionClosePayload()`, `writeSessionClosePayloadToDisk()` |
| `apps/gateway/src/extraction-gating.ts` | Heuristics for when to trigger structured extraction |
| `apps/gateway/src/transcript-revisions.ts` | Reconcile partial/final transcript updates |
| `apps/gateway/src/deepgram-retry.ts` | Backoff + retry logic for Deepgram reconnects |
| `packages/ingestion/src/index.ts` | `normalizeExtraction()`, deduplication + provenance tracking |
| `apps/worker/src/process-session-close.ts` | Lambda handler + `withSessionPersistence()` orchestrator |
| `apps/worker/src/persistence.ts` | PostgreSQL write path + JSONL fallback |
| `apps/worker/src/artifact-store.ts` | PDF artifact storage to disk / Lambda `/tmp` |
| `apps/worker/src/readback-format.ts` | Human-readable session record summaries |
| `apps/web/src/App.tsx` | Entire React frontend — WebSocket client, mic capture, UI panels |

---

## How to Run the Project

### Install

```bash
npm install
```

### Local demo (no API keys needed)

```bash
# Terminal 1 — gateway with mocked transcript/trace events
npm run dev:gateway

# Terminal 2 — Vite frontend
npm run dev:web
```

Frontend: `http://localhost:5173`  
Gateway WebSocket: `ws://localhost:8787/realtime/session/demo-session`

### Live microphone mode (requires API keys)

```bash
export DEEPGRAM_API_KEY=your_key
export DEEPGRAM_MODEL=nova-3
export AI_GATEWAY_API_KEY=your_key
export AURADENT_AGENT_MODEL=openai/gpt-4.1-mini
export AURADENT_AWS_REGION=us-east-1
export AURADENT_SESSION_CLOSE_QUEUE_URL=your_sqs_url
npm run dev:gateway
```

### Worker local replay (no AWS)

```bash
# Run against the latest saved session-close payload
npm run run:worker-local -- "<repo-root>/tmp/session-close/latest-session-close.json"
```

### Local PostgreSQL

```bash
export AURADENT_DATABASE_URL="postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres"
export AURADENT_DATABASE_SSL=disable

npm run migrate:worker-local   # create tables
npm run readback:worker-local  # print all sessions
npm run readback:worker-local -- demo-session --full  # single session, full payload
```

### AWS infra (CDK)

```bash
npm run synth --workspace @auradent/aws-infra
npm run deploy --workspace @auradent/aws-infra
npm run destroy --workspace @auradent/aws-infra
```

---

## How to Run Tests

```bash
# All tests (integration + per-package unit tests)
npm run test

# Integration tests only (cross-boundary gateway→worker replay)
npm run test:integration

# Per-package tests
npm run test --workspace @auradent/shared
npm run test --workspace @auradent/gateway
npm run test --workspace @auradent/ingestion
npm run test --workspace @auradent/worker
```

Tests use Node.js's built-in test runner (`node:test`) executed via `tsx --test`.

### Test coverage areas

| Location | What's covered |
|---|---|
| `packages/shared/src/redaction.test.ts` | PII redaction: possessives, loose phone numbers, mixed identifiers |
| `apps/gateway/src/extraction-gating.test.ts` | Extraction gate heuristics |
| `apps/gateway/src/session-close.test.ts` | Session-close payload assembly |
| `apps/gateway/src/transcript-revisions.test.ts` | Partial/final transcript reconciliation |
| `apps/gateway/src/deepgram-retry.test.ts` | Deepgram reconnect backoff |
| `packages/ingestion/src/index.test.ts` | Normalization + deduplication |
| `apps/worker/src/index.test.ts` | Worker entrypoint |
| `apps/worker/src/process-session-close.test.ts` | Session-close processing |
| `apps/worker/src/readback-format.test.ts` | Human-readable record formatting |
| `test/session-close-replay.test.ts` | End-to-end: saved gateway payload → worker persistence |

### Type checking

```bash
npm run typecheck
```

### Build

```bash
npm run build
```

---

## Environment Variables Reference

| Variable | Used by | Purpose |
|---|---|---|
| `DEEPGRAM_API_KEY` | gateway | Live Deepgram transcription |
| `DEEPGRAM_MODEL` | gateway | Deepgram model (e.g. `nova-3`) |
| `AI_GATEWAY_API_KEY` | agent-core | AI model provider API key |
| `AURADENT_AGENT_MODEL` | agent-core | Model ID (e.g. `openai/gpt-4.1-mini`) |
| `AURADENT_AWS_REGION` | gateway, infra | AWS region for SQS |
| `AURADENT_SESSION_CLOSE_QUEUE_URL` | gateway | SQS queue URL; omit to log locally |
| `AURADENT_DATABASE_URL` | worker, gateway | PostgreSQL connection string |
| `AURADENT_DATABASE_SSL` | worker | Set `disable` for local Supabase |
| `AURADENT_SESSION_CLOSE_OUTPUT_DIR` | gateway | Override directory for saved payloads |
| `AURADENT_PERSISTENCE_FILE` | worker | JSONL fallback path (no DB) |
| `AURADENT_ARTIFACT_OUTPUT_DIR` | worker | PDF output directory |

---

## Implementation Status Summary

**Complete:** monorepo scaffold, shared contracts, React dashboard, Fastify WebSocket gateway, browser mic capture, PII redaction, agent lifecycle trace, ingestion normalization + deduplication, worker entrypoints (PDF, insurance pre-auth, PostgreSQL), SQS publisher, CDK async stack (deployed to us-east-1), session-close payload assembly + local saving, worker local replay, HuggingFace Docker Space scaffold, WebSocket reconnect handling (client + Deepgram), per-run unique session IDs, TTFT/latency metrics.

**In progress:** full Deepgram live transcription wiring, Vercel AI SDK orchestration (currently falls back to heuristics without `AI_GATEWAY_API_KEY`), transcript revision reconciliation, PostgreSQL production rollout, test coverage expansion, worker audit metadata.
