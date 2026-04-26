import { createHash } from 'node:crypto';
import type { AgentExtraction, SessionClosePayload } from '@auradent/shared';

export type NormalizedPerioRecord = {
  sessionId: string;
  patientId: string;
  toothNumber: number;
  probingDepthMm: number | null;
  bleedingOnProbing: boolean;
  sourceUtteranceId: string;
  confidence: number;
  provenance: {
    dedupeKey: string;
    duplicateCount: number;
    mergedSourceUtteranceIds: string[];
    resolution: 'highest-confidence-then-latest';
  };
};

export function normalizeExtraction(extraction: AgentExtraction): NormalizedPerioRecord[] {
  const candidates = extraction.findings.map((finding) => ({
    sessionId: extraction.sessionId,
    patientId: extraction.patientId,
    toothNumber: finding.toothNumber,
    probingDepthMm: finding.probingDepthMm ?? null,
    bleedingOnProbing: finding.bleedingOnProbing ?? false,
    sourceUtteranceId: finding.sourceUtteranceId,
    confidence: finding.confidence,
  }));

  return dedupeNormalizedFindings(candidates);
}

export type PostOpInstructionArtifact = {
  fileName: string;
  mimeType: 'application/pdf';
  byteLength: number;
  contentBase64: string;
  previewText: string;
  sha256Digest: string;
};

export type MockInsurancePreAuthResult = {
  requestId: string;
  status: 'approved' | 'pending_review';
  payerName: string;
  procedureCodes: string[];
  referenceNumber: string;
  submittedAt: string;
  rationale: string;
};

export type PersistableSessionRecord = {
  sessionId: string;
  patientId: string;
  closedAt: string;
  transcript: {
    finalText: string;
  };
  normalizedFindings: NormalizedPerioRecord[];
  postOpInstruction: {
    fileName: string;
    mimeType: 'application/pdf';
    byteLength: number;
    previewText: string;
    sha256Digest: string;
    storage?: {
      persistedAt: string;
      storageKind: 'filesystem';
      outputPath: string;
    };
  };
  insurancePreAuthorization: MockInsurancePreAuthResult;
  observability: {
    sourceArtifacts: SessionClosePayload['artifacts'];
    processing?: {
      processedAt: string;
      processingDurationMs: number;
      runtime: 'local' | 'lambda';
      persistenceMode: 'postgres' | 'local-file';
      sourceMessageId?: string;
      approximateReceiveCount?: number;
      traceEventCount: number;
      metricCount: number;
      payloadSha256: string;
      recordSha256: string;
    };
  };
};

export function generatePostOpInstructionArtifact(
  payload: SessionClosePayload,
  normalizedFindings: NormalizedPerioRecord[],
): PostOpInstructionArtifact {
  const previewLines = [
    'AuraDent Post-Op Instructions',
    `Patient: ${payload.patientId}`,
    `Session: ${payload.sessionId}`,
    normalizedFindings.length > 0
      ? `Findings: ${normalizedFindings
          .map((finding) => `Tooth ${finding.toothNumber}${finding.probingDepthMm ? ` ${finding.probingDepthMm}mm` : ''}`)
          .join(', ')}`
      : 'Findings: No structured periodontal findings recorded.',
    'Instructions: Maintain gentle oral hygiene, follow clinician recommendations, and contact the practice for unusual bleeding or pain.',
  ];
  const previewText = previewLines.join('\n');
  const pdfBuffer = createStubPdfBuffer(previewText);

  return {
    fileName: `post-op-${payload.sessionId}.pdf`,
    mimeType: 'application/pdf',
    byteLength: pdfBuffer.byteLength,
    contentBase64: pdfBuffer.toString('base64'),
    previewText,
    sha256Digest: createSha256Digest(pdfBuffer),
  };
}

export function simulateInsurancePreAuthorization(
  payload: SessionClosePayload,
  normalizedFindings: NormalizedPerioRecord[],
): MockInsurancePreAuthResult {
  const requiresReview = normalizedFindings.some((finding) => (finding.probingDepthMm ?? 0) >= 5);
  const procedureCodes = normalizedFindings.length > 0 ? ['D0180', 'D4341'] : ['D0120'];

  return {
    requestId: `preauth-${payload.sessionId}`,
    status: requiresReview ? 'pending_review' : 'approved',
    payerName: 'Mock Dental Mutual',
    procedureCodes,
    referenceNumber: `MDM-${payload.sessionId.slice(-6).toUpperCase()}`,
    submittedAt: new Date().toISOString(),
    rationale: requiresReview
      ? 'Pocket depths include a higher-acuity finding and require payer review.'
      : 'Routine periodontal findings matched an auto-approvable mock ruleset.',
  };
}

