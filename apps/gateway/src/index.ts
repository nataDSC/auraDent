import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { runClinicalAgent } from '@auradent/agent-core';
import { processSessionClosePayload, withSessionPersistence } from '@auradent/worker/process-session-close';
import {
  redactTranscriptPII,
  type ClientSocketMessage,
  type RealtimeEvent,
  type SessionClosePayload,
} from '@auradent/shared';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  getDeepgramReconnectDelayMs,
  MAX_DEEPGRAM_RETRY_ATTEMPTS,
  shouldRetryDeepgramSession,
} from './deepgram-retry';
import { hasClinicalSignal, isReadyForStructuredExtraction } from './extraction-gating';
import { buildSessionClosePayload, writeSessionClosePayloadToDisk } from './session-close';
import { reconcileTranscriptRevision, type TranscriptRevisionStore } from './transcript-revisions';

type SocketMessage = string | Buffer | ArrayBuffer | Buffer[];

type GatewaySessionState = {
  activeSessionId?: string;
  audioInterval?: NodeJS.Timeout;
  autoPersistToPostgres: boolean;
  deepgramReconnectAttempt: number;
  deepgramReconnectTimer?: NodeJS.Timeout;
  deepgramSocket?: WebSocket;
  deepgramKeepAlive?: NodeJS.Timeout;
  deepgramOpenedAt?: number;
  liveAudioSampleRate?: number;
  completedExtractionSequence: number;
  extractionChain: Promise<void>;
  extractionSequence: number;
  hasEmittedTtft: boolean;
  isStopping: boolean;
  lastAudioAt?: number;
  pendingExtractions: Set<Promise<void>>;
  transcriptRevisions: TranscriptRevisionStore;
  transcriptCounter: number;
  demoTimers: NodeJS.Timeout[];
  finalizedUtterances: Array<{
    utteranceId: string;
    text: string;
    redactedText?: string;
  }>;
  traceEvents: Array<{
    step: string;
    detail: string;
    confidence?: number;
    ts: string;
  }>;
  metrics: Array<{
    name: string;
    value: number;
    unit: string;
    ts: string;
  }>;
  findings: SessionClosePayload['structuredFindings'];
};

type PersistedFindingPayload = {
  label: string;
  detail: string;
  toothNumber: number;
  probingDepthMm?: number;
  bleedingOnProbing?: boolean;
  confidence: number;
  sourceUtteranceId: string;
};

type DeepgramTranscriptMessage = {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  start?: number;
  duration?: number;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
    }>;
  };
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadLocalEnvFiles();

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(websocket);

app.get('/health', async () => ({
  ok: true,
  service: 'auradent-gateway',
  now: new Date().toISOString(),
  deepgramConfigured: Boolean(process.env.DEEPGRAM_API_KEY),
}));

