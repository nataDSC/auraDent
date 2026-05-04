---
name: worker-persistence-hardening
description: Use when working on apps/worker/src/, infra/aws/, or adding SQS retry semantics, PostgreSQL persistence, or audit metadata to the async backend.
---

# Worker Persistence Hardening

## Architecture Overview

```
SQS message → Lambda (apps/worker/src/index.ts)
                ↓
  processSessionClosePayload(payload, persistence, context)
                ↓
  normalizeExtraction() → deduplication in packages/ingestion
  generatePostOpInstructionArtifact()
  persistPostOpInstructionArtifact()  → apps/worker/src/artifact-store.ts
  simulateInsurancePreAuthorization()
  buildPersistableSessionRecord()
  attachProcessingObservability()
  persistence.persist(record)         → PostgreSQL or JSONL
```

## `processSessionClosePayload` Signature

```typescript
export async function processSessionClosePayload(
  payload: SessionClosePayload,
  persistence: SessionPersistenceAdapter,
  context: SessionProcessingContext,
): Promise<ProcessedSessionCloseSummary>

export type SessionProcessingContext = {
  approximateReceiveCount?: number;  // from SQS ApproximateReceiveCount attribute
  runtime: 'local' | 'lambda';
  sourceMessageId?: string;          // SQS MessageId
};
```

Always call via `withSessionPersistence` which manages adapter lifecycle:

```typescript
const summary = await withSessionPersistence((persistence) =>
  processSessionClosePayload(payload, persistence, {
    runtime: 'lambda',
    sourceMessageId: record.messageId,
    approximateReceiveCount: Number(record.attributes.ApproximateReceiveCount ?? 1),
  }),
);
```

## SQS Message Attributes

The Lambda handler receives SQS events. Extract observability metadata:

```typescript
import type { SQSHandler } from 'aws-lambda';

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const payload = JSON.parse(record.body) as SessionClosePayload;
    const context: SessionProcessingContext = {
      runtime: 'lambda',
      sourceMessageId: record.messageId,
      approximateReceiveCount: Number(record.attributes.ApproximateReceiveCount ?? 1),
    };
    await withSessionPersistence((persistence) =>
      processSessionClosePayload(payload, persistence, context),
    );
  }
};
```

**`ApproximateReceiveCount`** tells you how many times SQS has attempted delivery. Log it prominently — it's the primary signal for diagnosing retries and poison messages.

## Idempotency

The PostgreSQL adapter uses `ON CONFLICT (session_id) DO UPDATE`:

```typescript
await client.query(
  `INSERT INTO auradent_session_records (session_id, patient_id, closed_at, insurance_status, record)
   VALUES ($1, $2, $3, $4, $5::jsonb)
   ON CONFLICT (session_id)
   DO UPDATE SET
     patient_id = excluded.patient_id,
     closed_at = excluded.closed_at,
     insurance_status = excluded.insurance_status,
     record = excluded.record,
     updated_at = now();`,
  [record.sessionId, record.patientId, record.closedAt, record.insurancePreAuthorization.status, JSON.stringify(record)],
);
```

**Never use a plain `INSERT` for session records** — SQS delivers at-least-once, so the same session can arrive multiple times. The upsert on `session_id` makes repeated processing safe.

The `dedupeKey` in `NormalizedPerioRecord.provenance` is the idempotency anchor for individual findings within a session — the ingestion layer already deduplicates by `(sessionId, patientId, toothNumber)` via SHA-256.

## `SessionPersistenceAdapter` Interface

```typescript
export type SessionPersistenceAdapter = {
  kind: 'postgres' | 'local-file';
  persist: (record: PersistableSessionRecord) => Promise<void>;
  close: () => Promise<void>;
};
```

`createSessionPersistenceAdapter()` selects the adapter based on `AURADENT_DATABASE_URL`:
- Present → PostgreSQL adapter (connects on creation, auto-runs `CREATE TABLE IF NOT EXISTS`)
- Absent → local JSONL adapter (appends to `AURADENT_PERSISTENCE_FILE ?? '/tmp/auradent-session-records.jsonl'`)

Both adapters must produce the same `PersistableSessionRecord` shape — the local file is not a degraded path, it's a full record.

## Audit Metadata (`attachProcessingObservability`)

Currently attached fields (in `ProcessedSessionCloseSummary` and `PersistableSessionRecord.observability.processing`):

```typescript
{
  processedAt: string,           // ISO timestamp
  processingDurationMs: number,  // Date.now() - startedAt
  runtime: 'local' | 'lambda',
  persistenceMode: 'postgres' | 'local-file',
  sourceMessageId?: string,      // SQS MessageId
  approximateReceiveCount?: number,
  traceEventCount: number,       // payload.artifacts.trace.length
  metricCount: number,           // payload.artifacts.metrics.length
  payloadSha256: string,         // SHA-256 of JSON.stringify(payload)
  recordSha256: string,          // SHA-256 of JSON.stringify(record) after assembly
}
```

When adding new audit fields, add them to `attachProcessingObservability()` in `process-session-close.ts`. Do not add them directly to `buildPersistableSessionRecord()` in the ingestion package — that function builds the domain record; observability is attached after.

## DLQ Behavior

The CDK stack configures a DLQ with `maxReceiveCount`. After that many failed Lambda invocations, SQS moves the message to the DLQ automatically.

Operational guidance:
- A Lambda that throws will cause SQS to retry (up to `maxReceiveCount`).
- Log `approximateReceiveCount` at the start of each invocation so CloudWatch shows the retry progression.
- The worker should throw on unrecoverable errors (corrupt payload, missing required fields) to let SQS/DLQ handle it. Do not swallow errors that should trigger a retry.
- For soft failures (e.g., PostgreSQL temporarily unavailable), let the exception propagate so SQS retries with backoff.

## Artifact Storage (`artifact-store.ts`)

Post-op PDF artifacts are persisted via `persistPostOpInstructionArtifact()`:

```typescript
import { persistPostOpInstructionArtifact } from './artifact-store';

const persistedPostOpInstruction = await persistPostOpInstructionArtifact({
  artifact: postOpInstruction,   // PostOpInstructionArtifact from ingestion
  context,                        // SessionProcessingContext
});
```

- `context.runtime === 'lambda'` → writes to `/tmp/auradent-post-op` (or `AURADENT_ARTIFACT_OUTPUT_DIR`)
- `context.runtime === 'local'` → writes to `tmp/post-op-instructions` under repo root (or `AURADENT_ARTIFACT_OUTPUT_DIR`)

Do not write artifact files anywhere outside `artifact-store.ts`.

## PostgreSQL SSL

```typescript
function resolvePostgresSsl() {
  if (process.env.AURADENT_DATABASE_SSL === 'disable') return false;
  return process.env.AURADENT_DATABASE_SSL === 'require'
    ? { rejectUnauthorized: false }
    : undefined;  // default: use TLS with full verification
}
```

For local Supabase: `AURADENT_DATABASE_SSL=disable`. For production RDS: omit or set `require`.

## Adding a New Processing Step

Insert the new step into `processSessionClosePayload()` between `normalizeExtraction()` and `persistence.persist()`. Pass required data forward through the function — do not add module-level state. The function is intentionally linear top-to-bottom.
