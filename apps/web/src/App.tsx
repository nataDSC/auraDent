import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import type { ClientSocketMessage, RealtimeEvent } from '@auradent/shared';

type TranscriptLine = {
  utteranceId: string;
  text: string;
  final: boolean;
};

type FindingCard = {
  id: string;
  label: string;
  detail: string;
};

type RecordingState = 'idle' | 'requesting' | 'recording' | 'demo';

type SocketStatus = 'connecting' | 'connected' | 'disconnected';

const gatewayUrl = import.meta.env.VITE_GATEWAY_URL ?? 'ws://localhost:8787/realtime/session/demo-session';

export default function App() {
  const [socketStatus, setSocketStatus] = useState<SocketStatus>('connecting');
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [traceEvents, setTraceEvents] = useState<Array<{ detail: string; step: string; confidence?: number }>>([]);
  const [findings, setFindings] = useState<FindingCard[]>([]);
  const [audioLevel, setAudioLevel] = useState(0.08);
  const [metrics, setMetrics] = useState<Record<string, string>>({});
  const [micError, setMicError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);

  useEffect(() => {
    const socket = new WebSocket(gatewayUrl);
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;

    socket.addEventListener('open', () => {
      if (socketRef.current === socket) {
        setSocketStatus('connected');
      }
    });

    socket.addEventListener('close', () => {
      if (socketRef.current === socket) {
        setSocketStatus('disconnected');
        socketRef.current = null;
      }
    });

    socket.addEventListener('message', (message) => {
      const event = JSON.parse(message.data) as RealtimeEvent;

      switch (event.type) {
        case 'audio.level':
          setAudioLevel(event.level);
          break;
        case 'transcript.partial':
          setTranscript((current) => upsertTranscript(current, event.utteranceId, event.text, false));
          break;
        case 'transcript.final':
          setTranscript((current) =>
            upsertTranscript(current, event.utteranceId, event.redactedText ?? event.text, true),
          );
          break;
        case 'trace.event':
          setTraceEvents((current) =>
            appendTraceEvent(current, {
              detail: event.detail,
              step: event.step,
              confidence: event.confidence,
            }),
          );
          break;
        case 'chart.finding.staged':
        case 'chart.finding.committed':
          setFindings((current) => {
            const payload = event.payload as { label?: string; detail?: string };
            const card = {
              id: event.findingId,
              label: payload.label ?? 'Finding',
              detail: payload.detail ?? 'Awaiting detail',
            };
            return [...current.filter((item) => item.id !== card.id), card];
          });
          break;
        case 'metric':
          setMetrics((current) => ({
            ...current,
            [event.name]: `${event.value}${event.unit}`,
          }));
          break;
        default:
          break;
      }
    });

    return () => {
      stopStreaming();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      socket.close();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    let frame = 0;
    let animation = 0;

    const render = () => {
      frame += 1;
      const width = canvas.width = canvas.clientWidth;
      const height = canvas.height = canvas.clientHeight;
      context.clearRect(0, 0, width, height);

      const lines = 56;
      for (let i = 0; i < lines; i += 1) {
        const x = (width / lines) * i;
        const pulse = Math.sin(frame * 0.06 + i * 0.35) * 0.5 + 0.5;
        const amplitude = 10 + pulse * 28 + audioLevel * 80;
        const top = height / 2 - amplitude / 2;
        context.strokeStyle = i % 6 === 0 ? 'rgba(132, 222, 255, 0.95)' : 'rgba(78, 120, 149, 0.62)';
        context.lineWidth = i % 5 === 0 ? 3 : 2;
        context.beginPath();
        context.moveTo(x, top);
        context.lineTo(x, top + amplitude);
        context.stroke();
      }

      animation = requestAnimationFrame(render);
    };

    animation = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animation);
  }, [audioLevel]);

  async function startMicrophoneStreaming() {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      setMicError('Gateway is not connected yet.');
      return;
    }

    setMicError(null);
    setRecordingState('requesting');
    resetSessionView();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const audioContext = new AudioContext();
      const sourceNode = audioContext.createMediaStreamSource(stream);
      const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;

      mediaStreamRef.current = stream;
      audioContextRef.current = audioContext;
      sourceNodeRef.current = sourceNode;
      processorRef.current = processorNode;
      silentGainRef.current = silentGain;

      sendClientMessage({
        type: 'session.start',
        mode: 'live',
        audio: {
          encoding: 'linear16',
          sampleRate: audioContext.sampleRate,
        },
      });

      sourceNode.connect(processorNode);
      processorNode.connect(silentGain);
      silentGain.connect(audioContext.destination);

      processorNode.onaudioprocess = (event) => {
        const floatSamples = event.inputBuffer.getChannelData(0);
        const level = computeAudioLevel(floatSamples);
        setAudioLevel(level);

        const pcmBuffer = floatTo16BitPCM(floatSamples);
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(pcmBuffer);
        }
      };

      setRecordingState('recording');
    } catch (error) {
      setMicError(error instanceof Error ? error.message : 'Microphone access failed.');
      setRecordingState('idle');
    }
  }

  function startDemoMode() {
    stopStreaming();
    resetSessionView();
    setMicError(null);
    setRecordingState('demo');
    sendClientMessage({ type: 'session.start', mode: 'demo' });
  }

  function stopStreaming() {
    processorRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    silentGainRef.current?.disconnect();
    audioContextRef.current?.close().catch(() => undefined);
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());

    processorRef.current = null;
    sourceNodeRef.current = null;
    silentGainRef.current = null;
    audioContextRef.current = null;
    mediaStreamRef.current = null;

    sendClientMessage({ type: 'session.stop' });
    setRecordingState('idle');
    setAudioLevel(0.08);
  }

  function sendClientMessage(message: ClientSocketMessage) {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(message));
    }
  }

  function resetSessionView() {
    setTranscript([]);
    setTraceEvents([]);
    setFindings([]);
    setMetrics({});
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">AuraDent</p>
          <h1>Ambient Clinical Terminal</h1>
        </div>
        <div className="topbar-actions">
          <div className={`status-pill status-${socketStatus}`}>
            <span className="status-dot" />
            {socketStatus}
          </div>
          <div className="control-row">
            <button
              className="action-button primary"
              onClick={() => void startMicrophoneStreaming()}
              disabled={socketStatus !== 'connected' || recordingState === 'requesting' || recordingState === 'recording'}
            >
              {recordingState === 'requesting' ? 'Requesting Mic…' : recordingState === 'recording' ? 'Mic Live' : 'Start Mic'}
            </button>
            <button className="action-button" onClick={startDemoMode} disabled={socketStatus !== 'connected'}>
              Run Demo
            </button>
            <button
              className="action-button"
              onClick={stopStreaming}
              disabled={recordingState === 'idle'}
            >
              Stop
            </button>
          </div>
        </div>
      </header>

      {micError ? <p className="error-banner">{micError}</p> : null}

      <main className="layout-grid">
        <section className="panel hero-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Live Session</p>
              <h2>Realtime Transcript</h2>
            </div>
            <div className="metric-strip">
              {Object.entries(metrics).map(([name, value]) => (
                <div key={name} className="metric-chip">
                  <span>{name}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
          </div>

          <canvas ref={canvasRef} className="waveform" />

          <div className="transcript-list">
            {transcript.map((line) => (
              <motion.div
                layout
                key={line.utteranceId}
                className={`transcript-line ${line.final ? 'final' : 'partial'}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <span className="utterance-label">{line.utteranceId}</span>
                <p>{line.text}</p>
              </motion.div>
            ))}
          </div>
        </section>

        <section className="panel chart-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Digital Chart</p>
              <h2>Structured Findings</h2>
            </div>
          </div>

          <div className="chart-grid">
            {findings.map((finding) => (
              <motion.article
                layout
                key={finding.id}
                className="finding-card"
                initial={{ opacity: 0, scale: 0.96, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
              >
                <p>{finding.label}</p>
                <strong>{finding.detail}</strong>
              </motion.article>
            ))}
          </div>
        </section>

        <aside className="panel trace-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Trace View</p>
              <h2>Agent Activity</h2>
            </div>
          </div>

          <div className="trace-list">
            {traceEvents.map((event, index) => (
              <motion.div
                layout
                key={`${event.step}-${index}`}
                className="trace-item"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
              >
                <div className="trace-step-row">
                  <strong>{event.step}</strong>
                  {typeof event.confidence === 'number' ? <span>{Math.round(event.confidence * 100)}%</span> : null}
                </div>
                <p>{event.detail}</p>
              </motion.div>
            ))}
          </div>
        </aside>
      </main>
    </div>
  );
}

function upsertTranscript(current: TranscriptLine[], utteranceId: string, text: string, final: boolean) {
  const existing = current.find((line) => line.utteranceId === utteranceId);
  if (!existing) {
    return [...current, { utteranceId, text, final }];
  }

  return current.map((line) =>
    line.utteranceId === utteranceId ? { ...line, text, final: final || line.final } : line,
  );
}

function floatTo16BitPCM(floatSamples: Float32Array) {
  const buffer = new ArrayBuffer(floatSamples.length * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < floatSamples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, floatSamples[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return buffer;
}

function computeAudioLevel(floatSamples: Float32Array) {
  let sum = 0;

  for (let i = 0; i < floatSamples.length; i += 1) {
    sum += floatSamples[i] * floatSamples[i];
  }

  return Math.min(1, Math.sqrt(sum / floatSamples.length) * 6);
}

function appendTraceEvent(
  current: Array<{ detail: string; step: string; confidence?: number }>,
  next: { detail: string; step: string; confidence?: number },
) {
  const importantSteps = new Set([
    'redaction.applied',
    'tool.called',
    'schema.validated',
    'agent.noop',
    'deepgram.error',
    'deepgram.connected',
  ]);

  const maxItems = 16;
  const combined = [...current, next];
  if (combined.length <= maxItems) {
    return combined;
  }

  const firstRemovableIndex = combined.findIndex((event) => !importantSteps.has(event.step));
  if (firstRemovableIndex >= 0) {
    return combined.filter((_, index) => index !== firstRemovableIndex);
  }

  return combined.slice(-maxItems);
}
