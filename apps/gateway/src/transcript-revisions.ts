export type TranscriptRevisionEntry = {
  finalText?: string;
  partialText?: string;
};

export type TranscriptRevisionStore = Map<string, TranscriptRevisionEntry>;

export type TranscriptRevisionResult = {
  didChange: boolean;
  nextStore: TranscriptRevisionStore;
  shouldEmit: boolean;
  shouldQueueExtraction: boolean;
  text: string;
  type: 'partial' | 'final';
  utteranceId: string;
};

export function reconcileTranscriptRevision(args: {
  isFinal: boolean;
  store: TranscriptRevisionStore;
  text: string;
  utteranceId: string;
}): TranscriptRevisionResult {
  const normalizedText = args.text.trim();
  const current = args.store.get(args.utteranceId) ?? {};
  const nextStore = new Map(args.store);

  if (!normalizedText) {
    return {
      didChange: false,
      nextStore,
      shouldEmit: false,
      shouldQueueExtraction: false,
      text: normalizedText,
      type: args.isFinal ? 'final' : 'partial',
      utteranceId: args.utteranceId,
    };
  }

  if (args.isFinal) {
    if (current.finalText === normalizedText) {
      return {
        didChange: false,
        nextStore,
        shouldEmit: false,
        shouldQueueExtraction: false,
        text: normalizedText,
        type: 'final',
        utteranceId: args.utteranceId,
      };
    }

    nextStore.set(args.utteranceId, {
      ...current,
      finalText: normalizedText,
      partialText: undefined,
    });

    return {
      didChange: true,
      nextStore,
      shouldEmit: true,
      shouldQueueExtraction: true,
      text: normalizedText,
      type: 'final',
      utteranceId: args.utteranceId,
    };
  }

  if (current.finalText) {
    return {
      didChange: false,
      nextStore,
      shouldEmit: false,
      shouldQueueExtraction: false,
      text: normalizedText,
      type: 'partial',
      utteranceId: args.utteranceId,
    };
  }

  if (current.partialText === normalizedText) {
    return {
      didChange: false,
      nextStore,
      shouldEmit: false,
      shouldQueueExtraction: false,
      text: normalizedText,
      type: 'partial',
      utteranceId: args.utteranceId,
    };
  }

  nextStore.set(args.utteranceId, {
    ...current,
    partialText: normalizedText,
  });

  return {
    didChange: true,
    nextStore,
    shouldEmit: true,
    shouldQueueExtraction: false,
    text: normalizedText,
    type: 'partial',
    utteranceId: args.utteranceId,
  };
}
