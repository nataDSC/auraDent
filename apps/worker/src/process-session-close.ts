import {
  buildPersistableSessionRecord,
  generatePostOpInstructionArtifact,
  normalizeExtraction,
  simulateInsurancePreAuthorization,
} from '@auradent/ingestion';
import { AgentExtractionSchema, type SessionClosePayload } from '@auradent/shared';
import { createSessionPersistenceAdapter, type SessionPersistenceAdapter } from './persistence';

export type ProcessedSessionCloseSummary = {
  findings: number;
  insuranceStatus: 'approved' | 'pending_review';
  persistence: 'postgres' | 'local-file';
  postOpFile: string;
  sessionId: string;
};

export async function processSessionClosePayload(
  payload: SessionClosePayload,
  persistence: SessionPersistenceAdapter,
): Promise<ProcessedSessionCloseSummary> {
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
  await persistence.persist(persistableRecord);

  return {
    findings: normalized.length,
    insuranceStatus: insurancePreAuthorization.status,
    persistence: persistence.kind,
    postOpFile: postOpInstruction.fileName,
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