app.register(async (instance) => {
  instance.get('/realtime/session/:sessionId', { websocket: true }, (socket, request) => {
    const sessionId = String((request.params as { sessionId: string }).sessionId);
    const state: GatewaySessionState = {
      activeSessionId: sessionId,
      completedExtractionSequence: 0,
      transcriptCounter: 0,
      demoTimers: [],
      autoPersistToPostgres: false,
      deepgramReconnectAttempt: 0,
      hasEmittedTtft: false,
      extractionChain: Promise.resolve(),
      extractionSequence: 0,
      isStopping: false,
      finalizedUtterances: [],
      traceEvents: [],
      metrics: [],
      findings: [],
      pendingExtractions: new Set(),
      transcriptRevisions: new Map(),
    };

    const send = (event: RealtimeEvent) => {
      if (event.type === 'trace.event') {
        state.traceEvents.push({
          step: event.step,
          detail: event.detail,
          confidence: event.confidence,
          ts: event.ts,
        });
      }

      if (event.type === 'metric') {
        state.metrics.push({
          name: event.name,
          value: event.value,
          unit: event.unit,
          ts: event.ts,
        });
      }

      if (event.type === 'chart.finding.staged' || event.type === 'chart.finding.committed') {
        const payload = event.payload as {
          sourceUtteranceId?: string;
          toothNumber?: number;
          probingDepthMm?: number;
          bleedingOnProbing?: boolean;
          confidence?: number;
        };

        if (typeof payload.toothNumber === 'number') {
          state.findings = [
            ...state.findings.filter((finding) =>
              !(finding.sourceUtteranceId === payload.sourceUtteranceId && finding.toothNumber === payload.toothNumber),
            ),
            {
              toothNumber: payload.toothNumber,
              probingDepthMm: payload.probingDepthMm,
              bleedingOnProbing: payload.bleedingOnProbing,
              confidence: payload.confidence ?? 0.9,
              sourceUtteranceId: payload.sourceUtteranceId ?? 'unknown',
            },
          ];
        }
      }

      socket.send(JSON.stringify(event));
    };

    const sendTrace = (step: string, detail: string, confidence?: number) =>
      send({
        type: 'trace.event',
        step,
        detail,
        confidence,
        ts: new Date().toISOString(),
      });

    send({
      type: 'session.started',
      sessionId,
      ts: new Date().toISOString(),
    });

    sendTrace(
      'session.ready',
      process.env.DEEPGRAM_API_KEY
        ? 'Gateway ready for live microphone streaming.'
        : 'Gateway ready. Deepgram is not configured, so live mode will fall back to demo events.',
      0.99,
    );

    socket.on('message', async (raw: SocketMessage, isBinary: boolean) => {
      if (isBinary) {
        forwardAudioChunk(state, raw);
        return;
      }

      try {
        const payload = JSON.parse(normalizeSocketMessage(raw)) as ClientSocketMessage;

        if (payload.type === 'session.start') {
          teardownSession(state);
          resetSessionArtifacts(state);
          state.activeSessionId = payload.sessionId;
          state.autoPersistToPostgres = Boolean(payload.localPersistence?.postgresOnStop);

          send({
            type: 'session.started',
            sessionId: payload.sessionId,
            ts: new Date().toISOString(),
          });

          if (payload.mode === 'live') {
            if (!process.env.DEEPGRAM_API_KEY) {
              sendTrace(
                'session.mode.error',
                'Live microphone mode requires DEEPGRAM_API_KEY. The gateway stayed idle instead of falling back to demo.',
                0.2,
              );
              return;
            }

            if (!payload.audio?.sampleRate) {
              sendTrace(
                'session.mode.error',
                'Live microphone mode was requested without audio sample rate metadata.',
                0.2,
              );
              return;
            }

            startLiveSession({
              audioSampleRate: payload.audio.sampleRate,
              request,
              send,
              sendTrace,
              sessionId: payload.sessionId,
              state,
            });
            return;
          }

          startDemoSession({ request, send, sendTrace, state, sessionId: payload.sessionId });
          return;
        }

        if (payload.type === 'session.stop') {
          state.isStopping = true;
          stopDemoSession(state);
          finalizeDeepgram(state);
          await waitForRealtimeSettle();
          await waitForPendingExtractions(state);
          await publishSessionClose({
            request,
            sendTrace,
            state,
            sessionId: state.activeSessionId ?? sessionId,
          });
          send({
            type: 'session.closed',
            sessionId: state.activeSessionId ?? sessionId,
            ts: new Date().toISOString(),
          });
        }
      } catch (error) {
        request.log.error({ error }, 'Failed to parse websocket payload');
      }
    });

    socket.on('close', () => {
      teardownSession(state);
    });
  });
});

const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: '0.0.0.0' });

app.log.info(`AuraDent gateway listening on ${port}`);

