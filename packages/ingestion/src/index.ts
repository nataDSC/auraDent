import type { AgentExtraction } from '@auradent/shared';

export type NormalizedPerioRecord = {
  sessionId: string;
  patientId: string;
  toothNumber: number;
  probingDepthMm: number | null;
  bleedingOnProbing: boolean;
  sourceUtteranceId: string;
  confidence: number;
};

export function normalizeExtraction(extraction: AgentExtraction): NormalizedPerioRecord[] {
  return extraction.findings.map((finding) => ({
    sessionId: extraction.sessionId,
    patientId: extraction.patientId,
    toothNumber: finding.toothNumber,
    probingDepthMm: finding.probingDepthMm ?? null,
    bleedingOnProbing: finding.bleedingOnProbing ?? false,
    sourceUtteranceId: finding.sourceUtteranceId,
    confidence: finding.confidence,
  }));
}
