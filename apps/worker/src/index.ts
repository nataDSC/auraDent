import type { SQSEvent, SQSHandler } from 'aws-lambda';
import { normalizeExtraction } from '@auradent/ingestion';
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
    console.log(
      JSON.stringify({
        level: 'info',
        message: 'Processed session close payload',
        sessionId: payload.sessionId,
        findings: normalized.length,
      }),
    );
  }
};
