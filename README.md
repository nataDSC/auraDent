# AuraDent

AuraDent is a real-time dental documentation platform that turns live chairside speech into structured clinical updates, transparent agent traces, and asynchronous post-visit workflows.

This repository is scaffolded as a TypeScript monorepo with separate surfaces for the ambient frontend, the real-time gateway, the agentic extraction layer, the normalization service, and AWS-based wrap-up processing.

## What AuraDent Does

- Streams browser microphone audio to a real-time Node.js gateway.
- Transcribes speech with Deepgram and renders tentative versus finalized text.
- Redacts PII before transcript content reaches the model provider.
- Uses an agent with typed tools and Zod validation to extract clinical findings.
- Animates structured findings into a dental chart UI in real time.
- Enqueues session close payloads for AWS Lambda post-processing.

## Repo Layout

```text
apps/
  gateway/       Real-time WebSocket gateway and Deepgram integration
  web/           Ambient React frontend and trace UI
  worker/        Lambda-oriented session wrap-up worker
packages/
  agent-core/    Vercel AI SDK orchestration, tools, and schemas
  ingestion/     Normalization and persistence preparation layer
  shared/        Shared event contracts and domain types
infra/
  aws/           SQS/Lambda infrastructure notes and future IaC
docs/
  auradent-design-doc.md
  auradent-investor-brief.md
  implementation-plan.md
```

## Architecture Summary

1. `apps/web` captures audio, renders waveform activity, transcript states, trace events, and animated chart findings.
2. `apps/gateway` manages the browser WebSocket session, streams audio to Deepgram, applies PII redaction, and emits live events.
3. `packages/agent-core` turns redacted transcript text into typed tool calls and validated structured output.
4. `packages/ingestion` normalizes agent output into records suitable for PostgreSQL persistence.
5. `apps/worker` contains the Lambda-oriented enrichment logic.
6. `infra/aws` owns the AWS infrastructure definitions for the asynchronous pipeline.

## Getting Started

This scaffold now includes a runnable local demo path:

- `apps/web` uses React + Vite + Framer Motion.
- `apps/gateway` uses Fastify + WebSocket and emits mocked transcript, trace, and chart events.
- `packages/shared` provides typed event contracts and Zod schemas.
- `packages/agent-core` includes a tool-driven AI SDK clinical agent with heuristic fallback.
- `apps/worker` and `infra/aws` provide the Lambda and CDK starting points for async processing.

### Suggested next steps

1. Replace the mocked gateway transcript flow with live Deepgram streaming.
2. Replace the remaining heuristic fallback in `packages/agent-core` with a fully provider-backed agent path.
3. Wire PostgreSQL persistence into `packages/ingestion` and `apps/worker`.
4. Replace the inline CDK Lambda with a deployed worker artifact.

## Implementation Status

- `Completed` Monorepo scaffold, shared contracts, starter schemas, and package boundaries.
- `Completed` React + Vite ambient dashboard shell with waveform, transcript, chart, and trace views.
- `Completed` Fastify WebSocket gateway with mocked real-time transcript, trace, chart, and metric events.
- `Completed` Browser microphone capture and PCM streaming from the frontend to the gateway.
- `Completed` Server-side PII redaction pass before agent extraction, with trace visibility for redaction events.
- `Completed` Redacted finalized transcript display when PII is detected.
- `Completed` Safety-focused trace retention so redaction and tool events are less likely to be pushed out by transcript noise.
- `Completed` Visible agent lifecycle trace with extraction mode, handoff, tool, and completion events.
- `Completed` Starter ingestion normalization, worker entrypoint, and CDK async infrastructure scaffold.
- `Completed` Session-close payload assembly in the gateway, including redacted final transcript, structured findings, trace artifacts, and metrics capture.
- `Completed` Gateway SQS publisher wiring for real session-close enqueue when AWS credentials and queue env vars are present.
- `Completed` Worker enrichment stubs for post-op PDF generation, mock insurance pre-authorization, and persistence-ready session record assembly.
- `In Progress` Dependency installation and full workspace verification.
- `In Progress` Deepgram live transcription wiring and end-to-end session lifecycle shape.
- `In Progress` Vercel AI SDK orchestration with mock practice-management tools and heuristic fallback.
- `In Progress` AWS deployment wiring from queue to bundled worker artifact, pending dependency install and `cdk` deployment.
- `In Progress` PostgreSQL persistence, PDF generation, and insurance pre-auth flow.

