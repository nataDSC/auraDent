import { AgentExtractionSchema, type AgentExtraction } from '@auradent/shared';

type ExtractionInput = {
  sessionId: string;
  patientId: string;
  transcript: string;
};

export function createExtractionFromTranscript(input: ExtractionInput): AgentExtraction {
  const transcript = input.transcript.toLowerCase();
  const depthMatch = transcript.match(/(\d+)\s*(?:millimeter|mm)/);
  const toothMatch = transcript.match(/tooth\s+(\d+)|on\s+(\d+)/);
  const pocketDepth = depthMatch ? Number(depthMatch[1]) : undefined;
  const toothNumber = toothMatch ? Number(toothMatch[1] ?? toothMatch[2]) : 14;
  const bleedingOnProbing = transcript.includes('bleeding');

  return AgentExtractionSchema.parse({
    sessionId: input.sessionId,
    patientId: input.patientId,
    findings: [
      {
        toothNumber,
        probingDepthMm: pocketDepth,
        bleedingOnProbing,
        confidence: 0.96,
        sourceUtteranceId: 'utt-002',
      },
    ],
    noteSummary: input.transcript,
    requiresReview: false,
  });
}
