"use client";

import Uppy from "@uppy/core";
import Dashboard from "@uppy/react/dashboard";
import Tus from "@uppy/tus";
import { TriangleAlert } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { extensionOf, isBlockedExtension } from "@/lib/blocked-extensions";
import {
  looksLikeText,
  shouldSniffForText,
  summarizeStripWarnings,
  TEXT_SNIFF_BYTES,
} from "@/lib/metadata-support";
import { formatSpeed, SpeedEstimator } from "@/lib/upload-speed";

// Order matters: the theme overrides must load after Uppy's own styles.
import "@uppy/core/css/style.min.css";
import "@uppy/dashboard/css/style.min.css";
import "./uppy-theme.css";

interface CompletedUpload {
  fileName: string;
  shortUrl: string;
  canonicalUrl: string;
}

// The tus onUploadFinish hook returns our link JSON on the final PATCH;
// capture it per upload URL so `upload-success` can pick it up.
const finishBodies = new Map<string, CompletedUpload>();

// Shown in the Dashboard while the final PATCH is in flight — i.e. after the
// last byte is uploaded but before the server answers. The server does its
// slow post-upload work (copy from SSD staging onto the HDD array, ffprobe,
// metadata strip) synchronously inside that response, so without this the file
// just sits at 100% with no explanation. See finalize.service.ts.
const PROCESSING_MESSAGE =
  "Finishing up — moving to storage & stripping metadata…";

// Server-side "wait for space" is a 429 on upload creation. @uppy/tus walks
// this array once per plugin instance across all 429 pauses (the iterator
// never resets), so its sum is the total wait-for-space budget (~10 min)
// before the upload fails with the server's reason. It also bounds retries
// for network/5xx errors, where the counter resets whenever bytes flow.
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, ...Array(38).fill(15_000)];

// Persistent "waiting for an upload slot" notice. One global toast, not one
// per file: a 429 pauses uppy's whole request queue, so waiting is global
// state. Re-showing with the same id just updates the existing toast; if a
// second queued file is still waiting after the first gets in, its next
// retry (≤ 15 s) brings the toast back.
const WAIT_TOAST_ID = "upload-slot-wait";

function showWaitToast() {
  toast.loading(
    "Waiting for an upload slot — the server is busy. Your upload will start automatically.",
    { id: WAIT_TOAST_ID, duration: Number.POSITIVE_INFINITY },
  );
}

// Uppy's status bar shows only "% · bytes of total · time left" — it computes
// a speed internally for the ETA but never displays it. The ETA text comes
// from the `xTimeLeft` locale string, so we prepend a live speed readout to it
// via the Dashboard's public setOptions API.
const DEFAULT_X_TIME_LEFT = "%{time} left";
const SPEED_REFRESH_MS = 500;

function createUppy() {
  return new Uppy({
    restrictions: { maxNumberOfFiles: 10 },
    onBeforeFileAdded: (file) => {
      if (isBlockedExtension(file.name ?? "")) {
        toast.error(`Executable files are not allowed: ${file.name}`);
        return false;
      }
      return true;
    },
  }).use(Tus, {
    endpoint: "/api/upload",
    removeFingerprintOnSuccess: true,
    retryDelays: RETRY_DELAYS_MS,
    // Cap each PATCH below Cloudflare's ~100 MB request-body limit so large
    // uploads survive tunneled deployments; direct deployments just see a
    // few more requests per multi-GB file.
    chunkSize: 90 * 1024 * 1024,
    async onAfterResponse(req, res) {
      // Waiting-for-space only ever happens on upload creation (POST): show
      // the persistent toast while 429s keep coming, clear it the moment a
      // creation resolves either way (a hard reject also fires upload-error,
      // which replaces it with the server's reason).
      if (req.getMethod() === "POST") {
        if (res.getStatus() === 429) {
          showWaitToast();
          return;
        }
        toast.dismiss(WAIT_TOAST_ID);
      }
      if (res.getStatus() === 200) {
        try {
          const body = JSON.parse(res.getBody()) as CompletedUpload & {
            fileId: string;
          };
          if (body.shortUrl) finishBodies.set(req.getURL(), body);
        } catch {
          // not the finish response — ignore
        }
      }
    },
  });
}

/**
 * Amber heads-up above the drop region: which of the selected files the
 * metadata-strip pipeline can't clean, and that archive contents are never
 * cleaned (zip containers are; the files inside are not).
 */
