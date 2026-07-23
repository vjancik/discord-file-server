import { runTool } from "../run-tool";

/** Containers where a leading moov atom (faststart) matters for streaming. */
const FASTSTART_EXTS = new Set(["mp4", "m4v", "mov", "m4a"]);

/**
 * ffmpeg remux: streams are stream-copied (no transcode), the container is
 * rebuilt from scratch without tags — global metadata (GPS udta, creation
 * time, device tags) is dropped via `-map_metadata -1`, and `+bitexact` stops
 * the muxer from writing its own encoder/creation defaults back.
 *
 * Audio maps only audio streams, which also drops embedded cover art (an
 * attached-picture video stream that can itself carry EXIF). Video keeps
 * video/audio/subtitle streams and sheds data/attachment tracks (timecode,
 * fonts) — those are metadata-adjacent and break some remuxes anyway.
 * Rotation is safe: the display matrix is stream side data, not metadata.
 */
export async function stripAv(
  src: string,
  dest: string,
  kind: "video" | "audio",
  ext: string,
): Promise<void> {
  const maps =
    kind === "audio"
      ? ["-map", "0:a"]
      : ["-map", "0:v", "-map", "0:a?", "-map", "0:s?"];
  await runTool([
    "ffmpeg",
    "-v",
    "error",
    "-y",
    "-i",
    src,
    ...maps,
    "-map_metadata",
    "-1",
    "-c",
    "copy",
    "-fflags",
    "+bitexact",
    ...(FASTSTART_EXTS.has(ext) ? ["-movflags", "+faststart"] : []),
    dest,
  ]);
}
