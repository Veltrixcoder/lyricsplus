import GoogleDrive from "../src/shared/utils/googleDrive.util.js";
import { GDRIVE } from "../src/shared/config.js";


const googleDrive = new GoogleDrive();
const CONCURRENCY_LIMIT = 100;
const PAGE_SIZE = 1000;

const RETRY_OPTIONS = {
  maxAttempts: 5,
  initialDelayMs: 1000,  // 1 s
  backoffFactor: 2,      // 1 s → 2 s → 4 s → 8 s → 16 s
  retryableStatuses: new Set([429, 500, 502, 503, 504]),
};

/**
 * Runs `fn` up to maxAttempts times, waiting with exponential back-off
 * whenever a retryable error is thrown.
 */
async function retryWithBackoff(fn, label = "") {
  const { maxAttempts, initialDelayMs, backoffFactor, retryableStatuses } = RETRY_OPTIONS;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status =
        err?.status ??
        err?.code ??
        Number(String(err?.message).match(/\b(4\d{2}|5\d{2})\b/)?.[0]);

      const isRetryable = retryableStatuses.has(status);
      const isLastAttempt = attempt === maxAttempts;

      if (!isRetryable || isLastAttempt) throw err;

      console.warn(
        `\n[retry] ${label} – attempt ${attempt}/${maxAttempts} failed (HTTP ${status || "?"}).` +
        ` Retrying in ${delay}ms...`
      );
      await new Promise((res) => setTimeout(res, delay));
      delay *= backoffFactor;
    }
  }
}

async function listAllFiles(folderId, cacheName) {
  const token = await googleDrive.authenticate();
  const query = `'${folderId}' in parents and trashed = false`;
  const fields = "nextPageToken,files(id,name)";

  const allFiles = [];
  let pageToken = null;

  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", query);
    url.searchParams.set("fields", fields);
    url.searchParams.set("pageSize", PAGE_SIZE);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "Drive API error");

    allFiles.push(...(data.files || []));
    pageToken = data.nextPageToken ?? null;
    process.stdout.write(`\r[${cacheName}] Indexed ${allFiles.length} files...`);
  } while (pageToken);

  process.stdout.write("\n");
  return allFiles;
}

async function deleteInBatches(files, cacheName, onProgress) {
  let deleted = 0;

  for (let i = 0; i < files.length; i += CONCURRENCY_LIMIT) {
    const batch = files.slice(i, i + CONCURRENCY_LIMIT);

    await Promise.all(
      batch.map((file) =>
        retryWithBackoff(
          () => googleDrive.deleteFile(file.id),
          `${cacheName} / "${file.name}" (${file.id})`
        )
          .then(() => onProgress(++deleted, files.length))
          .catch((err) =>
            console.error(
              `\n[${cacheName}] Failed to delete ${file.name} (${file.id}) after all retries:`,
              err
            )
          )
      )
    );
  }

  return deleted;
}

async function cleanCache(folderId, cacheName) {
  console.log(`[${cacheName}] Starting cleanup...`);

  const files = await listAllFiles(folderId, cacheName);

  if (files.length === 0) {
    console.log(`[${cacheName}] Already empty.`);
    return;
  }

  console.log(`[${cacheName}] Deleting ${files.length} files...`);

  const onProgress = (deleted, total) =>
    process.stdout.write(`\r[${cacheName}] ${deleted}/${total} deleted`);

  const totalDeleted = await deleteInBatches(files, cacheName, onProgress);
  process.stdout.write("\n");

  console.log(`[${cacheName}] Done. Deleted ${totalDeleted} items.`);
}

async function main() {
  console.log("Starting Google Drive cache cleanup...\n");

  const caches = [
    { folderId: GDRIVE.CACHED_SPOTIFY,    name: "Spotify"     },
    { folderId: GDRIVE.CACHED_TTML,       name: "Apple Music" },

    { folderId: GDRIVE.CACHED_QQ,         name: "QQ Music"    },
  ];

  for (const { folderId, name } of caches) {
    await cleanCache(folderId, name);
  }

  console.log("\nAll cache cleanup finished.");
}

main();
