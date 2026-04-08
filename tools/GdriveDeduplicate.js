import GoogleDrive from "../src/shared/utils/googleDrive.util.js";
import { GDRIVE } from "../src/shared/config.js";


const googleDrive = new GoogleDrive();
const CONCURRENCY_LIMIT = 1000;
const PAGE_SIZE = 1000;

const RETRY_OPTIONS = {
  maxAttempts: 5,
  initialDelayMs: 1000,  // 1 s
  backoffFactor: 2,      // 1 s → 2 s → 4 s → 8 s → 16 s
  retryableStatuses: new Set([429, 500, 502, 503, 504]),
};

/**
 * Runs `fn` up to maxAttempts times, waiting with exponential back-off
 * whenever a retryable error is thrown.  The thrown value must be (or wrap)
 * an object with a numeric `status` property, OR be an Error whose message
 * contains the HTTP status as a substring.
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

/**
 * Fetches ALL files in a folder by walking through every page.
 * The Drive API caps results at 100 per request and uses nextPageToken
 * to indicate more pages are available.
 */
async function listAllFiles(folderId, folderName) {
  const token = await googleDrive.authenticate();
  const query = `'${folderId}' in parents and trashed = false`;
  const fields = "nextPageToken,files(id,name,mimeType,createdTime,modifiedTime)";

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
    process.stdout.write(`\r[${folderName}] Indexed ${allFiles.length} files...`);
  } while (pageToken);

  process.stdout.write("\n");

  return allFiles;
}

/**
 * Groups files by name and returns only the duplicate entries,
 * keeping the newest file (by createdTime) and marking the rest for deletion.
 */
function findDuplicates(files) {
  const nameMap = new Map();

  for (const file of files) {
    if (!nameMap.has(file.name)) {
      nameMap.set(file.name, []);
    }
    nameMap.get(file.name).push(file);
  }

  const toDelete = [];

  for (const [, group] of nameMap) {
    if (group.length < 2) continue;

    group.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));

    const [_keep, ...duplicates] = group;
    toDelete.push(...duplicates);
  }

  return toDelete;
}

async function deleteInBatches(files, folderName, onProgress) {
  let deleted = 0;

  for (let i = 0; i < files.length; i += CONCURRENCY_LIMIT) {
    const batch = files.slice(i, i + CONCURRENCY_LIMIT);

    await Promise.all(
      batch.map((file) =>
        retryWithBackoff(
          () => googleDrive.deleteFile(file.id),
          `${folderName} / "${file.name}" (${file.id})`
        )
          .then(() => onProgress(++deleted, files.length))
          .catch((err) =>
            console.error(
              `\n[${folderName}] Failed to delete "${file.name}" (${file.id}) after all retries:`,
              err
            )
          )
      )
    );
  }

  return deleted;
}

async function deduplicateFolder(folderId, folderName) {
  console.log(`[${folderName}] Scanning for duplicates...`);

  const files = await listAllFiles(folderId, folderName);

  if (files.length === 0) {
    console.log(`[${folderName}] Folder is empty, skipping.`);
    return 0;
  }

  console.log(`[${folderName}] Fetched ${files.length} file(s) across all pages.`);

  const duplicates = findDuplicates(files);

  if (duplicates.length === 0) {
    console.log(`[${folderName}] No duplicates found.`);
    return 0;
  }

  console.log(
    `[${folderName}] Found ${duplicates.length} duplicate(s). Deleting oldest copies...`
  );

  const onProgress = (deleted, total) =>
    process.stdout.write(`\r[${folderName}] ${deleted}/${total} deleted`);

  const totalDeleted = await deleteInBatches(duplicates, folderName, onProgress);
  process.stdout.write("\n");

  console.log(`[${folderName}] Done. Removed ${totalDeleted} duplicate(s).`);
  return totalDeleted;
}

async function main() {
  console.log("Starting Google Drive deduplication...\n");

  const folders = [
    { folderId: GDRIVE.CACHED_SPOTIFY,    name: "Spotify"     },
    { folderId: GDRIVE.CACHED_TTML,       name: "Apple Music" },
    { folderId: GDRIVE.CACHED_MUSIXMATCH, name: "Musixmatch"  },
    { folderId: GDRIVE.CACHED_QQ,         name: "QQ Music"    },
  ];

  const results = [];
  for (const { folderId, name } of folders) {
    results.push(await deduplicateFolder(folderId, name));
  }

  const grandTotal = results.reduce((sum, n) => sum + n, 0);

  if (grandTotal === 0) {
    console.log("\nNo duplicates found anywhere. All folders are clean!");
  } else {
    console.log(`\nDeduplication complete. Total removed: ${grandTotal} file(s).`);
  }
}

main();