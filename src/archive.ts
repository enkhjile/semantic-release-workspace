import { Parser } from 'tar';
import { releaseError } from './release-io.js';

// Inspect a regular member without extracting archive paths onto the filesystem.
export async function archiveFile(
  bytes: Buffer,
  path: string,
): Promise<string> {
  let found: string | undefined;
  const parser = new Parser({
    strict: true,
    onReadEntry(entry) {
      if (entry.path !== path) {
        entry.resume();
        return;
      }
      if (
        found !== undefined ||
        entry.type !== 'File' ||
        entry.size > 1024 * 1024
      )
        releaseError('Invalid package archive member.', 'EWORKSPACEARTIFACT');
      const chunks: Buffer[] = [];
      entry.on('data', (chunk: Buffer) => chunks.push(chunk));
      entry.on('end', () => {
        found = Buffer.concat(chunks).toString('utf8');
      });
    },
  });
  await new Promise<void>((resolve, reject) => {
    parser.on('error', reject);
    parser.on('end', resolve);
    parser.end(bytes);
  });
  if (found === undefined)
    return releaseError(
      'Package archive is missing its manifest.',
      'EWORKSPACEARTIFACT',
    );
  return found;
}