### Run Current Stage

Install dependencies first:

```bash
npm install
```

Run the current gateway demo server:

```bash
npm run dev:gateway
```

Run the current frontend UI:

```bash
npm run dev:web
```

The current runnable stage is a mocked local demo:

- the gateway serves a WebSocket session at `ws://localhost:8787/realtime/session/demo-session`
- the frontend connects to that gateway and renders transcript, trace, waveform, chart, and metrics UI

To run the live microphone stage instead of demo mode:

```bash
export DEEPGRAM_API_KEY=your_key_here
export DEEPGRAM_MODEL=nova-3
export AI_GATEWAY_API_KEY=your_key_here
export AURADENT_AGENT_MODEL=openai/gpt-4.1-mini
export AURADENT_AWS_REGION=us-west-2
export AURADENT_SESSION_CLOSE_QUEUE_URL=your_queue_url_here
npm run dev:gateway
```

Then open the UI and use `Start Mic`.

### Verification Commands

Current verification commands:

```bash
npm run typecheck
```

```bash
npm run build
```

Automated tests are not implemented yet, so there is no `npm test` command at this stage.

The detailed stage-by-stage checklist lives in [docs/implementation-plan.md](/Users/nataliep/Documents/New%20project/docs/implementation-plan.md).

## Scripts

The root workspace includes starter scripts:

- `npm run dev:web`
- `npm run dev:gateway`
- `npm run build`
- `npm run typecheck`

Run the local demo with two terminals:

```bash
npm install
npm run dev:gateway
```

```bash
npm run dev:web
```

The frontend expects the gateway at `ws://localhost:8787/realtime/session/demo-session` by default.

For live transcription, copy from [.env.example](/Users/nataliep/Documents/New%20project/.env.example) or export the variables directly before starting the gateway:

```bash
export DEEPGRAM_API_KEY=your_key_here
export DEEPGRAM_MODEL=nova-3
export AI_GATEWAY_API_KEY=your_key_here
export AURADENT_AGENT_MODEL=openai/gpt-4.1-mini
export AURADENT_AWS_REGION=us-west-2
export AURADENT_SESSION_CLOSE_QUEUE_URL=your_queue_url_here
npm run dev:gateway
```

If `AURADENT_SESSION_CLOSE_QUEUE_URL` is unset, the gateway logs the full session-close payload locally on `session.stop`. If it is set, the gateway now attempts a real SQS `SendMessage` using the current AWS credentials and `AURADENT_AWS_REGION` or `AWS_REGION`.

To synthesize or deploy the async stack after installing dependencies:

```bash
npm run synth --workspace @auradent/aws-infra
```

```bash
npm run deploy --workspace @auradent/aws-infra
```

```bash
npm run destroy --workspace @auradent/aws-infra
```

## Key Deliverables In This Repo

- Product and system design doc: [docs/auradent-design-doc.md](/Users/nataliep/Documents/New%20project/docs/auradent-design-doc.md)
- Investor-facing brief: [docs/auradent-investor-brief.md](/Users/nataliep/Documents/New%20project/docs/auradent-investor-brief.md)
- Implementation plan: [docs/implementation-plan.md](/Users/nataliep/Documents/New%20project/docs/implementation-plan.md)
- AWS deployment guide: [infra/aws/aws_deployment.md](/Users/nataliep/Documents/New%20project/infra/aws/aws_deployment.md)

## MVP Focus

The recommended MVP is a narrow perio workflow:

- live microphone capture,
- Deepgram partial and final transcription,
- PII-safe agent extraction,
- animated chart updates,
- visible trace events,
- session close enqueue,
- Lambda-generated artifacts and final persistence.
