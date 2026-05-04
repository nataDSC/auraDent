---
name: auradent-test-writing
description: Use when adding or modifying any test file in the AuraDent project. Covers the Node.js built-in test runner, co-location conventions, and integration test patterns.
---

# AuraDent Test Writing

## Test Runner

AuraDent uses **Node.js built-in `node:test`**, not Jest or Vitest. The runner is invoked via `tsx --test`.

**Correct imports — always use these:**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
```

Do NOT use `describe`/`it`/`expect`. There is no `beforeEach`/`afterEach` — use plain setup inside each `test()` call.

## File Co-location

Test files live next to source files using the `*.test.ts` suffix:

```
packages/shared/src/redaction.ts
packages/shared/src/redaction.test.ts   ← correct location

apps/gateway/src/extraction-gating.ts
apps/gateway/src/extraction-gating.test.ts   ← correct location
```

The single exception is the cross-boundary integration test:

```
test/session-close-replay.test.ts   ← only file allowed at repo root test/
```

## Running Tests

```bash
# All tests
npm run test

# Integration test only
npm run test:integration

# Single package
npm run test --workspace @auradent/shared
npm run test --workspace @auradent/gateway
npm run test --workspace @auradent/ingestion
npm run test --workspace @auradent/worker

# Single file (useful during development)
tsx --test apps/gateway/src/extraction-gating.test.ts
```

## Canonical Pattern

Use `apps/gateway/src/extraction-gating.test.ts` as the reference model for unit tests:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasClinicalSignal, isReadyForStructuredExtraction } from './extraction-gating';

test('hasClinicalSignal detects perio language in fragmented transcripts', () => {
  assert.equal(hasClinicalSignal('Has four millimeter pockets'), true);
  assert.equal(hasClinicalSignal('bleeding on probing'), true);
  assert.equal(hasClinicalSignal('Patient [PATIENT_NAME] [PHONE]'), false);
});

test('isReadyForStructuredExtraction waits for explicit tooth reference', () => {
  assert.equal(isReadyForStructuredExtraction('Has four millimeter pockets'), false);
  assert.equal(isReadyForStructuredExtraction('Has four millimeter pockets on tooth 14'), true);
});
```

Key points:
- One `test()` per behavior, not per function.
- Test names describe the observable behavior, not the implementation.
- Use `assert.equal`, `assert.deepEqual`, `assert.throws`, `assert.rejects` — all from `node:assert/strict`.
- Inline data is preferred over external fixtures when the data is under ~50 lines.

## Integration Test Pattern

Use `test/session-close-replay.test.ts` as the reference model for cross-boundary tests:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { processSessionClosePayload, withSessionPersistence } from '@auradent/worker/process-session-close';
import type { SessionClosePayload } from '@auradent/shared';

const fixturePayload: SessionClosePayload = {
  sessionId: 'test-session-replay',
  // ... full typed fixture
};

test('session close replay persists normalized findings', async () => {
  const summary = await withSessionPersistence((persistence) =>
    processSessionClosePayload(fixturePayload, persistence, { runtime: 'local' }),
  );

  assert.equal(summary.sessionId, 'test-session-replay');
  assert.ok(summary.findings >= 0);
  assert.ok(['postgres', 'local-file'].includes(summary.persistence));
});
```

Integration tests call real functions with real data. They do not mock internal modules.

## What NOT to Test

- Private/unexported helpers — test only exported surface.
- Implementation details — if two implementations produce the same output, the test should not care which path was taken.
- Framework behavior — don't test that Zod throws on bad data; test that your code handles that throw correctly.

## Existing Test Files as Reference

| Test file | Models how to test |
|---|---|
| `packages/shared/src/redaction.test.ts` | Regex-based string transformation with edge cases |
| `apps/gateway/src/extraction-gating.test.ts` | Pure function with multiple input variants |
| `apps/gateway/src/session-close.test.ts` | Payload assembly with typed inputs |
| `apps/gateway/src/transcript-revisions.test.ts` | Stateful function returning a new store |
| `apps/gateway/src/deepgram-retry.test.ts` | Backoff math and boolean guards |
| `packages/ingestion/src/index.test.ts` | Normalization + deduplication |
| `apps/worker/src/process-session-close.test.ts` | Async processing with a persistence adapter |
| `test/session-close-replay.test.ts` | Cross-boundary end-to-end replay |
