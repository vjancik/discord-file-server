"use client";

import Uppy from "@uppy/core";
import Dashboard from "@uppy/react/dashboard";
import Tus from "@uppy/tus";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { isBlockedExtension } from "@/lib/blocked-extensions";
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

export function UploadPanel({ remainingBytes }: { remainingBytes: number }) {
  const [uppy] = useState(createUppy);
  const [completed, setCompleted] = useState<CompletedUpload[]>([]);
  // Uppy's "auto" theme follows prefers-color-scheme, not our next-themes
  // class toggle — drive it explicitly. Before hydration resolvedTheme is
  // undefined; fall back to the app default (dark).
  const { resolvedTheme } = useTheme();
  const uppyTheme = resolvedTheme === "light" ? "light" : "dark";

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
    uppy.on("upload-success", onSuccess);
    uppy.on("upload-error", onError);
    uppy.on("file-removed", onRemoved);
    return () => {
      uppy.off("upload-success", onSuccess);
      uppy.off("upload-error", onError);
      uppy.off("file-removed", onRemoved);
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
