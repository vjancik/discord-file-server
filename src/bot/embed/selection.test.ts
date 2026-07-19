import { describe, expect, test } from "bun:test";
import {
  buildCandidates,
  fitsLimit,
  type ProbeInfo,
  planEmbed,
} from "./selection";

const MB = 1024 * 1024;

/** Shaped like real yt-dlp -J output (YouTube: DASH pairs + m4a audio). */
const youtubeLike = (over: Partial<ProbeInfo> = {}): ProbeInfo => ({
  title: "clip",
  duration: 60,
  formats: [
    {
      format_id: "140",
      ext: "m4a",
      vcodec: "none",
      acodec: "mp4a.40.2",
      filesize: 1 * MB,
    },
    {
      format_id: "251",
      ext: "webm",
      vcodec: "none",
      acodec: "opus",
      filesize: 1 * MB,
    },
    {
      format_id: "134",
      ext: "mp4",
      vcodec: "avc1",
      acodec: "none",
      height: 360,
      filesize: 40 * MB,
    },
    {
      format_id: "136",
      ext: "mp4",
      vcodec: "avc1",
      acodec: "none",
      height: 720,
      filesize: 300 * MB,
    },
    {
      format_id: "137",
      ext: "mp4",
      vcodec: "avc1",
      acodec: "none",
      height: 1080,
      filesize: 800 * MB,
    },
    {
      format_id: "248",
      ext: "webm",
      vcodec: "vp9",
      acodec: "none",
      height: 1080,
      filesize: 700 * MB,
    },
  ],
  ...over,
});

describe("buildCandidates", () => {
  test("pairs video-only with same-family audio, best quality first", () => {
    const [best] = buildCandidates(youtubeLike());
    expect(best.formatIds).toEqual(["137", "140"]);
    expect(best.mergeFormat).toBe("mp4");
    expect(best.height).toBe(1080);
    expect(best.estimate).toEqual({ confidence: "exact", bytes: 801 * MB });
  });

  test("webm video pairs with webm audio and merges as webm", () => {
    const candidates = buildCandidates(youtubeLike());
    const webm = candidates.find((c) => c.formatIds[0] === "248");
    expect(webm?.formatIds).toEqual(["248", "251"]);
    expect(webm?.mergeFormat).toBe("webm");
  });

  test("skips video with no same-family audio available", () => {
    const info = youtubeLike({
      formats: [
        {
          format_id: "140",
          ext: "m4a",
          vcodec: "none",
          acodec: "mp4a",
          filesize: MB,
        },
        {
          format_id: "248",
          ext: "webm",
          vcodec: "vp9",
          acodec: "none",
          height: 1080,
          filesize: 10 * MB,
        },
      ],
    });
    expect(buildCandidates(info)).toHaveLength(0);
  });

  test("complete progressive format with unreported codecs counts (Vimeo-style)", () => {
    const info: ProbeInfo = {
      duration: 62,
      formats: [
        { format_id: "http-720p", ext: "mp4", height: 720, filesize: 20 * MB },
      ],
    };
    const [c] = buildCandidates(info);
    expect(c.formatIds).toEqual(["http-720p"]);
    expect(c.mergeFormat).toBeNull();
    expect(c.estimate).toEqual({ confidence: "exact", bytes: 20 * MB });
  });

  test("prefers the sized sibling at equal height, tbr-only ranks as rough", () => {
    const info: ProbeInfo = {
      duration: 100,
      formats: [
        {
          format_id: "hls-720",
          ext: "mp4",
          vcodec: "avc1",
          acodec: "mp4a",
          height: 720,
          tbr: 2000,
          protocol: "m3u8_native",
        },
        { format_id: "http-720", ext: "mp4", height: 720, filesize: 20 * MB },
      ],
    };
    const candidates = buildCandidates(info);
    expect(candidates[0].formatIds).toEqual(["http-720"]);
    // 2000 kbit/s × 100 s / 8 = 25 MB, labeled rough
    expect(candidates[1].estimate).toEqual({
      confidence: "rough",
      bytes: 25_000_000,
    });
    expect(candidates[1].label).toContain("(rough)");
  });

  test("excludes non-embeddable containers like mkv/flv", () => {
    const info: ProbeInfo = {
      duration: 10,
      formats: [{ format_id: "f1", ext: "flv", height: 480, filesize: MB }],
    };
    expect(buildCandidates(info)).toHaveLength(0);
  });
});

describe("fitsLimit margins", () => {
  test("exact estimates get 2%, others 5%", () => {
    expect(fitsLimit({ confidence: "exact", bytes: 490 * MB }, 500 * MB)).toBe(
      true,
    );
    expect(fitsLimit({ confidence: "exact", bytes: 495 * MB }, 500 * MB)).toBe(
      false,
    );
    expect(fitsLimit({ confidence: "approx", bytes: 475 * MB }, 500 * MB)).toBe(
      true,
    );
    expect(fitsLimit({ confidence: "approx", bytes: 480 * MB }, 500 * MB)).toBe(
      false,
    );
    expect(fitsLimit({ confidence: "unknown" }, 500 * MB)).toBe(false);
  });
});

describe("planEmbed", () => {
  const LIMIT = 500 * MB;

  test("rejects playlists and livestreams", () => {
    expect(planEmbed({ _type: "playlist", entries: [{}] }, LIMIT).kind).toBe(
      "reject",
    );
    expect(planEmbed(youtubeLike({ is_live: true }), LIMIT).kind).toBe(
      "reject",
    );
    expect(planEmbed({ formats: [] }, LIMIT).kind).toBe("reject");
  });

  test("fits: best quality under the limit proceeds", () => {
    const info = youtubeLike({
      formats: youtubeLike().formats?.filter(
        (f) => f.format_id !== "137" && f.format_id !== "248",
      ),
    });
    const plan = planEmbed(info, LIMIT);
    expect(plan.kind).toBe("fits");
    if (plan.kind !== "fits") throw new Error("expected fits");
    expect(plan.best.formatIds).toEqual(["136", "140"]);
  });

  test("choose: best over the limit offers the best fitting rung", () => {
    const plan = planEmbed(youtubeLike(), LIMIT);
    expect(plan.kind).toBe("choose");
    if (plan.kind !== "choose") throw new Error("expected choose");
    expect(plan.best.formatIds).toEqual(["137", "140"]);
    expect(plan.fit?.formatIds).toEqual(["136", "140"]);
    expect(plan.best.label).toBe("1080p · 840 MB");
  });

  test("choose with no fitting rung leaves fit undefined", () => {
    const info = youtubeLike({
      formats: [
        {
          format_id: "140",
          ext: "m4a",
          vcodec: "none",
          acodec: "mp4a",
          filesize: MB,
        },
        {
          format_id: "137",
          ext: "mp4",
          vcodec: "avc1",
          acodec: "none",
          height: 1080,
          filesize: 800 * MB,
        },
      ],
    });
    const plan = planEmbed(info, LIMIT);
    if (plan.kind !== "choose") throw new Error("expected choose");
    expect(plan.fit).toBeUndefined();
  });

  test("unknown: sizeless best (no duration for even a rough guess)", () => {
    const info: ProbeInfo = {
      formats: [
        {
          format_id: "hls-1",
          ext: "mp4",
          vcodec: "avc1",
          acodec: "mp4a",
          height: 720,
          tbr: 2000,
        },
      ],
    };
    const plan = planEmbed(info, 500 * MB);
    expect(plan.kind).toBe("unknown");
  });
});