function startDemoSession({
  request,
  send,
  sendTrace,
  sessionId,
  state,
}: {
  request: FastifyRequest;
  send: (event: RealtimeEvent) => void;
  sendTrace: (step: string, detail: string, confidence?: number) => void;
  sessionId: string;
  state: GatewaySessionState;
}) {
  sendTrace('session.mode', 'Starting demo mode transcript stream.', 0.95);

  state.audioInterval = setInterval(() => {
    send({
      type: 'audio.level',
      level: Number((0.08 + Math.random() * 0.72).toFixed(2)),
      ts: new Date().toISOString(),
    });
  }, 180);

  const transcriptScript = [
    {
      utteranceId: 'utt-001',
      partial: 'Patient James Brown. Phone number',
      final: 'Patient James Brown. Phone number, 415-555-1212.',
    },
    {
      utteranceId: 'utt-002',
      partial: 'Has four millimeter',
      final: 'Has four millimeter pockets',
    },
    {
      utteranceId: 'utt-003',
      partial: 'on tooth 14',
      final: 'on tooth 14 with bleeding on probing.',
    },
  ];

  send({
    type: 'metric',
    name: 'ttft',
    value: 182,
    unit: 'ms',
    ts: new Date().toISOString(),
  });

  transcriptScript.forEach((item, index) => {
    const baseDelay = 900 + index * 1200;

    state.demoTimers.push(
      setTimeout(() => {
        send({
          type: 'transcript.partial',
          utteranceId: item.utteranceId,
          text: item.partial,
          ts: new Date().toISOString(),
        });
      }, baseDelay),
    );

    state.demoTimers.push(
      setTimeout(() => {
        const finalRedaction = redactTranscriptPII(item.final);
        send({
          type: 'transcript.final',
          utteranceId: item.utteranceId,
          text: item.final,
          redactedText: finalRedaction.matches.length > 0 ? finalRedaction.text : undefined,
          ts: new Date().toISOString(),
        });
        recordFinalUtterance(state, item.utteranceId, item.final);

        if (index === transcriptScript.length - 1) {
          const transcriptWindow = getTranscriptWindow(state, item.utteranceId);
          queueExtraction(state, () => emitStructuredFindings({
            send,
            sendTrace,
            sessionId,
            transcript: transcriptWindow,
            currentUtteranceText: item.final,
            utteranceId: item.utteranceId,
          }).catch((error) => {
            request.log.error({ error }, 'Failed to emit structured demo findings');
            sendTrace('agent.error', 'Clinical agent failed during demo extraction.', 0.3);
          }));

          send({
            type: 'metric',
            name: 'finalization_latency',
            value: 244,
            unit: 'ms',
            ts: new Date().toISOString(),
          });
        }
      }, baseDelay + 540),
    );
  });
}

function startLiveSession({
  audioSampleRate,
  request,
  send,
  sendTrace,
  sessionId,
  state,
}: {
  audioSampleRate: number;
  request: FastifyRequest;
  send: (event: RealtimeEvent) => void;
  sendTrace: (step: string, detail: string, confidence?: number) => void;
  sessionId: string;
  state: GatewaySessionState;
}) {
  state.liveAudioSampleRate = audioSampleRate;
  connectDeepgramSession({
    audioSampleRate,
    request,
    send,
    sendTrace,
    sessionId,
    state,
    isRetry: state.deepgramReconnectAttempt > 0,
  });
}

