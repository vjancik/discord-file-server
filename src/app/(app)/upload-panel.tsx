"use client";

import Uppy from "@uppy/core";
import Dashboard from "@uppy/react/dashboard";
import Tus from "@uppy/tus";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { isBlockedExtension } from "@/lib/blocked-extensions";

import "@uppy/core/css/style.min.css";
import "@uppy/dashboard/css/style.min.css";

interface CompletedUpload {
  fileName: string;
  shortUrl: string;
  canonicalUrl: string;
}

// The tus onUploadFinish hook returns our link JSON on the final PATCH;
// capture it per upload URL so `upload-success` can pick it up.
const finishBodies = new Map<string, CompletedUpload>();

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
    // Cap each PATCH below Cloudflare's ~100 MB request-body limit so large
    // uploads survive tunneled deployments; direct deployments just see a
    // few more requests per multi-GB file.
    chunkSize: 90 * 1024 * 1024,
    async onAfterResponse(req, res) {
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
      const detail =
        typeof response?.body === "string" ? response.body : undefined;
      toast.error(detail || "Upload failed. Please try again.");
    };
    uppy.on("upload-success", onSuccess);
    uppy.on("upload-error", onError);
    return () => {
      uppy.off("upload-success", onSuccess);
      uppy.off("upload-error", onError);
    };
  }, [uppy]);

  return (
    <div className="flex flex-col gap-6">
      <Dashboard
        uppy={uppy}
        theme="auto"
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