function MetadataStripNotice({
  fileNames,
  sniffedText,
}: {
  fileNames: string[];
  sniffedText: ReadonlySet<string>;
}) {
  const { unsupported, archives } = useMemo(
    () => summarizeStripWarnings(fileNames, sniffedText),
    [fileNames, sniffedText],
  );
  if (unsupported.length === 0 && archives.length === 0) return null;

  const withExt = (name: string) => {
    const ext = extensionOf(name);
    return ext ? `${name} (.${ext})` : name;
  };
  return (
    <div className="flex items-start gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-amber-700 text-sm dark:text-amber-300">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-col gap-1">
        {unsupported.length > 0 && (
          <p className="break-words">
            Metadata removal is probably not supported for:{" "}
            {unsupported.map(withExt).join(", ")}
          </p>
        )}
        {archives.length > 0 && (
          <p className="break-words">
            Files inside archives keep their metadata: {archives.join(", ")}
          </p>
        )}
      </div>
    </div>
  );
}

export function UploadPanel({ remainingBytes }: { remainingBytes: number }) {
  const [uppy] = useState(createUppy);
  const [completed, setCompleted] = useState<CompletedUpload[]>([]);
  const [fileNames, setFileNames] = useState<string[]>([]);
  // Names whose byte prefix sniffed as text: they suppress the "can't strip"
  // warning even though their extension is unrecognized. Populated async by
  // the sniff effect, so the bar may flash then clear a frame later.
  const [sniffedText, setSniffedText] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Uppy's "auto" theme follows prefers-color-scheme, not our next-themes
  // class toggle — drive it explicitly. Before hydration resolvedTheme is
  // undefined; fall back to the app default (dark).
  const { resolvedTheme } = useTheme();
  const uppyTheme = resolvedTheme === "light" ? "light" : "dark";

  // The tus uploader step holds the final PATCH open while the server copies
  // the file from SSD staging onto the HDD array and runs ffprobe / metadata
  // strip (all synchronous in that one response — see finalize.service.ts).
  // Without a signal the Dashboard just parks the file at 100%. We drive the
  // post-processing UI ourselves: the moment a file's bytes are fully sent,
  // flip it into an indeterminate "finishing up" state; clear it when the
  // final PATCH resolves (success) or the upload errors out.
  useEffect(() => {
    // Guard against re-emitting: upload-progress keeps firing at 100%, and we
    // want exactly one postprocess-progress per file.
    const processing = new Set<string>();

    const onProgress: Parameters<typeof uppy.on<"upload-progress">>[1] = (
      file,
      progress,
    ) => {
      if (!file || processing.has(file.id)) return;
      const { bytesUploaded, bytesTotal } = progress;
      if (!bytesTotal || bytesUploaded < bytesTotal) return;
      processing.add(file.id);
      uppy.emit("postprocess-progress", file, {
        mode: "indeterminate",
        message: PROCESSING_MESSAGE,
      });
    };
    // upload-success and upload-error have different signatures but agree on
    // the file as their first arg, which is all we need to clear the state.
    const clear = (file: { id: string } | undefined) => {
      if (!file || !processing.delete(file.id)) return;
      uppy.emit("postprocess-complete", uppy.getFile(file.id));
    };

    uppy.on("upload-progress", onProgress);
    uppy.on("upload-success", clear);
    uppy.on("upload-error", clear);
    return () => {
      uppy.off("upload-progress", onProgress);
      uppy.off("upload-success", clear);
      uppy.off("upload-error", clear);
    };
  }, [uppy]);

  useEffect(() => {
    const onSuccess: Parameters<typeof uppy.on<"upload-success">>[1] = (
      file,
      response,
    ) => {
      const body = response.uploadURL
        ? finishBodies.get(response.uploadURL)
        : undefined;
      if (body) {
        setCompleted((prev) => [body, ...prev]);
      } else if (file) {
        setCompleted((prev) => [
          { fileName: file.name ?? "file", shortUrl: "", canonicalUrl: "" },
          ...prev,
        ]);
      }
    };
    const onError: Parameters<typeof uppy.on<"upload-error">>[1] = (
      _file,
      _error,
      response,
    ) => {
      // The retry budget can exhaust while still waiting (last response was
      // a 429, so no successful POST ever dismissed the wait toast).
      toast.dismiss(WAIT_TOAST_ID);
      const detail =
        typeof response?.body === "string" ? response.body : undefined;
      toast.error(detail || "Upload failed. Please try again.");
    };
    // Cancelling the waiting file must clear the toast too — no further
    // creation response will ever arrive for it.
    const onRemoved = () => {
      if (uppy.getFiles().length === 0) toast.dismiss(WAIT_TOAST_ID);
    };
    // Selection tracking for the metadata warning bar.
    const syncNames = () =>
      setFileNames(uppy.getFiles().map((f) => f.name ?? ""));
    // Content-sniff files whose extension we don't recognize: if the first
    // few KB look like text, drop them from the warning. Reads a lazy Blob
    // slice, so only the prefix is pulled off disk, never the whole file.
    const sniffAdded: Parameters<typeof uppy.on<"files-added">>[1] = (
      files,
    ) => {
      for (const file of files) {
        const name = file.name ?? "";
        if (!name || !shouldSniffForText(name)) continue;
        const blob = file.data;
        if (!(blob instanceof Blob)) continue;
        blob
          .slice(0, TEXT_SNIFF_BYTES)
          .arrayBuffer()
          .then((buf) => {
            if (!looksLikeText(new Uint8Array(buf))) return;
            setSniffedText((prev) => {
              const next = new Set(prev);
              next.add(name);
              return next;
            });
          })
          .catch(() => {
            // Unreadable slice: leave the warning in place (fail toward
            // showing the heads-up rather than hiding it).
          });
      }
    };
    // Drop sniff results for files no longer selected so a re-added file with
    // the same name gets re-sniffed and the set doesn't grow unbounded.
    const pruneSniffed = () => {
      const present = new Set(uppy.getFiles().map((f) => f.name ?? ""));
      setSniffedText((prev) => {
        const next = new Set<string>();
        for (const name of prev) if (present.has(name)) next.add(name);
        return next.size === prev.size ? prev : next;
      });
    };
    uppy.on("upload-success", onSuccess);
    uppy.on("upload-error", onError);
    uppy.on("file-removed", onRemoved);
    uppy.on("files-added", syncNames);
    uppy.on("files-added", sniffAdded);
    uppy.on("file-removed", syncNames);
    uppy.on("file-removed", pruneSniffed);
    uppy.on("cancel-all", syncNames);
    uppy.on("cancel-all", pruneSniffed);
    return () => {
      uppy.off("upload-success", onSuccess);
      uppy.off("upload-error", onError);
      uppy.off("file-removed", onRemoved);
      uppy.off("files-added", syncNames);
      uppy.off("files-added", sniffAdded);
      uppy.off("file-removed", syncNames);
      uppy.off("file-removed", pruneSniffed);
      uppy.off("cancel-all", syncNames);
      uppy.off("cancel-all", pruneSniffed);
    };
  }, [uppy]);

  useEffect(() => {
    const estimator = new SpeedEstimator();
    let lastRefresh = 0;

    const setTimeLeftString = (xTimeLeft: string) => {
      uppy
        .getPlugin("Dashboard")
        ?.setOptions({ locale: { strings: { xTimeLeft } } });
    };

    const onProgress = () => {
      const totalUploaded = uppy
        .getFiles()
        .reduce((sum, file) => sum + (file.progress.bytesUploaded || 0), 0);
      const speed = estimator.sample(totalUploaded, Date.now());
      const now = Date.now();
      if (speed === null || speed <= 0 || now - lastRefresh < SPEED_REFRESH_MS)
        return;
      lastRefresh = now;
      setTimeLeftString(`${formatSpeed(speed)} · ${DEFAULT_X_TIME_LEFT}`);
    };
    // While paused no progress arrives, so a stale speed would sit in the
    // status bar; drop back to the plain ETA string and start a fresh average
    // on resume (the pause gap would otherwise read as a huge slowdown).
    const onIdle = () => {
      estimator.reset();
      setTimeLeftString(DEFAULT_X_TIME_LEFT);
    };

    uppy.on("upload-progress", onProgress);
    uppy.on("pause-all", onIdle);
    uppy.on("cancel-all", onIdle);
    uppy.on("complete", onIdle);
    uppy.on("error", onIdle);
    return () => {
      uppy.off("upload-progress", onProgress);
      uppy.off("pause-all", onIdle);
      uppy.off("cancel-all", onIdle);
      uppy.off("complete", onIdle);
      uppy.off("error", onIdle);
    };
  }, [uppy]);

  return (
    <div className="flex flex-col gap-6">
      <MetadataStripNotice fileNames={fileNames} sniffedText={sniffedText} />
      <Dashboard
        uppy={uppy}
        theme={uppyTheme}
        proudlyDisplayPoweredByUppy={false}
        note={`Anything but executables. Remaining quota: ${(remainingBytes / 1e9).toFixed(1)} GB`}
        height={330}
        width="100%"
      />
      {completed.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="font-medium text-lg">Share links</h2>
          {completed.map((item) => (
            <div
              key={item.shortUrl || item.fileName}
              className="flex items-center gap-3 rounded-md border px-4 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm">
                {item.fileName}
              </span>
              {item.shortUrl ? (
                <>
                  <code className="text-muted-foreground text-xs">
                    {item.shortUrl}
                  </code>
                  <CopyButton value={item.shortUrl} label="Copy link" />
                </>
              ) : (
                <span className="text-muted-foreground text-xs">uploaded</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