function connectDeepgramSession({
  audioSampleRate,
  request,
  send,
  sendTrace,
  sessionId,
  state,
  isRetry,
}: {
  audioSampleRate: number;
  request: FastifyRequest;
  send: (event: RealtimeEvent) => void;
  sendTrace: (step: string, detail: string, confidence?: number) => void;
  sessionId: string;
  state: GatewaySessionState;
  isRetry: boolean;
}) {
  clearTimeout(state.deepgramReconnectTimer);
  state.deepgramReconnectTimer = undefined;

  const deepgramUrl = new URL('wss://api.deepgram.com/v1/listen');
  deepgramUrl.searchParams.set('model', process.env.DEEPGRAM_MODEL ?? 'nova-3');
  deepgramUrl.searchParams.set('language', 'en-US');
  deepgramUrl.searchParams.set('encoding', 'linear16');
  deepgramUrl.searchParams.set('sample_rate', String(audioSampleRate));
  deepgramUrl.searchParams.set('interim_results', 'true');
  deepgramUrl.searchParams.set('smart_format', 'true');
  deepgramUrl.searchParams.set('punctuate', 'true');

  const openedAt = Date.now();
  const deepgramSocket = new WebSocket(deepgramUrl, {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
    },
  });

  state.deepgramSocket = deepgramSocket;
  state.deepgramOpenedAt = openedAt;
  state.lastAudioAt = Date.now();

  deepgramSocket.on('open', () => {
    state.deepgramReconnectAttempt = 0;
    sendTrace(
      isRetry ? 'deepgram.reconnected' : 'deepgram.connected',
      isRetry
        ? 'Deepgram live transcription websocket recovered after a transient disconnect.'
        : 'Deepgram live transcription websocket opened.',
      0.99,
    );

    state.deepgramKeepAlive = setInterval(() => {
      if (!state.deepgramSocket || state.deepgramSocket.readyState !== WebSocket.OPEN) {
        return;
      }

      const idleFor = Date.now() - (state.lastAudioAt ?? 0);
      if (idleFor >= 3000) {
        state.deepgramSocket.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, 3000);
  });

  deepgramSocket.on('message', (message) => {
    const parsed = safeParseJson<DeepgramTranscriptMessage>(toBuffer(message as SocketMessage).toString('utf8'));
    if (!parsed || parsed.type !== 'Results') {
      return;
    }

    const alternative = parsed.channel?.alternatives?.[0];
    const transcript = alternative?.transcript?.trim();
    if (!transcript) {
      return;
    }

    const utteranceId = getUtteranceId(parsed, state);
    const confidence = alternative?.confidence;
    const ts = new Date().toISOString();
    const revision = reconcileTranscriptRevision({
      utteranceId,
      text: transcript,
      isFinal: Boolean(parsed.is_final),
      store: state.transcriptRevisions,
    });
    state.transcriptRevisions = revision.nextStore;

    if (!revision.shouldEmit) {
      return;
    }

    if (!state.hasEmittedTtft && typeof state.deepgramOpenedAt === 'number') {
      state.hasEmittedTtft = true;
      send({
        type: 'metric',
        name: 'ttft',
        value: Math.max(0, Date.now() - state.deepgramOpenedAt),
        unit: 'ms',
        ts,
      });
    }

    const finalRedaction = parsed.is_final ? redactTranscriptPII(revision.text) : null;

    send(
      parsed.is_final
        ? {
            type: 'transcript.final',
            utteranceId,
            text: revision.text,
            redactedText: finalRedaction && finalRedaction.matches.length > 0 ? finalRedaction.text : undefined,
            ts,
          }
        : { type: 'transcript.partial', utteranceId, text: revision.text, ts },
    );

    if (parsed.is_final) {
      recordFinalUtterance(state, utteranceId, revision.text);
      sendTrace('transcript.finalized', `Deepgram finalized utterance ${utteranceId}.`, confidence);

      if (
        typeof state.deepgramOpenedAt === 'number' &&
        typeof parsed.start === 'number' &&
        typeof parsed.duration === 'number'
      ) {
        const finalizationLatency = Math.max(
          0,
          Date.now() - state.deepgramOpenedAt - Math.round((parsed.start + parsed.duration) * 1000),
        );
        send({
          type: 'metric',
          name: 'finalization_latency',
          value: finalizationLatency,
          unit: 'ms',
          ts,
        });
      }
    }

    if (revision.shouldQueueExtraction) {
      const transcriptWindow = getTranscriptWindow(state, utteranceId);
      queueExtraction(state, () => emitStructuredFindings({
        send,
        sendTrace,
        sessionId,
        transcript: transcriptWindow,
        currentUtteranceText: revision.text,
        utteranceId,
      }).catch((error) => {
        request.log.error({ error }, 'Failed to emit structured live findings');
        sendTrace('agent.error', `Clinical agent failed for utterance ${utteranceId}.`, 0.3);
      }));
    }
  });

  deepgramSocket.on('error', (error) => {
    request.log.error({ error }, 'Deepgram websocket error');
    sendTrace('deepgram.error', 'Deepgram live transcription failed. Check your API key and audio settings.', 0.25);
  });

  deepgramSocket.on('close', () => {
    if (state.deepgramSocket !== deepgramSocket) {
      return;
    }

    sendTrace('deepgram.closed', 'Deepgram live transcription websocket closed.', 0.92);
    clearInterval(state.deepgramKeepAlive);
    state.deepgramKeepAlive = undefined;
    state.deepgramSocket = undefined;

    if (
      shouldRetryDeepgramSession({
        attempt: state.deepgramReconnectAttempt,
        hasAudioSampleRate: typeof state.liveAudioSampleRate === 'number',
        isStopping: state.isStopping,
      })
    ) {
      const nextAttempt = state.deepgramReconnectAttempt + 1;
      state.deepgramReconnectAttempt = nextAttempt;
      const delayMs = getDeepgramReconnectDelayMs(nextAttempt);

      sendTrace(
        'deepgram.reconnecting',
        `Retrying Deepgram live transcription connection in ${delayMs}ms (attempt ${nextAttempt}/${MAX_DEEPGRAM_RETRY_ATTEMPTS}).`,
        0.74,
      );

      state.deepgramReconnectTimer = setTimeout(() => {
        if (typeof state.liveAudioSampleRate !== 'number') {
          return;
        }

        connectDeepgramSession({
          audioSampleRate: state.liveAudioSampleRate,
          request,
          send,
          sendTrace,
          sessionId,
          state,
          isRetry: true,
        });
      }, delayMs);
      return;
    }

    if (!state.isStopping && typeof state.liveAudioSampleRate === 'number') {
      sendTrace(
        'deepgram.retry_exhausted',
        'Deepgram live transcription could not be recovered automatically. Stop and restart the session to continue.',
        0.28,
      );
    }
  });
}

function forwardAudioChunk(state: GatewaySessionState, raw: SocketMessage) {
  if (!state.deepgramSocket || state.deepgramSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  state.lastAudioAt = Date.now();
  const chunk = toBuffer(raw);
  if (chunk.byteLength === 0) {
    return;
  }

  state.deepgramSocket.send(chunk);
}

async function emitStructuredFindings({
  send,
  sendTrace,
  sessionId,
  transcript,
  currentUtteranceText,
  utteranceId,
}: {
  send: (event: RealtimeEvent) => void;
  sendTrace: (step: string, detail: string, confidence?: number) => void;
  sessionId: string;
  transcript: string;
  currentUtteranceText: string;
  utteranceId: string;
}) {
  const currentUtteranceRedaction = redactTranscriptPII(currentUtteranceText);
  const redaction = redactTranscriptPII(transcript);

  if (currentUtteranceRedaction.matches.length > 0) {
    const summary = summarizeRedactions(currentUtteranceRedaction.matches);
    sendTrace(
      'redaction.applied',
      `PII redacted for finalized utterance ${utteranceId} before agent handoff: ${summary}.`,
      0.98,
    );
  }

  if (!isReadyForStructuredExtraction(redaction.text)) {
    if (hasClinicalSignal(redaction.text)) {
      sendTrace(
        'agent.deferred',
        `Deferred structured extraction for utterance ${utteranceId} until an explicit tooth reference is available.`,
        0.88,
      );
    }
    return;
  }

  sendTrace('agent.handoff', `Handing finalized utterance ${utteranceId} to the clinical agent.`, 0.97);

  const result = await runClinicalAgent({
    sessionId,
    patientId: 'demo-patient',
    transcript: redaction.text,
    utteranceId,
  });

  for (const traceEvent of result.traceEvents) {
    sendTrace(traceEvent.step, traceEvent.detail, traceEvent.confidence);
  }

  if (result.extraction.findings.length === 0) {
    return;
  }

  result.extraction.findings.forEach((finding, findingIndex) => {
    const findingId = `${finding.toothNumber}-${findingIndex}`;
    const payload: PersistedFindingPayload = {
      label: `Tooth #${finding.toothNumber}`,
      detail: `${finding.probingDepthMm ?? 'N/A'}mm pocket${finding.bleedingOnProbing ? ' • BOP' : ''}`,
      toothNumber: finding.toothNumber,
      probingDepthMm: finding.probingDepthMm,
      bleedingOnProbing: finding.bleedingOnProbing,
      confidence: finding.confidence,
      sourceUtteranceId: finding.sourceUtteranceId,
    };

    send({
      type: 'chart.finding.staged',
      findingId,
      payload,
      ts: new Date().toISOString(),
    });
  });
}

function finalizeDeepgram(state: GatewaySessionState) {
  if (!state.deepgramSocket || state.deepgramSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  state.deepgramSocket.send(JSON.stringify({ type: 'Finalize' }));
  setTimeout(() => {
    state.deepgramSocket?.close();
  }, 250);
}

function teardownSession(state: GatewaySessionState) {
  stopDemoSession(state);
  clearTimeout(state.deepgramReconnectTimer);
  clearInterval(state.deepgramKeepAlive);

  if (state.deepgramSocket) {
    if (state.deepgramSocket.readyState === WebSocket.OPEN) {
      state.deepgramSocket.send(JSON.stringify({ type: 'Finalize' }));
      state.deepgramSocket.close();
    }
    state.deepgramSocket = undefined;
  }
}

function stopDemoSession(state: GatewaySessionState) {
  clearInterval(state.audioInterval);
  state.audioInterval = undefined;
  state.demoTimers.forEach((timer) => clearTimeout(timer));
  state.demoTimers = [];
}

function resetSessionArtifacts(state: GatewaySessionState) {
  state.completedExtractionSequence = 0;
  state.deepgramOpenedAt = undefined;
  state.deepgramReconnectAttempt = 0;
  state.liveAudioSampleRate = undefined;
  state.extractionChain = Promise.resolve();
  state.extractionSequence = 0;
  state.hasEmittedTtft = false;
  state.isStopping = false;
  state.pendingExtractions = new Set();
  state.transcriptRevisions = new Map();
  state.transcriptCounter = 0;
  state.finalizedUtterances = [];
  state.traceEvents = [];
  state.metrics = [];
  state.findings = [];
}

function getUtteranceId(message: DeepgramTranscriptMessage, state: GatewaySessionState) {
  if (typeof message.start === 'number') {
    return `utt-${Math.round(message.start * 1000)}`;
  }

  state.transcriptCounter += 1;
  return `utt-${String(state.transcriptCounter).padStart(4, '0')}`;
}

function normalizeSocketMessage(raw: SocketMessage): string {
  if (typeof raw === 'string') {
    return raw;
  }

  return toBuffer(raw).toString('utf8');
}

function toBuffer(raw: SocketMessage): Buffer {
  if (raw instanceof Buffer) {
    return raw;
  }

  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw);
  }

  if (Array.isArray(raw)) {
    return Buffer.concat(raw);
  }

  return Buffer.from(raw);
}

function safeParseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function recordFinalUtterance(state: GatewaySessionState, utteranceId: string, text: string) {
  const redaction = redactTranscriptPII(text);
  state.finalizedUtterances = [
    ...state.finalizedUtterances.filter((entry) => entry.utteranceId !== utteranceId),
    {
      utteranceId,
      text,
      redactedText: redaction.matches.length > 0 ? redaction.text : undefined,
    },
  ].slice(-4);
}

function getTranscriptWindow(state: GatewaySessionState, utteranceId: string) {
  const currentIndex = state.finalizedUtterances.findIndex((entry) => entry.utteranceId === utteranceId);
  if (currentIndex < 0) {
    return '';
  }

  return state.finalizedUtterances
    .slice(Math.max(0, currentIndex - 2), currentIndex + 1)
    .map((entry) => entry.text)
    .join(' ');
}

function summarizeRedactions(
  matches: Array<{
    entityType: string;
  }>,
) {
  const counts = new Map<string, number>();

  for (const match of matches) {
    counts.set(match.entityType, (counts.get(match.entityType) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([entityType, count]) => `${entityType} x${count}`)
    .join(', ');
}

async function publishSessionClose({
  request,
  sendTrace,
  state,
  sessionId,
}: {
  request: FastifyRequest;
  sendTrace: (step: string, detail: string, confidence?: number) => void;
  state: GatewaySessionState;
  sessionId: string;
}) {
  const payload = buildSessionClosePayload({
    sessionId,
    patientId: 'demo-patient',
    artifacts: {
      findings: state.findings,
      metrics: state.metrics,
      traceEvents: state.traceEvents,
      transcriptEntries: state.finalizedUtterances,
    },
  });

  await writeSessionClosePayloadToDisk({
    payload,
    directory:
      process.env.AURADENT_SESSION_CLOSE_OUTPUT_DIR ??
      path.resolve(__dirname, '../../../tmp/session-close'),
  });
  const publisher = createSessionClosePublisher();
  try {
    await publisher.publish(payload);
    sendTrace('session.wrapup.enqueued', 'Session close payload published for async processing.', 0.97);
    if (state.autoPersistToPostgres) {
      await persistSessionCloseToLocalPostgres({
        payload,
        request,
        sendTrace,
      });
    }
  } catch (error) {
    request.log.error({ error }, 'Failed to publish session close payload');
    sendTrace('session.wrapup.error', 'Failed to publish session close payload for async processing.', 0.3);
  }
}

async function persistSessionCloseToLocalPostgres(args: {
  payload: SessionClosePayload;
  request: FastifyRequest;
  sendTrace: (step: string, detail: string, confidence?: number) => void;
}) {
  if (!process.env.AURADENT_DATABASE_URL) {
    args.sendTrace(
      'session.wrapup.persist.error',
      'Write to Postgres on Stop is enabled, but AURADENT_DATABASE_URL is not configured on the gateway.',
      0.32,
    );
    return;
  }

  try {
    const summary = await withSessionPersistence((persistence) =>
      processSessionClosePayload(args.payload, persistence, {
        runtime: 'local',
      }),
    );

    if (summary.persistence !== 'postgres') {
      args.sendTrace(
        'session.wrapup.persist.error',
        `Write to Postgres on Stop requested PostgreSQL, but persistence resolved to ${summary.persistence}.`,
        0.32,
      );
      return;
    }

    args.sendTrace(
      'session.wrapup.persisted',
      `Local Postgres persistence completed for ${summary.sessionId} with ${summary.findings} finding${summary.findings === 1 ? '' : 's'}.`,
      0.98,
    );
  } catch (error) {
    args.request.log.error({ error }, 'Failed local Postgres persistence after session stop');
    args.sendTrace(
      'session.wrapup.persist.error',
      error instanceof Error
        ? `Local Postgres persistence failed: ${error.message}`
        : 'Local Postgres persistence failed after session stop.',
      0.24,
    );
  }
}

function createSessionClosePublisher() {
  const queueUrl = process.env.AURADENT_SESSION_CLOSE_QUEUE_URL;
  const awsRegion = process.env.AURADENT_AWS_REGION ?? process.env.AWS_REGION ?? 'us-west-2';
  const sqsClient = queueUrl ? new SQSClient({ region: awsRegion }) : null;

  return {
    publish: async (payload: SessionClosePayload) => {
      if (queueUrl && sqsClient) {
        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(payload),
            MessageAttributes: {
              sessionId: {
                DataType: 'String',
                StringValue: payload.sessionId,
              },
              patientId: {
                DataType: 'String',
                StringValue: payload.patientId,
              },
            },
          }),
        );

        console.log(
          JSON.stringify({
            level: 'info',
            message: 'Session close payload published to SQS',
            queueUrl,
            region: awsRegion,
            sessionId: payload.sessionId,
            findings: payload.structuredFindings.length,
          }),
        );
        return;
      }

      console.log(
        JSON.stringify({
          level: 'info',
          message: 'Session close payload published locally',
          sessionId: payload.sessionId,
          payload,
        }),
      );
    },
  };
}

