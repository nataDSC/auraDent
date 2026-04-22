import { generateObject, generateText, tool, zodSchema } from 'ai';
import {
  AgentExtractionSchema,
  PerioFindingSchema,
  type AgentExtraction,
  type PerioFinding,
} from '@auradent/shared';
import { z } from 'zod';

type ExtractionInput = {
  sessionId: string;
  patientId: string;
  transcript: string;
  utteranceId: string;
};

export type AgentTraceEvent = {
  step: string;
  detail: string;
  confidence?: number;
};

export type ClinicalAgentResult = {
  extraction: AgentExtraction;
  mode: 'ai-sdk' | 'heuristic';
  traceEvents: AgentTraceEvent[];
};

const MockPatientHistorySchema = z.object({
  lastPerioVisit: z.string(),
  flags: z.array(z.string()),
  summary: z.string(),
});

const MockChartUpdateResultSchema = z.object({
  acceptedFindings: z.number().int().min(0),
  summary: z.string(),
});

type PatientHistoryToolInput = {
  patientId: string;
};

type UpdatePerioChartToolInput = {
  sessionId: string;
  findings: PerioFinding[];
};

export async function runClinicalAgent(input: ExtractionInput): Promise<ClinicalAgentResult> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    return runHeuristicFallback(input, 'AI gateway not configured. Using heuristic extraction fallback.');
  }

  const traceEvents: AgentTraceEvent[] = [
    {
      step: 'agent.started',
      detail: `AI SDK agent started for utterance ${input.utteranceId}.`,
      confidence: 0.98,
    },
    {
      step: 'agent.mode',
      detail: 'Extraction mode: ai-sdk.',
      confidence: 0.98,
    },
  ];

  try {
    const practiceTools = {
      check_patient_history: tool<
        PatientHistoryToolInput,
        z.infer<typeof MockPatientHistorySchema>
      >({
        description: 'Look up mock patient history and periodontal context for the current patient.',
        inputSchema: zodSchema(
          z.object({
            patientId: z.string(),
          }),
        ),
        execute: async ({ patientId }: PatientHistoryToolInput) => {
          traceEvents.push({
            step: 'tool.called',
            detail: 'check_patient_history invoked for clinical context.',
            confidence: 0.97,
          });

          const result = MockPatientHistorySchema.parse({
            lastPerioVisit: '2026-02-11',
            flags: patientId === 'demo-patient' ? ['history_of_bop'] : [],
            summary: 'Routine periodontal maintenance patient with prior bleeding on probing noted.',
          });

          traceEvents.push({
            step: 'tool.result',
            detail: 'check_patient_history returned mock history context.',
            confidence: 0.97,
          });

          return result;
        },
      }),
      update_perio_chart: tool<
        UpdatePerioChartToolInput,
        z.infer<typeof MockChartUpdateResultSchema>
      >({
        description: 'Validate and simulate a perio chart update for extracted findings.',
        inputSchema: zodSchema(
          z.object({
            sessionId: z.string(),
            findings: z.array(PerioFindingSchema),
          }),
        ),
        execute: async ({ findings, sessionId }: UpdatePerioChartToolInput) => {
          traceEvents.push({
            step: 'tool.called',
            detail: `update_perio_chart invoked with ${findings.length} finding${findings.length === 1 ? '' : 's'}.`,
            confidence: findings[0]?.confidence,
          });

          const result = MockChartUpdateResultSchema.parse({
            acceptedFindings: findings.length,
            summary: `Validated ${findings.length} finding${findings.length === 1 ? '' : 's'} for session ${sessionId}.`,
          });

          traceEvents.push({
            step: 'tool.result',
            detail: 'update_perio_chart validated the extracted findings.',
            confidence: findings[0]?.confidence,
          });

          return result;
        },
      }),
    };

    const contextResult = await generateText<typeof practiceTools>({
      model: process.env.AURADENT_AGENT_MODEL ?? 'openai/gpt-4.1-mini',
      system: [
        'You are the AuraDent clinical context agent.',
        'You receive a redacted transcript utterance from a dental exam.',
        'Always call check_patient_history once for context.',
        'Summarize only the clinically relevant context from the transcript and tool result.',
        'Do not invent measurements or findings.',
      ].join(' '),
      prompt: [
        `sessionId: ${input.sessionId}`,
        `patientId: ${input.patientId}`,
        `sourceUtteranceId: ${input.utteranceId}`,
        `transcript: ${input.transcript}`,
      ].join('\n'),
      tools: practiceTools,
      activeTools: ['check_patient_history'],
    });

    traceEvents.push({
      step: 'agent.context',
      detail: 'AI SDK context pass completed before structured extraction.',
      confidence: 0.96,
    });

    const { object } = await generateObject({
      model: process.env.AURADENT_AGENT_MODEL ?? 'openai/gpt-4.1-mini',
      system: [
        'You are the AuraDent clinical extraction agent.',
        'You receive a redacted transcript utterance and a short context summary.',
        'Only extract facts explicitly stated in the transcript.',
        'Do not infer missing tooth numbers or measurements.',
        'If the utterance does not contain a structured clinical finding, return an empty findings array.',
        'Always preserve the provided sessionId, patientId, and sourceUtteranceId values exactly.',
      ].join(' '),
      prompt: [
        `sessionId: ${input.sessionId}`,
        `patientId: ${input.patientId}`,
        `sourceUtteranceId: ${input.utteranceId}`,
        `transcript: ${input.transcript}`,
        `contextSummary: ${contextResult.text || 'No additional context.'}`,
      ].join('\n'),
      schema: zodSchema(AgentExtractionSchema),
      schemaName: 'ClinicalExtraction',
      schemaDescription: 'Validated structured extraction for periodontal chart updates.',
    });

    const generated = object as AgentExtraction;
    const extraction = AgentExtractionSchema.parse({
      ...generated,
      sessionId: input.sessionId,
      patientId: input.patientId,
      findings: generated.findings.map((finding: PerioFinding) => ({
        ...finding,
        sourceUtteranceId: input.utteranceId,
      })),
    });

    traceEvents.push({
      step: 'schema.validated',
      detail: 'AI SDK structured output validated against AgentExtractionSchema.',
      confidence: 0.98,
    });

    if (extraction.findings.length > 0) {
      await practiceTools.update_perio_chart.execute?.({
        sessionId: input.sessionId,
        findings: extraction.findings,
      }, {
        toolCallId: `tool-update-perio-chart-${input.utteranceId}`,
        messages: [],
      });
    }

    if (extraction.findings.length === 0) {
      traceEvents.push({
        step: 'agent.noop',
        detail: `No structured clinical finding extracted from utterance ${input.utteranceId}.`,
        confidence: 0.9,
      });
    } else {
      traceEvents.push({
        step: 'agent.completed',
        detail: `AI SDK extraction produced ${extraction.findings.length} structured finding${extraction.findings.length === 1 ? '' : 's'}.`,
        confidence: extraction.findings[0]?.confidence,
      });
    }

    return {
      extraction,
      mode: 'ai-sdk',
      traceEvents,
    };
  } catch (error) {
    return runHeuristicFallback(
      input,
      error instanceof Error ? `AI SDK agent failed: ${error.message}` : 'AI SDK agent failed. Using heuristic fallback.',
      traceEvents,
    );
  }
}

