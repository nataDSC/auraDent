import { z } from 'zod';

export const PerioFindingSchema = z.object({
  toothNumber: z.number().int().min(1).max(32),
  probingDepthMm: z.number().int().min(1).max(15).optional(),
  bleedingOnProbing: z.boolean().optional(),
  confidence: z.number().min(0).max(1),
  sourceUtteranceId: z.string(),
});

export const AgentExtractionSchema = z.object({
  sessionId: z.string(),
  patientId: z.string(),
  findings: z.array(PerioFindingSchema),
  requiresReview: z.boolean().default(false),
  noteSummary: z.string().optional(),
});

export type PerioFinding = z.infer<typeof PerioFindingSchema>;
export type AgentExtraction = z.infer<typeof AgentExtractionSchema>;