export function buildPersistableSessionRecord(args: {
  payload: SessionClosePayload;
  normalizedFindings: NormalizedPerioRecord[];
  postOpInstruction: PostOpInstructionArtifact;
  persistedPostOpInstruction?: {
    persistedAt: string;
    storageKind: 'filesystem';
    outputPath: string;
  };
  insurancePreAuthorization: MockInsurancePreAuthResult;
}): PersistableSessionRecord {
  const { payload, normalizedFindings, postOpInstruction, insurancePreAuthorization, persistedPostOpInstruction } = args;

  return {
    sessionId: payload.sessionId,
    patientId: payload.patientId,
    closedAt: payload.closedAt,
    transcript: payload.transcript,
    normalizedFindings,
    postOpInstruction: {
      fileName: postOpInstruction.fileName,
      mimeType: postOpInstruction.mimeType,
      byteLength: postOpInstruction.byteLength,
      previewText: postOpInstruction.previewText,
      sha256Digest: postOpInstruction.sha256Digest,
      storage: persistedPostOpInstruction,
    },
    insurancePreAuthorization,
    observability: {
      sourceArtifacts: payload.artifacts,
    },
  };
}

function createStubPdfBuffer(text: string) {
  const wrappedLines = wrapTextForPdf(text, 64).slice(0, 12);
  const contentStream = [
    'BT',
    '/F1 12 Tf',
    '72 720 Td',
    '16 TL',
    ...wrappedLines.flatMap((line, index) =>
      index === 0 ? [`(${escapePdfText(line)}) Tj`] : ['T*', `(${escapePdfText(line)}) Tj`],
    ),
    'ET',
  ].join('\n');

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj',
    `4 0 obj\n<< /Length ${Buffer.byteLength(contentStream, 'utf8')} >>\nstream\n${contentStream}\nendstream\nendobj`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj',
  ];

  const chunks = ['%PDF-1.4'];
  const offsets = [0];

  for (const object of objects) {
    offsets.push(Buffer.byteLength(chunks.join('\n'), 'utf8') + 1);
    chunks.push(object);
  }

  const xrefOffset = Buffer.byteLength(chunks.join('\n') + '\n', 'utf8');
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Root 1 0 R /Size ${objects.length + 1} >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
  ].join('\n');

  return Buffer.from(`${chunks.join('\n')}\n${xref}`, 'utf8');
}

function createSha256Digest(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function wrapTextForPdf(text: string, maxLineLength: number) {
  const paragraphs = text.split('\n');
  const wrapped: string[] = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      wrapped.push('');
      continue;
    }

    let currentLine = '';
    for (const word of words) {
      const nextLine = currentLine ? `${currentLine} ${word}` : word;
      if (nextLine.length <= maxLineLength) {
        currentLine = nextLine;
        continue;
      }

      if (currentLine) {
        wrapped.push(currentLine);
      }
      currentLine = word;
    }

    if (currentLine) {
      wrapped.push(currentLine);
    }
  }

  return wrapped;
}

function escapePdfText(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function dedupeNormalizedFindings(
  findings: Array<Omit<NormalizedPerioRecord, 'provenance'>>,
): NormalizedPerioRecord[] {
  const grouped = new Map<string, Array<Omit<NormalizedPerioRecord, 'provenance'>>>();

  for (const finding of findings) {
    const key = `tooth-${finding.toothNumber}`;
    grouped.set(key, [...(grouped.get(key) ?? []), finding]);
  }

  return Array.from(grouped.entries())
    .map(([dedupeKey, group]) => {
      const winner = group.reduce(selectPreferredFinding);
      const mergedSourceUtteranceIds = Array.from(
        new Set(group.map((finding) => finding.sourceUtteranceId)),
      ).sort(compareUtteranceIds);

      return {
        ...winner,
        bleedingOnProbing: group.some((finding) => finding.bleedingOnProbing),
        provenance: {
          dedupeKey,
          duplicateCount: Math.max(0, group.length - 1),
          mergedSourceUtteranceIds,
          resolution: 'highest-confidence-then-latest' as const,
        },
      };
    })
    .sort((left, right) => left.toothNumber - right.toothNumber);
}

function selectPreferredFinding(
  current: Omit<NormalizedPerioRecord, 'provenance'>,
  candidate: Omit<NormalizedPerioRecord, 'provenance'>,
) {
  if (candidate.confidence !== current.confidence) {
    return candidate.confidence > current.confidence ? candidate : current;
  }

  const utteranceComparison = compareUtteranceIds(candidate.sourceUtteranceId, current.sourceUtteranceId);
  if (utteranceComparison !== 0) {
    return utteranceComparison > 0 ? candidate : current;
  }

  const currentHasDepth = typeof current.probingDepthMm === 'number';
  const candidateHasDepth = typeof candidate.probingDepthMm === 'number';
  if (candidateHasDepth !== currentHasDepth) {
    return candidateHasDepth ? candidate : current;
  }

  return candidate;
}

function compareUtteranceIds(left: string, right: string) {
  return extractUtteranceRank(left) - extractUtteranceRank(right);
}

function extractUtteranceRank(utteranceId: string) {
  const match = utteranceId.match(/(\d+)(?!.*\d)/);
  return match ? Number(match[1]) : 0;
}
