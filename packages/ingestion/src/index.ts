import type { AgentExtraction, SessionClosePayload } from '@auradent/shared';

export type NormalizedPerioRecord = {
  sessionId: string;
  patientId: string;
  toothNumber: number;
  probingDepthMm: number | null;
  bleedingOnProbing: boolean;
  sourceUtteranceId: string;
  confidence: number;
};

export function normalizeExtraction(extraction: AgentExtraction): NormalizedPerioRecord[] {
  return extraction.findings.map((finding) => ({
    sessionId: extraction.sessionId,
    patientId: extraction.patientId,
    toothNumber: finding.toothNumber,
    probingDepthMm: finding.probingDepthMm ?? null,
    bleedingOnProbing: finding.bleedingOnProbing ?? false,
    sourceUtteranceId: finding.sourceUtteranceId,
    confidence: finding.confidence,
  }));
}

export type PostOpInstructionArtifact = {
  fileName: string;
  mimeType: 'application/pdf';
  byteLength: number;
  contentBase64: string;
  previewText: string;
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
  };
  insurancePreAuthorization: MockInsurancePreAuthResult;
  observability: SessionClosePayload['artifacts'];
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
  insurancePreAuthorization: MockInsurancePreAuthResult;
}): PersistableSessionRecord {
  const { payload, normalizedFindings, postOpInstruction, insurancePreAuthorization } = args;

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
    },
    insurancePreAuthorization,
    observability: payload.artifacts,
  };
}

function createStubPdfBuffer(text: string) {
  const sanitizedText = text.replace(/[()\\]/g, '');
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 86 >>
stream
BT
/F1 12 Tf
72 720 Td
(${sanitizedText.slice(0, 240)}) Tj
ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000010 00000 n 
0000000063 00000 n 
0000000122 00000 n 
0000000248 00000 n 
0000000386 00000 n 
trailer
<< /Root 1 0 R /Size 6 >>
startxref
456
%%EOF`;

  return Buffer.from(pdf, 'utf8');
}
