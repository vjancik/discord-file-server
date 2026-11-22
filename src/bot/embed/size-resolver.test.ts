import { describe, expect, test } from "bun:test";
import type { ProbeFormat, ProbeInfo } from "./selection";
import {
  type FetchFn,
  HttpSizeResolver,
  needsLookup,
  sizeFromResponse,
} from "./size-resolver";

type Call = { url: string; method: string; headers: Record<string, string> };

/** Scripted fetch: per-URL handlers keyed by method ("HEAD" / "RANGE"). */
function fakeFetch(
  routes: Record<
    string,
    Partial<Record<"HEAD" | "RANGE", () => Response | Promise<Response>>>
  >,
) {
  const calls: Call[] = [];
  const fn: FetchFn = async (url, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const method = init.method ?? "GET";
    calls.push({ url, method, headers });
    const key = method === "HEAD" ? "HEAD" : "RANGE";
    const handler = routes[url]?.[key];
    if (!handler) return new Response(null, { status: 404 });
    return handler();
  };
  return { fn, calls };
}

const direct = (id: string, over: Partial<ProbeFormat> = {}): ProbeFormat => ({
  format_id: id,
  ext: "mp4",
  vcodec: "vp9",
  acodec: "none",
  height: 1920,
  protocol: "https",
  url: `https://cdn.test/${id}.mp4`,
  http_headers: { "User-Agent": "yt-dlp-ua" },
  ...over,
});

const info = (formats: ProbeFormat[]): ProbeInfo => ({ title: "t", formats });
const sizeOf = (i: ProbeInfo, id: string) =>
  i.formats?.find((f) => f.format_id === id)?.filesize;

describe("sizeFromResponse", () => {
  test("206 reads the total from Content-Range", () => {
    const res = new Response(null, {
      status: 206,
      headers: { "content-range": "bytes 0-0/68379325" },
    });
    expect(sizeFromResponse(res)).toBe(68379325);
  });

  test("206 with unknown total (*) is null", () => {
    const res = new Response(null, {
      status: 206,
      headers: { "content-range": "bytes 0-0/*" },
    });
    expect(sizeFromResponse(res)).toBeNull();
  });

  test("200 reads Content-Length unless content-encoded", () => {
    const plain = new Response(null, {
      status: 200,
      headers: { "content-length": "1498109" },
    });
    const gzipped = new Response(null, {
      status: 200,
      headers: { "content-length": "1000", "content-encoding": "gzip" },
    });
    expect(sizeFromResponse(plain)).toBe(1498109);
    expect(sizeFromResponse(gzipped)).toBeNull();
  });

  test("errors and garbage lengths are null", () => {
    const forbidden = new Response(null, {
      status: 403,
      headers: { "content-length": "5" },
    });
    const zero = new Response(null, {
      status: 200,
      headers: { "content-length": "0" },
    });
    expect(sizeFromResponse(forbidden)).toBeNull();
    expect(sizeFromResponse(zero)).toBeNull();
  });
});

describe("needsLookup", () => {
  test("only unsized, embed-relevant, direct http(s) formats", () => {
    expect(needsLookup(direct("ok"))).toBe(true);
    expect(needsLookup(direct("sized", { filesize: 5 }))).toBe(false);
    expect(needsLookup(direct("approx", { filesize_approx: 5 }))).toBe(false);
    expect(needsLookup(direct("hls", { protocol: "m3u8_native" }))).toBe(false);
    expect(needsLookup(direct("nourl", { url: null }))).toBe(false);
    expect(needsLookup(direct("flv", { ext: "flv" }))).toBe(false);
    expect(needsLookup(direct("file", { url: "file:///etc/passwd" }))).toBe(
      false,
    );
  });
});

describe("HttpSizeResolver", () => {
  test("HEAD Content-Length becomes an exact filesize, sending yt-dlp headers", async () => {
    const { fn, calls } = fakeFetch({
      "https://cdn.test/v.mp4": {
        HEAD: () =>
          new Response(null, {
            status: 200,
            headers: { "content-length": "68379325" },
          }),
      },
    });
    const out = await new HttpSizeResolver({ fetch: fn }).resolve(
      info([direct("v")]),
    );
    expect(sizeOf(out, "v")).toBe(68379325);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers["User-Agent"]).toBe("yt-dlp-ua");
  });

  test("falls back to a 1-byte ranged GET when HEAD gives no size", async () => {
    const { fn, calls } = fakeFetch({
      "https://cdn.test/v.mp4": {
        HEAD: () => new Response(null, { status: 405 }),
        RANGE: () =>
          new Response("x", {
            status: 206,
            headers: { "content-range": "bytes 0-0/44782450" },
          }),
      },
    });
    const out = await new HttpSizeResolver({ fetch: fn }).resolve(
      info([direct("v")]),
    );
    expect(sizeOf(out, "v")).toBe(44782450);
    expect(calls[1].headers.Range).toBe("bytes=0-0");
  });

  test("failures leave the format unsized and never throw", async () => {
    const { fn } = fakeFetch({
      "https://cdn.test/boom.mp4": {
        HEAD: () => {
          throw new TypeError("network down");
        },
        RANGE: () => {
          throw new TypeError("network down");
        },
      },
    });
    const input = info([direct("boom"), direct("missing")]);
    const out = await new HttpSizeResolver({ fetch: fn }).resolve(input);
    expect(sizeOf(out, "boom")).toBeUndefined();
    expect(sizeOf(out, "missing")).toBeUndefined();
    expect(out).toBe(input); // nothing resolved → same object back
  });

  test("skips formats that already have a size or no direct URL", async () => {
    const { fn, calls } = fakeFetch({});
    const input = info([
      direct("sized", { filesize: 10 }),
      direct("hls", { protocol: "m3u8_native" }),
    ]);
    const out = await new HttpSizeResolver({ fetch: fn }).resolve(input);
    expect(calls).toHaveLength(0);
    expect(out).toBe(input);
  });

  test("time budget caps slow lookups; fast ones still land", async () => {
    const hang = (signalled: AbortSignal) =>
      new Promise<Response>((_, reject) =>
        signalled.addEventListener("abort", () => reject(new Error("abort"))),
      );
    const fn: FetchFn = async (url, init) => {
      if (url.includes("slow")) return hang(init.signal as AbortSignal);
      return new Response(null, {
        status: 200,
        headers: { "content-length": "7" },
      });
    };
    const out = await new HttpSizeResolver({
      fetch: fn,
      timeoutMs: 30,
      concurrency: 2,
    }).resolve(info([direct("slow"), direct("fast")]));
    expect(sizeOf(out, "fast")).toBe(7);
    expect(sizeOf(out, "slow")).toBeUndefined();
  });

  test("respects maxLookups", async () => {
    const { fn, calls } = fakeFetch({});
    await new HttpSizeResolver({ fetch: fn, maxLookups: 2 }).resolve(
      info([direct("a"), direct("b"), direct("c")]),
    );
    const heads = calls.filter((c) => c.method === "HEAD");
    expect(heads.map((c) => c.url)).toEqual([
      "https://cdn.test/a.mp4",
      "https://cdn.test/b.mp4",
    ]);
  });
});
