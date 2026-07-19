import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { TusUploadError, tusUpload, UploadCancelledError } from "./tus-client";

let tmp: string;
let filePath: string;
const CONTENT = "hello upload";

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "tus-client-test-"));
  filePath = path.join(tmp, "clip.mp4");
  writeFileSync(filePath, CONTENT);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

type Req = {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

/**
 * In-memory tus server double; `plan` scripts the POST responses. Plain
 * node:http because the happy-dom test preload patches the global Response
 * class that Bun.serve handlers would need.
 */
function fakeTusServer(plan: { post429s?: number } = {}) {
  const requests: Req[] = [];
  let post429s = plan.post429s ?? 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      if (req.method === "POST") {
        if (post429s > 0) {
          post429s--;
          res.writeHead(429).end("staging is full — retry shortly");
          return;
        }
        const port = (server.address() as AddressInfo).port;
        res
          .writeHead(201, {
            Location: `http://localhost:${port}/api/upload/u1`,
          })
          .end();
        return;
      }
      if (req.method === "PATCH") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            fileId: "f1",
            fileName: "clip.mp4",
            kind: "video",
            shortUrl: "https://files.test/s/abc",
            canonicalUrl: "https://files.test/f/f1/clip.mp4",
          }),
        );
        return;
      }
      res.writeHead(405).end("nope");
    });
  });
  server.listen(0);
  const port = (server.address() as AddressInfo).port;
  return {
    requests,
    endpoint: `http://localhost:${port}/api/upload`,
    stop: () => server.close(),
  };
}

describe("tusUpload", () => {
  test("creates, PATCHes the bytes, and returns the finalize result", async () => {
    const srv = fakeTusServer();
    try {
      const result = await tusUpload({
        endpoint: srv.endpoint,
        filePath,
        fileName: "clip.mp4",
        mimeType: "video/mp4",
        token: () => "tok-1",
      });
      expect(result.fileId).toBe("f1");
      expect(result.canonicalUrl).toContain("/f/f1/");

      const [post, patch] = srv.requests;
      expect(post.headers["upload-length"]).toBe(String(CONTENT.length));
      expect(post.headers["x-service-token"]).toBe("tok-1");
      expect(post.headers["upload-metadata"]).toContain(
        `filename ${Buffer.from("clip.mp4").toString("base64")}`,
      );
      expect(patch.headers["upload-offset"]).toBe("0");
      expect(patch.body).toBe(CONTENT);
    } finally {
      srv.stop();
    }
  });

  test("waits through 429s with fresh tokens and reports queueing", async () => {
    const srv = fakeTusServer({ post429s: 2 });
    const queued: string[] = [];
    let mints = 0;
    try {
      const result = await tusUpload({
        endpoint: srv.endpoint,
        filePath,
        fileName: "clip.mp4",
        mimeType: "video/mp4",
        token: () => `tok-${++mints}`,
        onQueued: (r) => queued.push(r),
        waitDelayMs: 10,
      });
      expect(result.fileId).toBe("f1");
      expect(queued).toHaveLength(2);
      expect(queued[0]).toContain("staging is full");
      // One token per POST attempt plus the PATCH — all distinct.
      expect(mints).toBe(4);
    } finally {
      srv.stop();
    }
  });

  test("gives up on the staging queue after maxWaitMs", async () => {
    const srv = fakeTusServer({ post429s: 100 });
    try {
      await expect(
        tusUpload({
          endpoint: srv.endpoint,
          filePath,
          fileName: "clip.mp4",
          mimeType: "video/mp4",
          token: () => "t",
          waitDelayMs: 5,
          maxWaitMs: 30,
        }),
      ).rejects.toThrow("Gave up waiting");
    } finally {
      srv.stop();
    }
  });

  test("non-429 create failure throws with the server's message", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(413).end("Upload exceeds your quota.");
    });
    server.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(
        tusUpload({
          endpoint: `http://localhost:${port}/api/upload`,
          filePath,
          fileName: "clip.mp4",
          mimeType: "video/mp4",
          token: () => "t",
        }),
      ).rejects.toThrow(TusUploadError);
    } finally {
      server.close();
    }
  });

  test("abort during the 429 wait cancels cleanly", async () => {
    const srv = fakeTusServer({ post429s: 100 });
    const controller = new AbortController();
    try {
      const pending = tusUpload({
        endpoint: srv.endpoint,
        filePath,
        fileName: "clip.mp4",
        mimeType: "video/mp4",
        token: () => "t",
        waitDelayMs: 5_000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 20);
      await expect(pending).rejects.toThrow(UploadCancelledError);
    } finally {
      srv.stop();
    }
  });
});
