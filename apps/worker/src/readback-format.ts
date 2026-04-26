import type { PersistableSessionRecord } from '@auradent/ingestion';

type MaybePersistedSessionRecord = Partial<PersistableSessionRecord> & {
  normalizedFindings?: PersistableSessionRecord['normalizedFindings'];
  observability?: Partial<PersistableSessionRecord['observability']>;
  postOpInstruction?: Partial<PersistableSessionRecord['postOpInstruction']>;
  transcript?: Partial<PersistableSessionRecord['transcript']>;
};

export type PersistedSessionRow = {
  session_id: string;
  patient_id: string;
  insurance_status: string;
  closed_at: string;
  record: MaybePersistedSessionRecord;
};

export type ReadbackSummary = {
  artifactOutputPath: string | null;
  dedupeDuplicateCount: number;
  dedupeResolution: string | null;
  sessionId: string;
  patientId: string;
  closedAt: string;
  insuranceStatus: string;
  findingsCount: number;
  mergedUtteranceProvenance: Array<{
    duplicateCount: number;
    mergedSourceUtteranceIds: string[];
    sourceUtteranceId: string;
    toothNumber: number;
  }>;
  traceEventCount: number;
  metricCount: number;
  processingDurationMs: number | null;
  processedAt: string | null;
  runtime: 'local' | 'lambda' | 'unknown';
  persistenceMode: 'postgres' | 'local-file' | 'unknown';
  postOpFile: string;
  transcriptPreview: string;
  payloadSha256: string | null;
  recordSha256: string | null;
};

export function buildReadbackResponse(rows: PersistedSessionRow[], includeRecords: boolean) {
  return {
    level: 'info' as const,
    message: 'Read AuraDent persisted session records',
    count: rows.length,
    summaries: rows.map(summarizePersistedSessionRow),
    records: includeRecords ? rows.map((row) => row.record) : undefined,
  };
}

export function summarizePersistedSessionRow(row: PersistedSessionRow): ReadbackSummary {
  const observability = row.record.observability;
  const processing = observability?.processing;
  const sourceArtifacts = observability?.sourceArtifacts;
  const normalizedFindings = Array.isArray(row.record.normalizedFindings) ? row.record.normalizedFindings : [];
  const traceArtifacts = Array.isArray(sourceArtifacts?.trace) ? sourceArtifacts.trace : [];
  const metricArtifacts = Array.isArray(sourceArtifacts?.metrics) ? sourceArtifacts.metrics : [];
  const transcriptPreview =
    typeof row.record.transcript?.finalText === 'string' ? row.record.transcript.finalText.slice(0, 160) : '';
  const postOpFile =
    typeof row.record.postOpInstruction?.fileName === 'string'
      ? row.record.postOpInstruction.fileName
      : 'unavailable';
  const mergedUtteranceProvenance = normalizedFindings
    .map((finding) => ({
      duplicateCount: finding.provenance?.duplicateCount ?? 0,
      mergedSourceUtteranceIds: finding.provenance?.mergedSourceUtteranceIds ?? [finding.sourceUtteranceId],
      sourceUtteranceId: finding.sourceUtteranceId,
      toothNumber: finding.toothNumber,
    }))
    .filter((finding) => finding.duplicateCount > 0);
  const dedupeDuplicateCount = normalizedFindings.reduce(
    (sum, finding) => sum + (finding.provenance?.duplicateCount ?? 0),
    0,
  );
  const dedupeResolution = normalizedFindings.find((finding) => finding.provenance?.resolution)?.provenance?.resolution ?? null;

  return {
    artifactOutputPath: typeof row.record.postOpInstruction?.storage?.outputPath === 'string'
      ? row.record.postOpInstruction.storage.outputPath
      : null,
    dedupeDuplicateCount,
    dedupeResolution,
    sessionId: row.session_id,
    patientId: row.patient_id,
    closedAt: row.closed_at,
    insuranceStatus: row.insurance_status,
    findingsCount: normalizedFindings.length,
    mergedUtteranceProvenance,
    traceEventCount: processing?.traceEventCount ?? traceArtifacts.length,
    metricCount: processing?.metricCount ?? metricArtifacts.length,
    processingDurationMs: processing?.processingDurationMs ?? null,
    processedAt: processing?.processedAt ?? null,
    runtime: processing?.runtime ?? 'unknown',
    persistenceMode: processing?.persistenceMode ?? 'unknown',
    postOpFile,
    transcriptPreview,
    payloadSha256: processing?.payloadSha256 ?? null,
    recordSha256: processing?.recordSha256 ?? null,
  };
}
