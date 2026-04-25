import type { SQSEvent, SQSHandler } from 'aws-lambda';
import {
  buildPersistableSessionRecord,
  generatePostOpInstructionArtifact,
  normalizeExtraction,
  simulateInsurancePreAuthorization,
} from '@auradent/ingestion';
import { AgentExtractionSchema, type SessionClosePayload } from '@auradent/shared';

export const handler: SQSHandler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    const payload = JSON.parse(record.body) as SessionClosePayload;

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

    console.log(
      JSON.stringify({
        level: 'info',
        message: 'Processed session close payload into enriched async record',
        sessionId: payload.sessionId,
        findings: normalized.length,
        postOpFile: postOpInstruction.fileName,
        insuranceStatus: insurancePreAuthorization.status,
        persistableRecord,
      }),
    );
  }
};
