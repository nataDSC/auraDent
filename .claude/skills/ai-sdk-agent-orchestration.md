---
name: ai-sdk-agent-orchestration
description: Use when working on packages/agent-core/src/index.ts — replacing or extending the clinical agent with Vercel AI SDK v5 orchestration, adding tools, or modifying extraction output.
---

# AI SDK Agent Orchestration

## Entry Point Contract

The public API must not change. The gateway calls:

```typescript
import { runClinicalAgent } from '@auradent/agent-core';

const result = await runClinicalAgent({
  sessionId: string,
  patientId: string,
  transcript: string,   // already PII-redacted
  utteranceId: string,
});
// result: ClinicalAgentResult
```

Return type:

```typescript
export type ClinicalAgentResult = {
  extraction: AgentExtraction;        // validated against AgentExtractionSchema
  mode: 'ai-sdk' | 'heuristic';
  traceEvents: AgentTraceEvent[];     // emitted to the gateway trace panel
};

export type AgentTraceEvent = {
  step: string;       // dot-namespaced: 'agent.started', 'tool.called', 'schema.validated', etc.
  detail: string;     // human-readable sentence
  confidence?: number; // 0–1
};
```

## AI SDK v5 Import Pattern

```typescript
import { generateObject, generateText, tool, zodSchema } from 'ai';
```

These are the only four imports needed from `'ai'`. Do not use `createOpenAI`, `openai`, or any provider-specific package — the gateway provider is configured via the model string and API key.

## Model Selection

```typescript
process.env.AURADENT_AGENT_MODEL ?? 'openai/gpt-4.1-mini'
```

The model string uses a provider-prefix format (`openai/gpt-4.1-mini`, `anthropic/claude-3-5-haiku-20241022`). This is resolved by the AI gateway. Never hardcode a model ID.

## Tool Definition Pattern

Use the existing `check_patient_history` and `update_perio_chart` tools as canonical models:

```typescript
const myTool = tool<InputType, OutputType>({
  description: 'One sentence describing when and why to call this tool.',
  inputSchema: zodSchema(
    z.object({
      fieldName: z.string(),
    }),
  ),
  execute: async ({ fieldName }: InputType) => {
    traceEvents.push({ step: 'tool.called', detail: 'myTool invoked.', confidence: 0.97 });

    const result = OutputSchema.parse({ /* ... */ });

    traceEvents.push({ step: 'tool.result', detail: 'myTool completed.', confidence: 0.97 });

    return result;
  },
});
```

Key rules:
- `inputSchema` uses `zodSchema()` wrapper, not a raw Zod schema.
- `execute` must return a value matching the declared `OutputType`.
- Push two trace events per tool: one on call, one on result.
- Validate the return value with `.parse()` before returning — don't trust the model's mock output shape.

## Two-Pass Orchestration Pattern

The current implementation uses two passes — follow this structure:

### Pass 1: Context pass (`generateText` with tools)

```typescript
const contextResult = await generateText<typeof practiceTools>({
  model: process.env.AURADENT_AGENT_MODEL ?? 'openai/gpt-4.1-mini',
  system: 'System prompt for context gathering.',
  prompt: `sessionId: ${input.sessionId}\npatientId: ${input.patientId}\nsourceUtteranceId: ${input.utteranceId}\ntranscript: ${input.transcript}`,
  tools: practiceTools,
  activeTools: ['check_patient_history'],  // restrict which tools can be called in this pass
});
```

### Pass 2: Extraction pass (`generateObject` with schema)

```typescript
const { object } = await generateObject({
  model: process.env.AURADENT_AGENT_MODEL ?? 'openai/gpt-4.1-mini',
  system: 'System prompt for structured extraction.',
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
```

## Output Schemas (from `@auradent/shared`)

```typescript
import { AgentExtractionSchema, PerioFindingSchema, type AgentExtraction, type PerioFinding } from '@auradent/shared';

// AgentExtractionSchema shape:
// {
//   sessionId: string,
//   patientId: string,
//   findings: PerioFinding[],
//   requiresReview: boolean (default false),
//   noteSummary?: string,
// }

// PerioFindingSchema shape:
// {
//   toothNumber: number (int, 1–32),
//   probingDepthMm?: number (int, 1–15),
//   bleedingOnProbing?: boolean,
//   confidence: number (0–1),
//   sourceUtteranceId: string,
// }
```

## Post-Generation Validation

Always re-parse the model output with Zod and override identity fields:

```typescript
const generated = object as AgentExtraction;
const extraction = AgentExtractionSchema.parse({
  ...generated,
  sessionId: input.sessionId,    // trust input, not model output
  patientId: input.patientId,
  findings: generated.findings.map((finding: PerioFinding) => ({
    ...finding,
    sourceUtteranceId: input.utteranceId,  // always override — model may hallucinate IDs
  })),
});
```

## Heuristic Fallback

The heuristic fallback must remain intact. It runs when:
- `AI_GATEWAY_API_KEY` is absent (checked first, before any AI SDK calls)
- Any AI SDK call throws

```typescript
export async function runClinicalAgent(input: ExtractionInput): Promise<ClinicalAgentResult> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    return runHeuristicFallback(input, 'AI gateway not configured. Using heuristic extraction fallback.');
  }

  const traceEvents: AgentTraceEvent[] = [/* initial trace events */];

  try {
    // ... AI SDK calls ...
    return { extraction, mode: 'ai-sdk', traceEvents };
  } catch (error) {
    return runHeuristicFallback(
      input,
      error instanceof Error ? `AI SDK agent failed: ${error.message}` : 'AI SDK agent failed. Using heuristic fallback.',
      traceEvents,  // pass accumulated trace events so they're preserved
    );
  }
}
```

`runHeuristicFallback` signature:

```typescript
function runHeuristicFallback(
  input: ExtractionInput,
  detail: string,
  traceEvents: AgentTraceEvent[] = [],  // accumulated events from failed AI path
): ClinicalAgentResult
```

## Trace Event Naming Conventions

Use these step names consistently:

| Step | When to emit |
|---|---|
| `agent.started` | First thing in the AI SDK path |
| `agent.mode` | After determining ai-sdk vs. heuristic |
| `agent.context` | After the context pass (generateText) completes |
| `tool.called` | At the start of each tool.execute() |
| `tool.result` | At the end of each tool.execute() |
| `schema.validated` | After AgentExtractionSchema.parse() succeeds |
| `agent.completed` | When extraction has findings |
| `agent.noop` | When extraction returns empty findings[] |
| `agent.fallback` | When falling back to heuristic |
| `agent.handoff` | Emitted by the gateway before calling runClinicalAgent |

## Adding a New Tool

1. Define input/output Zod schemas.
2. Create the `tool<InputType, OutputType>({ ... })` object following the canonical pattern above.
3. Add it to the `practiceTools` record with a snake_case key.
4. Add it to `activeTools` in the `generateText` call only if it should be callable in the context pass.
5. Push `tool.called` and `tool.result` trace events inside `execute`.
6. Validate the return with `.parse()`.

Do NOT add the new tool to `generateObject` — only `generateText` supports tool calls. The extraction pass uses schema-constrained generation only.
