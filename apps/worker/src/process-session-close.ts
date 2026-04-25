import {
  buildPersistableSessionRecord,
  generatePostOpInstructionArtifact,
  normalizeExtraction,
  simulateInsurancePreAuthorization,
  type PersistableSessionRecord,
} from '@auradent/ingestion';
import { createHash } from 'node:crypto';
import { AgentExtractionSchema, type SessionClosePayload } from '@auradent/shared';
import { createSessionPersistenceAdapter, type SessionPersistenceAdapter } from './persistence';

export type ProcessedSessionCloseSummary = {
  findings: number;
  insuranceStatus: 'approved' | 'pending_review';
  persistence: 'postgres' | 'local-file';
  postOpFile: string;
  processingDurationMs: number;
  recordSha256: string;
  sessionId: string;
};

export type SessionProcessingContext = {
  approximateReceiveCount?: number;
  runtime: 'local' | 'lambda';
  sourceMessageId?: string;
};

export async function processSessionClosePayload(
  payload: SessionClosePayload,
  persistence: SessionPersistenceAdapter,
  context: SessionProcessingContext,
): Promise<ProcessedSessionCloseSummary> {
  const startedAt = Date.now();
  const extraction = AgentExtractionSchema.parse({
    sessionId: payload.sessionId,
    patientId: payload.patientId,
    findings: payload.structuredFindings,
    requiresReview: false,
    noteSummary: payload.transcript.finalText,
  });

  const normalized = normalizeExtraction(extraction);
  const postOpInstruction = generatePostOpInstructionArtifact(payload, normalized);
  const insurancePreAuthorization = simulateInsurancePreAuthorization(payload, normalized);
  const persistableRecord = buildPersistableSessionRecord({
    payload,
    normalizedFindings: normalized,
    postOpInstruction,
    insurancePreAuthorization,
  });
  attachProcessingObservability({
    context,
    payload,
    persistenceMode: persistence.kind,
    record: persistableRecord,
    startedAt,
  });
  await persistence.persist(persistableRecord);

  return {
    findings: normalized.length,
    insuranceStatus: insurancePreAuthorization.status,
    persistence: persistence.kind,
    processingDurationMs:
      persistableRecord.observability.processing?.processingDurationMs ?? Date.now() - startedAt,
    postOpFile: postOpInstruction.fileName,
    recordSha256: persistableRecord.observability.processing?.recordSha256 ?? '',
    sessionId: payload.sessionId,
  };
}

export async function withSessionPersistence<T>(
  run: (persistence: Awaited<ReturnType<typeof createSessionPersistenceAdapter>>) => Promise<T>,
): Promise<T> {
  const persistence = await createSessionPersistenceAdapter();

  try {
    return await run(persistence);
  } finally {
    await persistence.close();
  }
}

function attachProcessingObservability(args: {
  context: SessionProcessingContext;
  payload: SessionClosePayload;
  persistenceMode: 'postgres' | 'local-file';
  record: PersistableSessionRecord;
  startedAt: number;
}) {
  const processing = {
    processedAt: new Date().toISOString(),
    processingDurationMs: Date.now() - args.startedAt,
    runtime: args.context.runtime,
    persistenceMode: args.persistenceMode,
    sourceMessageId: args.context.sourceMessageId,
    approximateReceiveCount: args.context.approximateReceiveCount,
    traceEventCount: args.payload.artifacts.trace.length,
    metricCount: args.payload.artifacts.metrics.length,
    payloadSha256: createSha256(JSON.stringify(args.payload)),
    recordSha256: '',
  };

  args.record.observability.processing = processing;
  processing.recordSha256 = createSha256(JSON.stringify(args.record));
}

function createSha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
