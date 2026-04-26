import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PostOpInstructionArtifact } from '@auradent/ingestion';
import type { SessionProcessingContext } from './process-session-close';

export type PersistedArtifactReference = {
  persistedAt: string;
  storageKind: 'filesystem';
  outputPath: string;
};

export async function persistPostOpInstructionArtifact(args: {
  artifact: PostOpInstructionArtifact;
  context: SessionProcessingContext;
}): Promise<PersistedArtifactReference> {
  const directory = resolveArtifactOutputDirectory(args.context);
  await mkdir(directory, { recursive: true });

  const outputPath = path.join(directory, args.artifact.fileName);
  await writeFile(outputPath, Buffer.from(args.artifact.contentBase64, 'base64'));

  return {
    persistedAt: new Date().toISOString(),
    storageKind: 'filesystem',
    outputPath,
  };
}

function resolveArtifactOutputDirectory(context: SessionProcessingContext) {
  if (process.env.AURADENT_ARTIFACT_OUTPUT_DIR) {
    return process.env.AURADENT_ARTIFACT_OUTPUT_DIR;
  }

  if (context.runtime === 'lambda' || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return '/tmp/auradent-post-op';
  }

  return path.resolve(process.cwd(), 'tmp/post-op-instructions');
}