export function createExtractionFromTranscript(input: Omit<ExtractionInput, 'utteranceId'>): AgentExtraction {
  return createHeuristicExtraction({
    ...input,
    utteranceId: 'utt-heuristic',
  });
}

function runHeuristicFallback(
  input: ExtractionInput,
  detail: string,
  traceEvents: AgentTraceEvent[] = [],
): ClinicalAgentResult {
  const extraction = createHeuristicExtraction(input);

  traceEvents.push({
    step: 'agent.mode',
    detail: 'Extraction mode: heuristic fallback.',
    confidence: 0.7,
  });

  traceEvents.push({
    step: 'agent.fallback',
    detail,
    confidence: 0.65,
  });

  if (extraction.findings.length === 0) {
    traceEvents.push({
      step: 'agent.noop',
      detail: `No structured clinical finding extracted from utterance ${input.utteranceId}.`,
      confidence: 0.9,
    });
  } else {
    traceEvents.push({
      step: 'tool.called',
      detail: `Heuristic fallback prepared ${extraction.findings.length} finding${extraction.findings.length === 1 ? '' : 's'} for chart update.`,
      confidence: extraction.findings[0]?.confidence,
    });
    traceEvents.push({
      step: 'schema.validated',
      detail: 'Heuristic fallback output validated against AgentExtractionSchema.',
      confidence: 0.96,
    });
    traceEvents.push({
      step: 'agent.completed',
      detail: `Heuristic fallback produced ${extraction.findings.length} structured finding${extraction.findings.length === 1 ? '' : 's'}.`,
      confidence: extraction.findings[0]?.confidence,
    });
  }

  return {
    extraction,
    mode: 'heuristic',
    traceEvents,
  };
}

function createHeuristicExtraction(input: ExtractionInput): AgentExtraction {
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
              sourceUtteranceId: input.utteranceId,
            },
          ]
        : [],
    noteSummary: input.transcript,
    requiresReview: false,
  });
}
