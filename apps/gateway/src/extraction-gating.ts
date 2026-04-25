export function hasClinicalSignal(transcript: string) {
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

export function isReadyForStructuredExtraction(transcript: string) {
  const normalized = transcript.toLowerCase();
  if (!hasClinicalSignal(normalized)) {
    return false;
  }

  return hasExplicitToothReference(normalized);
}

export function hasExplicitToothReference(transcript: string) {
  if (/\btooth\s+#?\d{1,2}\b/.test(transcript) || /#\d{1,2}\b/.test(transcript)) {
    return true;
  }

  return /\btooth\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|twenty[- ]one|twenty[- ]two|twenty[- ]three|twenty[- ]four|twenty[- ]five|twenty[- ]six|twenty[- ]seven|twenty[- ]eight|twenty[- ]nine|thirty|thirty[- ]one|thirty[- ]two)\b/.test(
    transcript,
  );
}
