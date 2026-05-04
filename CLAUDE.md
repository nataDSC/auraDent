# AuraDent — Claude Code Guide

## Project Context

AuraDent is a real-time dental documentation platform: browser mic audio → Deepgram transcription → PII redaction → AI agent extracts structured periodontal findings → animated dental chart UI → session-close payload enqueued to AWS SQS → Lambda worker generates PDFs, mock insurance pre-auth, and persists to PostgreSQL.

TypeScript npm workspaces monorepo:

```
apps/gateway     Fastify WebSocket server, Deepgram, agent orchestration, SQS publish
apps/web         React + Vite ambient dashboard
apps/worker      Lambda-style session wrap-up (PDF, pre-auth, PostgreSQL)
packages/agent-core   Vercel AI SDK clinical agent + heuristic fallback
packages/ingestion    Normalization + deduplication of agent output
packages/shared       Typed event contracts, Zod schemas, PII redaction
infra/aws        CDK stack (SQS, DLQ, Lambda)
```

## Commands

```bash
# Install
npm install

# Development
npm run dev:gateway          # Fastify gateway (port 8787)
npm run dev:web              # Vite frontend (port 5173)

# Tests — run these after every edit
npm run test                 # all tests (integration + per-package)
npm run test:integration     # cross-boundary replay test only
npm run test --workspace @auradent/shared
npm run test --workspace @auradent/gateway
npm run test --workspace @auradent/ingestion
npm run test --workspace @auradent/worker

# Type checking
npm run typecheck

# Build
npm run build

# Worker local replay (no AWS needed)
npm run run:worker-local -- "<repo-root>/tmp/session-close/latest-session-close.json"

# PostgreSQL local
npm run migrate:worker-local
npm run readback:worker-local
npm run readback:worker-local -- <session-id> --full
```

## Coding Standards

**TypeScript**
- Prefer type inference — only annotate where inference falls short or a public API boundary needs to be explicit.
- Use `type` imports (`import type { Foo }`) whenever the import is type-only (`verbatimModuleSyntax` is enforced).
- All packages are `"type": "module"` (ESNext). Use `.ts` extensions in internal imports when `tsx` resolves them; avoid `.js` re-export shims.
- `strict: true` is enforced. No `any` without a comment explaining why.
- Zod schemas live in `packages/shared/src/schemas.ts`. Infer TypeScript types from schemas with `z.infer<>` — don't duplicate type definitions.

**Structure**
- Each package/app has one clear responsibility. Don't add cross-cutting logic to `packages/shared` unless it genuinely belongs to the shared contract.
- Event types are defined in `packages/shared/src/events.ts`. New realtime events go there as discriminated union members.
- Gateway session state is a single `GatewaySessionState` object — extend it rather than scattering module-level state.

**Testing**
- Tests use Node.js built-in `node:test` via `tsx --test`. No Jest, no Vitest.
- Test files are co-located with source (`src/**/*.test.ts`) except for the cross-boundary integration test in `test/`.
- Test only observable behavior — don't test implementation details or private helpers directly.
- Each test file covers one module. Keep tests focused and fast.

**Error handling**
- Only validate at system boundaries (WebSocket messages, SQS payloads, env vars). Trust internal function contracts.
- Use the existing `trace.event` pattern to surface runtime errors visibly rather than swallowing them silently.

**Comments**
- Write no comments by default. Add one only when the *why* is non-obvious (hidden constraint, subtle invariant, provider-specific workaround). Never describe what the code does.

## Instructions

**After any code edit, run the relevant tests before considering the task done:**

1. Run the per-package test suite for whichever package(s) were modified.
2. If gateway, ingestion, or worker were touched, also run `npm run test:integration`.
3. If any types in `packages/shared` changed, run `npm run typecheck` across all workspaces.
4. Fix failures before reporting the task complete — do not claim success without seeing passing output.
