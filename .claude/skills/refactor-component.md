---
name: refactor-component
description: Use when fixing, refactoring, or hardening any component in the AuraDent codebase. Covers the read-before-edit protocol, file ownership boundaries, shared-contract change sequencing, TypeScript constraints, and test requirements.
---

# AuraDent Component Refactoring

## Before Any Edit

Read these two files first — every time, not from memory:

1. **`docs/code-review-findings.md`** — the canonical list of known issues ranked by severity. If the fix you are about to make appears there, follow the recommended approach in the finding rather than inventing one.
2. **`repo_analysis.md`** — project layout, dependency graph, key source files, all run/test commands, and env var reference. Use it to confirm file locations, understand which packages depend on the code you're changing, and find the right test command.

Do not rely on memory for file paths, function names, or command syntax — read the current file.

## File Ownership Boundaries

Each area of the codebase has a clear owner. Never write to files outside the boundary of the task:

| Area | Owned files |
|---|---|
| Real-time path | `apps/gateway/src/` |
| AI agent | `packages/agent-core/src/` |
| Async backend | `apps/worker/src/`, `packages/ingestion/src/`, `infra/aws/` |
| Shared contracts | `packages/shared/src/` — sequential, must land before gateway/agent/worker changes |
| Frontend | `apps/web/src/` — sequential, must wait for any new `RealtimeEvent` types |

If a fix requires changes in more than one owned area, land the shared-contract change first and typecheck before touching the consuming packages.

## Companion Skills

Invoke the relevant skill before editing each area:

| Area | Skill to invoke |
|---|---|
| `apps/gateway/src/` | `gateway-session-state`, `deepgram-live-transcription` |
| `packages/agent-core/src/` | `ai-sdk-agent-orchestration` |
| `apps/worker/src/`, `packages/ingestion/src/` | `worker-persistence-hardening` |
| Any test file | `auradent-test-writing` |
| Multi-area work | `auradent-parallel-dispatch` |

## Shared Contract Change Protocol

Any edit to `packages/shared/src/events.ts` or `packages/shared/src/schemas.ts` is a shared contract change. Follow this sequence:

1. Edit the shared file.
2. Run `npm run typecheck` — fix all errors before continuing.
3. Only then edit the consuming packages (`apps/gateway`, `packages/agent-core`, `apps/worker`, `apps/web`).

Never edit a consuming package at the same time as the shared contract. Type errors from partially updated consumers mask real problems.

## TypeScript Constraints

These are enforced by the compiler and will cause `typecheck` failures if violated:

- **`verbatimModuleSyntax`**: type-only imports must use `import type { Foo }`. If the import is only used as a type, it must have the `type` keyword.
- **`strict: true`**: no implicit `any`. If you need `any`, add a comment explaining why — the reviewer will look for it.
- **ESNext modules**: all packages are `"type": "module"`. Use `.ts` extensions in internal imports; no `.js` re-export shims.
- **Infer over annotate**: only add explicit type annotations at public API boundaries or where inference falls short. Do not annotate locals that TypeScript can infer.
- **Zod-first types**: if you need a new validated type, define a Zod schema in `packages/shared/src/schemas.ts` and infer the TypeScript type with `z.infer<typeof MySchema>`. Do not write a parallel hand-authored type.

## Known Issues — Fix Priority

From `docs/code-review-findings.md`, the recommended fix order:

**Critical (fix before anything else in the same session boundary):**
1. **Finding #3** — Add `patientId: string` to `session.start` in `ClientSocketMessage` (`packages/shared/src/events.ts`). Thread it through `GatewaySessionState.activePatientId`. Replace every `'demo-patient'` literal.
2. **Finding #2** — Add `ClientSocketMessageSchema` and `RealtimeEventSchema` to `packages/shared/src/schemas.ts`. Use `safeParse` at each WebSocket boundary; log and discard invalid messages.
3. **Finding #1** — Add `allFinalizedUtterances` (unbounded) alongside `finalizedUtterances` (rolling window) in `GatewaySessionState`. Use `allFinalizedUtterances` in `buildSessionClosePayload`.

**Medium (address per workstream, can run in parallel):**
4. `bleedingOnProbing` OR logic in `packages/ingestion/src/index.ts:278` — document the conservative-OR policy or change to trust the winner.
5. `approximateReceiveCount ?? approximateReceiveCount` tautology in `apps/worker/src/index.ts` (lines 30–31 and 58–59).
6. Audio streaming before Deepgram ready — buffer chunks until `deepgramSocket` opens, or emit `deepgram.ready` and delay `onaudioprocess`.
7. DDL on every PostgreSQL connection in `apps/worker/src/persistence.ts:41` — remove `CREATE TABLE IF NOT EXISTS` from the adapter; run it only in the migration step.

**Low (incremental, do not block functional milestones):**
8–13. See full detail in `docs/code-review-findings.md`.

## Making the Edit

1. **Read the target file** before editing. Never edit a file you have not read in the current session.
2. **Make the smallest change that addresses the finding.** Do not refactor surrounding code unless it is part of the finding.
3. **No new comments** unless the why is non-obvious. Do not add comments describing what the code does.
4. **No new abstractions** unless the finding explicitly calls for one. Three similar lines is better than a premature helper.

## Test Requirements After Every Edit

Run these commands in order after any code change:

```bash
# 1. Package-level tests for every package you touched
npm run test --workspace @auradent/shared      # if packages/shared changed
npm run test --workspace @auradent/gateway     # if apps/gateway changed
npm run test --workspace @auradent/ingestion   # if packages/ingestion changed
npm run test --workspace @auradent/worker      # if apps/worker changed

# 2. If gateway, ingestion, or worker changed, also run:
npm run test:integration

# 3. If any packages/shared types changed, also run:
npm run typecheck
```

Fix all failures before reporting the task complete. Do not claim success without seeing passing output.

## Verifying a Fix Is Complete

A fix is complete when all of the following are true:

- The symptom described in the finding no longer exists in the code.
- `npm run typecheck` passes with zero errors.
- The relevant per-package test suite passes.
- If the finding is critical or medium, `npm run test:integration` also passes.
- No new `any` annotations or `@ts-ignore` comments were introduced.

## Quick Reference — Key Files for Common Fix Areas

| Finding area | Primary file | Supporting files |
|---|---|---|
| Session transcript truncation | `apps/gateway/src/index.ts` | `apps/gateway/src/session-close.ts` |
| WebSocket validation | `packages/shared/src/schemas.ts` | `apps/gateway/src/index.ts`, `apps/web/src/App.tsx` |
| `patientId` threading | `packages/shared/src/events.ts` | `apps/gateway/src/index.ts`, `apps/gateway/src/session-close.ts` |
| Ingestion dedup logic | `packages/ingestion/src/index.ts` | — |
| Worker SQS attributes | `apps/worker/src/index.ts` | — |
| Deepgram audio buffering | `apps/gateway/src/index.ts` | `apps/web/src/App.tsx` |
| PostgreSQL DDL on connect | `apps/worker/src/persistence.ts` | `apps/worker/src/schema.ts` |
| Audio worklet migration | `apps/web/src/App.tsx` | — |
| Canvas reflow | `apps/web/src/App.tsx` | — |
| Regex `lastIndex` hazard | `packages/shared/src/redaction.ts` | `packages/shared/src/redaction.test.ts` |
| PDF offset loop | `packages/ingestion/src/index.ts` | — |
