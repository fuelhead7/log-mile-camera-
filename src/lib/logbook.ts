import { Directory, File, Paths } from 'expo-file-system';
import type { Fix, Match } from './roadway';

export type PhotoTag = {
  route: string; direction: string; county: string; mile: string; notes: string;
  fix: Fix | null; estimate: Match | null; source: 'tdot' | 'manual' | 'unset';
};
export type Entry = PhotoTag & { id: string; createdAt: number; originalMime?: string };
const folder = () => new Directory(Paths.document, 'logmile-entries');
export function photoFile(id: string, originalMime?: string) {
  const extension = originalMime === 'image/png' ? 'png'
    : originalMime === 'image/webp' ? 'webp'
    : originalMime === 'image/heic' ? 'heic'
    : originalMime === 'image/heif' ? 'heif'
    : originalMime === 'image/gif' ? 'gif'
    : originalMime === 'image/jpeg' ? 'jpg' : 'bin';
  return new File(folder(), originalMime ? id + '-original.' + extension : id + '.jpg');
}

export async function listEntries() {
  const directory = folder();
  if (!directory.exists) return [];
  const entries = await Promise.all(directory.list().filter((file): file is File => file instanceof File && file.name.endsWith('.json')).map(async file => {
    try { return JSON.parse(await file.text()) as Entry; } catch { return null; }
  }));
  return entries.filter((entry): entry is Entry => entry !== null).sort((a, b) => b.createdAt - a.createdAt);
}

export function saveEntry(entry: Entry, original: string, stamped: string) {
  folder().create({ intermediates: true, idempotent: true });
  const originalFile = photoFile(entry.id, entry.originalMime ?? 'image/jpeg');
  const stampedFile = photoFile(entry.id);
  const pending = new File(folder(), `${entry.id}.tmp`);
  try {
    new File(original).copy(originalFile);
    new File(stamped).copy(stampedFile);
    pending.create();
    pending.write(JSON.stringify(entry));
    pending.move(new File(folder(), `${entry.id}.json`));
  } catch (error) {
    for (const file of [originalFile, stampedFile, pending]) {
      try { if (file.exists) file.delete(); } catch { /* Keep the original error. */ }
    }
    throw error;
  }
}
