# AuraDent Implementation Plan

## Objective

Build an MVP of AuraDent that supports live audio streaming, partial/final transcription rendering, structured perio extraction, chart updates, session trace visibility, and asynchronous session-close processing.

## Implementation status checklist

Status legend:

- `Completed`: implemented in the current repo scaffold.
- `In Progress`: started, but still mocked, partial, or awaiting verification/integration.
- `Planned`: not yet implemented.

### Stage 1: Contracts and repository skeleton

- `Completed` Define the monorepo app and package boundaries.
- `Completed` Add root workspace configuration, shared TypeScript base config, and starter package manifests.
- `Completed` Define shared real-time event contracts.
- `Completed` Define starter Zod schemas for extraction payloads and session-close data.

### Stage 2: Frontend ambient dashboard

- `Completed` Create the React + Vite frontend shell.
- `Completed` Add the ambient dashboard layout, transcript panel, chart panel, and trace panel.
- `Completed` Add the canvas-based waveform visualizer.
- `Completed` Add Framer Motion layout and entry animations for transcript and chart cards.
- `Completed` Connect the UI to the gateway WebSocket.
- `Completed` Add real microphone capture and browser audio streaming.
- `Planned` Add production-quality latency and session state UX.

### Stage 3: Real-time gateway

- `Completed` Create the Fastify gateway scaffold with health and WebSocket endpoints.
- `Completed` Add a mocked transcript/event streaming loop for local demo use.
- `Completed` Emit transcript, trace, chart, and metric events to the frontend.
- `In Progress` Shape the gateway around the intended session lifecycle and event model.
- `Completed` Add browser audio chunk ingestion.
- `In Progress` Add Deepgram streaming integration.
- `Planned` Add transcript revision reconciliation for provider partials and finals.
- `Completed` Add session-close payload assembly with redacted transcript, structured findings, trace, and metrics capture.
- `Completed` Add real SQS queue publishing from the gateway when AWS env and credentials are present.

### Stage 4: Agentic core and safety

- `Completed` Create the `agent-core` package boundary.
- `Completed` Add a starter extraction function that turns transcript text into typed perio findings.
- `In Progress` Use shared schemas to validate extraction output.
- `Completed` Add PII redaction middleware between transcript and agent extraction.
- `In Progress` Replace heuristic extraction with Vercel AI SDK orchestration.
- `In Progress` Add typed practice-management tool definitions and tool execution flow.
- `Completed` Add trace emission for redaction outcomes.
- `Completed` Add trace emission for tool activity, extraction mode, handoff, and richer validation outcomes.

### Stage 5: Ingestion and persistence preparation

- `Completed` Create the `ingestion` package boundary.
- `Completed` Add normalization logic from structured findings into persistence-ready records.
- `Planned` Add deduplication across transcript revisions and partial/final updates.
- `Completed` Add canonical persistence-ready session record DTOs and worker write adapters for PostgreSQL and local replay.
- `In Progress` Add provenance and replay support for normalized records.

### Stage 6: Async backend

- `Completed` Create the worker package boundary.
- `Completed` Add a Lambda-oriented worker entry point that parses and normalizes session-close payloads.
- `Completed` Create the AWS CDK package boundary and stack entry point.
- `Completed` Add SQS, DLQ, and queue-to-worker infrastructure scaffold in CDK.
- `In Progress` Define the end-to-end session-close processing shape across gateway, queue, worker, and storage.
- `Completed` Define and emit the session-close payload contract from the gateway into a local publisher stub.
- `Completed` Replace the inline CDK Lambda placeholder with a bundled `apps/worker` artifact in CDK.
- `Completed` Add post-op PDF generation stub in the worker flow.
- `Completed` Add mock insurance pre-authorization flow stub in the worker.
- `Completed` Add persistence-ready enriched session record assembly in the worker.
- `Completed` Add worker persistence adapter with PostgreSQL and local-file fallback modes.
- `In Progress` Harden production PostgreSQL rollout, artifact persistence, queue retry semantics, and persisted audit metadata.

### Stage 7: Verification and hardening

- `In Progress` Install dependencies and run full workspace verification.
- `In Progress` Add unit tests for schemas, normalization, transcript revision logic, and worker persistence.
- `In Progress` Add integration-style tests for gateway extraction gating, session-close replay, and async backend boundaries.
- `In Progress` Add reconnect handling, retry behavior, and DLQ operational coverage.
- `In Progress` Add observability, audit, and metrics validation.

## Guiding principles

