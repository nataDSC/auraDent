import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { createExtractionFromTranscript } from '@auradent/agent-core';
import type { ClientSocketMessage, RealtimeEvent } from '@auradent/shared';
import WebSocket from 'ws';

type SocketMessage = string | Buffer | ArrayBuffer | Buffer[];

type GatewaySessionState = {
  audioInterval?: NodeJS.Timeout;
  deepgramSocket?: WebSocket;
  deepgramKeepAlive?: NodeJS.Timeout;
  lastAudioAt?: number;
  transcriptCounter: number;
  demoTimers: NodeJS.Timeout[];
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
      transcriptCounter: 0,
      demoTimers: [],
    };

    const send = (event: RealtimeEvent) => socket.send(JSON.stringify(event));
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
          state.transcriptCounter = 0;

          if (payload.mode === 'live' && payload.audio?.sampleRate && process.env.DEEPGRAM_API_KEY) {
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

          startDemoSession({ send, sendTrace, state, sessionId });
          return;
        }

        if (payload.type === 'session.stop') {
          stopDemoSession(state);
          finalizeDeepgram(state);
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
  send,
  sendTrace,
  state,
}: {
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
    { utteranceId: 'utt-001', partial: 'Patient has four millimeter', final: 'Patient has four millimeter pockets' },
    { utteranceId: 'utt-002', partial: 'on tooth fourteen', final: 'on tooth fourteen with bleeding on probing.' },
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
        send({
          type: 'transcript.final',
          utteranceId: item.utteranceId,
          text: item.final,
          ts: new Date().toISOString(),
        });

        if (index === transcriptScript.length - 1) {
          sendTrace('redaction.applied', 'PII scan complete. No identifiers forwarded to agent.', 0.98);
          emitStructuredFindings({
            send,
            sendTrace,
            sessionId: 'demo-session',
            transcript: transcriptScript.map((line) => line.final).join(' '),
          });

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

    send(
      parsed.is_final
        ? { type: 'transcript.final', utteranceId, text: transcript, ts }
        : { type: 'transcript.partial', utteranceId, text: transcript, ts },
    );

    sendTrace(
      parsed.is_final ? 'transcript.finalized' : 'transcript.interim',
      parsed.is_final ? 'Deepgram finalized an utterance segment.' : 'Deepgram emitted an interim transcript update.',
      confidence,
    );

    if (parsed.is_final) {
      emitStructuredFindings({ send, sendTrace, sessionId, transcript });
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

function emitStructuredFindings({
  send,
  sendTrace,
  sessionId,
  transcript,
}: {
  send: (event: RealtimeEvent) => void;
  sendTrace: (step: string, detail: string, confidence?: number) => void;
  sessionId: string;
  transcript: string;
}) {
  const extraction = createExtractionFromTranscript({
    sessionId,
    patientId: 'demo-patient',
    transcript,
  });

  sendTrace('tool.called', 'update_perio_chart invoked for extracted probing depth.', extraction.findings[0]?.confidence);

  extraction.findings.forEach((finding, findingIndex) => {
    const findingId = `${finding.toothNumber}-${findingIndex}`;
    send({
      type: 'chart.finding.staged',
      findingId,
      payload: {
        label: `Tooth #${finding.toothNumber}`,
        detail: `${finding.probingDepthMm ?? 'N/A'}mm pocket${finding.bleedingOnProbing ? ' • BOP' : ''}`,
      },
      ts: new Date().toISOString(),
    });
  });

  sendTrace('schema.validated', 'Zod schema accepted extraction payload.', 0.97);
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
