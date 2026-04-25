import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { runClinicalAgent } from '@auradent/agent-core';
import {
  redactTranscriptPII,
  type ClientSocketMessage,
  type RealtimeEvent,
  type SessionClosePayload,
} from '@auradent/shared';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

type SocketMessage = string | Buffer | ArrayBuffer | Buffer[];

type GatewaySessionState = {
  audioInterval?: NodeJS.Timeout;
  deepgramSocket?: WebSocket;
  deepgramKeepAlive?: NodeJS.Timeout;
  completedExtractionSequence: number;
  extractionChain: Promise<void>;
  extractionSequence: number;
  isStopping: boolean;
  lastAudioAt?: number;
  pendingExtractions: Set<Promise<void>>;
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
      completedExtractionSequence: 0,
      transcriptCounter: 0,
      demoTimers: [],
      extractionChain: Promise.resolve(),
      extractionSequence: 0,
      isStopping: false,
      finalizedUtterances: [],
      traceEvents: [],
      metrics: [],
      findings: [],
      pendingExtractions: new Set(),
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
              sessionId,
              state,
            });
            return;
          }

          startDemoSession({ request, send, sendTrace, state, sessionId });
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
            sessionId,
          });
          send({
            type: 'session.closed',
            sessionId,
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
  state,
}: {
  request: FastifyRequest;
  send: (event: RealtimeEvent) => void;
  sendTrace: (step: string, detail: string, confidence?: number) => void;
  state: GatewaySessionState;
  sessionId: string;
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
            sessionId: 'demo-session',
            transcript: transcriptWindow,
            currentUtteranceText: item.final,
            utteranceId: item.utteranceId,
          }).catch((error) => {
            request.log.error({ error }, 'Failed to emit structured demo findings');
            sendTrace('agent.error', 'Clinical agent failed during demo extraction.', 0.3);
          }));

          send({
            type: 'metric',
            name: 'transcription',
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
  state.lastAudioAt = Date.now();

  deepgramSocket.on('open', () => {
    sendTrace('deepgram.connected', 'Deepgram live transcription websocket opened.', 0.99);
    send({
      type: 'metric',
      name: 'ttft',
      value: Date.now() - openedAt,
      unit: 'ms',
      ts: new Date().toISOString(),
    });

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
    const finalRedaction = parsed.is_final ? redactTranscriptPII(transcript) : null;

    send(
      parsed.is_final
        ? {
            type: 'transcript.final',
            utteranceId,
            text: transcript,
            redactedText: finalRedaction && finalRedaction.matches.length > 0 ? finalRedaction.text : undefined,
            ts,
          }
        : { type: 'transcript.partial', utteranceId, text: transcript, ts },
    );

    if (parsed.is_final) {
      recordFinalUtterance(state, utteranceId, transcript);
      sendTrace('transcript.finalized', `Deepgram finalized utterance ${utteranceId}.`, confidence);
    }

    if (parsed.is_final) {
      const transcriptWindow = getTranscriptWindow(state, utteranceId);
      queueExtraction(state, () => emitStructuredFindings({
        send,
        sendTrace,
        sessionId,
        transcript: transcriptWindow,
        currentUtteranceText: transcript,
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
    sendTrace('deepgram.closed', 'Deepgram live transcription websocket closed.', 0.92);
    clearInterval(state.deepgramKeepAlive);
    state.deepgramKeepAlive = undefined;
    state.deepgramSocket = undefined;
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
  state.extractionChain = Promise.resolve();
  state.extractionSequence = 0;
  state.isStopping = false;
  state.pendingExtractions = new Set();
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

function hasClinicalSignal(transcript: string) {
  const normalized = transcript.toLowerCase();

  return (
    /\b\d+\s*(?:millimeter|mm)\b/.test(normalized) ||
    normalized.includes('pocket') ||
    normalized.includes('probing') ||
    normalized.includes('bleeding') ||
    normalized.includes('recession') ||
    normalized.includes('mobility') ||
    normalized.includes('furcation')
  );
}

function isReadyForStructuredExtraction(transcript: string) {
  const normalized = transcript.toLowerCase();
  if (!hasClinicalSignal(normalized)) {
    return false;
  }

  return hasExplicitToothReference(normalized);
}

function hasExplicitToothReference(transcript: string) {
  if (/\btooth\s+#?\d{1,2}\b/.test(transcript) || /#\d{1,2}\b/.test(transcript)) {
    return true;
  }

  return /\btooth\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|twenty[- ]one|twenty[- ]two|twenty[- ]three|twenty[- ]four|twenty[- ]five|twenty[- ]six|twenty[- ]seven|twenty[- ]eight|twenty[- ]nine|thirty|thirty[- ]one|thirty[- ]two)\b/.test(
    transcript,
  );
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
  const payload: SessionClosePayload = {
    sessionId,
    patientId: 'demo-patient',
    closedAt: new Date().toISOString(),
    transcript: {
      finalText: state.finalizedUtterances.map((entry) => entry.redactedText ?? entry.text).join(' '),
    },
    structuredFindings: state.findings,
    artifacts: {
      trace: state.traceEvents,
      metrics: state.metrics,
    },
  };

  await writeSessionClosePayloadToDisk(payload);
  const publisher = createSessionClosePublisher();
  try {
    await publisher.publish(payload);
    sendTrace('session.wrapup.enqueued', 'Session close payload published for async processing.', 0.97);
  } catch (error) {
    request.log.error({ error }, 'Failed to publish session close payload');
    sendTrace('session.wrapup.error', 'Failed to publish session close payload for async processing.', 0.3);
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

async function writeSessionClosePayloadToDisk(payload: SessionClosePayload) {
  const directory =
    process.env.AURADENT_SESSION_CLOSE_OUTPUT_DIR ??
    path.resolve(__dirname, '../../../tmp/session-close');

  await mkdir(directory, { recursive: true });

  const contents = `${JSON.stringify(payload, null, 2)}\n`;
  const latestPath = path.join(directory, 'latest-session-close.json');
  const sessionPath = path.join(directory, `${payload.sessionId}.json`);

  await Promise.all([
    writeFile(latestPath, contents, 'utf8'),
    writeFile(sessionPath, contents, 'utf8'),
  ]);
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
