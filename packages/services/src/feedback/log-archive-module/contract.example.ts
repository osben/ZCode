import { cleanupLogArchive, prepareCompactLogArchive } from "./contract.js";

/** Feedback upload prepares the compact archive, uploads it, then always removes it. */
export async function exampleCompactLogArchive(
  upload: (path: string) => Promise<void>,
): Promise<void> {
  const archive = await prepareCompactLogArchive();
  try {
    await upload(archive.path);
  } finally {
    await cleanupLogArchive(archive.path);
  }
}