function trackExtraction(state: GatewaySessionState, promise: Promise<void>) {
  state.pendingExtractions.add(promise);
  promise.finally(() => {
    state.pendingExtractions.delete(promise);
  });
}

function queueExtraction(state: GatewaySessionState, run: () => Promise<void>) {
  const sequence = state.extractionSequence + 1;
  state.extractionSequence = sequence;

  const queued = state.extractionChain.then(async () => {
    await run();
    state.completedExtractionSequence = sequence;
  });

  state.extractionChain = queued.catch(() => undefined);
  trackExtraction(state, queued);
}

async function waitForPendingExtractions(state: GatewaySessionState) {
  while (
    state.pendingExtractions.size > 0 ||
    state.completedExtractionSequence < state.extractionSequence
  ) {
    await Promise.allSettled(Array.from(state.pendingExtractions));
    await state.extractionChain;
  }
}

async function waitForRealtimeSettle() {
  await delay(350);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function loadLocalEnvFiles() {
  const repoRoot = path.resolve(__dirname, '../../..');
  const candidatePaths = [
    path.join(repoRoot, '.env'),
    path.join(repoRoot, '.env.local'),
    path.join(__dirname, '../.env'),
    path.join(__dirname, '../.env.local'),
  ];

  for (const filePath of candidatePaths) {
    if (!existsSync(filePath)) {
      continue;
    }

    const contents = readFileSync(filePath, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex < 1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const rawValue = trimmed.slice(separatorIndex + 1).trim();
      if (!key || process.env[key] !== undefined) {
        continue;
      }

      process.env[key] = stripEnvWrappingQuotes(rawValue);
    }
  }
}

function stripEnvWrappingQuotes(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
