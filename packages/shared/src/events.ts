export type RealtimeEvent =
  | { type: 'session.started'; sessionId: string; ts: string }
  | { type: 'audio.level'; level: number; ts: string }
  | { type: 'transcript.partial'; utteranceId: string; text: string; ts: string }
  | { type: 'transcript.final'; utteranceId: string; text: string; redactedText?: string; ts: string }
  | { type: 'trace.event'; step: string; detail: string; confidence?: number; ts: string }
  | { type: 'chart.finding.staged'; findingId: string; payload: unknown; ts: string }
  | { type: 'chart.finding.committed'; findingId: string; payload: unknown; ts: string }
  | { type: 'metric'; name: string; value: number; unit: string; ts: string }
  | { type: 'session.closed'; sessionId: string; ts: string };

export type ClientSocketMessage =
  | {
      type: 'session.start';
      mode: 'demo' | 'live';
      audio?: {
        encoding: 'linear16';
        sampleRate: number;
      };
    }
  | {
      type: 'session.stop';
    };

export type SessionClosePayload = {
  sessionId: string;
  patientId: string;
  closedAt: string;
  transcript: {
    finalText: string;
  };
  structuredFindings: Array<{
    toothNumber: number;
    probingDepthMm?: number;
    bleedingOnProbing?: boolean;
    confidence: number;
    sourceUtteranceId: string;
  }>;
  artifacts: {
    trace: unknown[];
    metrics: unknown[];
  };
};
