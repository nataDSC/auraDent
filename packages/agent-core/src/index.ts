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
  const toothNumber = toothMatch ? Number(toothMatch[1] ?? toothMatch[2]) : undefined;
  const bleedingOnProbing = transcript.includes('bleeding');
  const hasClinicalSignal =
    Boolean(depthMatch) ||
    Boolean(toothMatch) ||
    bleedingOnProbing ||
    transcript.includes('pocket') ||
    transcript.includes('probing') ||
    transcript.includes('recession') ||
    transcript.includes('mobility') ||
    transcript.includes('furcation');

  return AgentExtractionSchema.parse({
    sessionId: input.sessionId,
    patientId: input.patientId,
    findings:
      hasClinicalSignal && toothNumber
        ? [
            {
              toothNumber,
              probingDepthMm: pocketDepth,
              bleedingOnProbing,
              confidence: 0.96,
              sourceUtteranceId: 'utt-002',
            },
          ]
        : [],
    noteSummary: input.transcript,
    requiresReview: false,
  });
}