- Build the real-time path first.
- Keep contracts typed at service boundaries.
- Separate extraction from normalization.
- Treat privacy and observability as core product requirements.
- Ship a narrow perio workflow before expanding surface area.

## Workstreams

### 1. Frontend application

Owner surface: `apps/web`

Deliverables:

- ambient dashboard shell,
- microphone permission and input handling,
- canvas waveform renderer,
- live transcript with tentative and finalized states,
- trace sidebar,
- animated finding cards and chart region,
- metrics panel for TTFT and latency.

Exit criteria:

- browser can connect to a local gateway session,
- transcript updates render smoothly,
- chart findings can be staged and committed from streamed events.

### 2. Real-time gateway

Owner surface: `apps/gateway`

Deliverables:

- WebSocket session endpoint,
- browser audio chunk ingestion,
- Deepgram streaming client,
- transcript revision manager,
- PII redaction middleware,
- outbound event broadcaster,
- session-close payload builder.
- local queue publisher stub for async wrap-up.

Exit criteria:

- microphone audio can stream to Deepgram,
- partial and final transcript events return to the UI,
- redacted transcript text can be forwarded into the agent layer.
- a stopped session can produce a redacted closeout payload with findings, trace, and metrics.

### 3. Agentic core

Owner surface: `packages/agent-core`

Deliverables:

- Vercel AI SDK orchestration entry point,
- typed tool registry,
- Zod schemas for extraction payloads,
- confidence scoring policy,
- trace event emitter,
- mock practice management tool implementations.

Exit criteria:

- redacted transcript input produces validated structured findings,
- invalid outputs fail safely and emit review trace events.

### 4. Ingestion and persistence preparation

Owner surface: `packages/ingestion`

Deliverables:

- normalization pipeline from extracted findings into canonical records,
- deduplication policy for transcript revisions,
- provenance mapping,
- database write DTOs for PostgreSQL.

Exit criteria:

- structured findings can be transformed into stable persistence-ready records.

### 5. Async backend

Owner surfaces: `apps/worker`, `infra/aws`

Deliverables:

- SQS queue and DLQ definitions,
- Lambda worker entry point,
- gateway session-close payload assembly and publisher boundary,
- post-op PDF generation stub,
- mock insurance pre-auth client,
- final persistence integration contract.

Exit criteria:

- a closed session payload can be enqueued and processed asynchronously end to end.

## Milestones

### Milestone 1: Contracts and skeleton

Status: `Completed`

- finalize shared real-time event schema,
- scaffold packages and app boundaries,
- define core Zod extraction types,
- define session-close message shape.

### Milestone 2: Live transcription loop

Status: `In Progress`

- connect browser audio to gateway,
- connect gateway to Deepgram,
- render partial versus final transcript states in the UI,
- capture TTFT and transcript latency.

### Milestone 3: Extraction and charting

Status: `In Progress`

- add PII redaction middleware,
- wire agent orchestration,
- emit structured findings,
- stage chart animations from live events.

### Milestone 4: Closeout workflow

Status: `In Progress`

- publish session payload to SQS,
- process with Lambda,
- generate PDF artifact,
- simulate insurance pre-auth,
- persist final enriched session record.

### Milestone 5: Hardening

Status: `In Progress`

- add reconnect behavior,
- add DLQ and retry handling,
- improve trace fidelity,
- validate observability and audit coverage.

## Suggested delivery sequence

1. Implement `packages/shared` contracts first.
2. Build `apps/gateway` streaming loop with mocked outbound events.
3. Build `apps/web` transcript and chart UI against mocked gateway events.
4. Integrate Deepgram real-time transcription.
5. Add PII redaction and `packages/agent-core`.
6. Add `packages/ingestion` normalization and database DTOs.
7. Add `infra/aws` async processing path.

## Testing strategy

### Unit tests

- Zod schemas and validation failure cases.
- transcript revision reconciliation.
- redaction middleware behavior.
- ingestion normalization and deduplication logic.

### Integration tests

- browser event contract to gateway.
- gateway to Deepgram client adapter.
- gateway to agent-core handoff.
- session-close enqueue and Lambda processing.

### End-to-end validation

- scripted audio fixture flowing through transcript, extraction, chart update, and async closeout.

## Risks to manage early

- partial transcript churn causing duplicate findings,
- ambiguous dental speech patterns,
- privacy leakage in logs or traces,
- drift between extraction payloads and persistence schema,
- overly broad MVP scope.

## Recommended first sprint

- implement shared event types,
- stand up WebSocket session plumbing,
- create a mocked transcript stream,
- build transcript UI states,
- create trace sidebar and chart-card animation shell.
