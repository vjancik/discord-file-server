# Regenerating the demo reel

The animated demo in the README is built from ordered PNG screenshots in
`assets/screenshots/` (named `01.png`, `02.png`, … so they sort in sequence).
Two outputs are produced from the same frames:

- `assets/demo.gif` — maximum compatibility (npm, mirrors, all viewers), 256-color
- `assets/demo.webp` — best quality/size, GitHub-first; full color, no banding

Both are rendered at **1100px wide** (GitHub's README column is ~800–870px) with
each screenshot held for **2.5s** (`-framerate 1/2.5`).

## GIF

Uses a two-pass palette (`palettegen` → `paletteuse`) — a global 256-color palette
instead of ffmpeg's per-frame default, which is the biggest quality/size win for GIF.

```bash
cd assets/screenshots

# Pass 1 — build an optimized 256-color palette from all frames
ffmpeg -framerate 1/2.5 -pattern_type glob -i '*.png' \
  -vf "scale=1100:-2:flags=lanczos,palettegen=stats_mode=full" \
  -y /tmp/palette.png

# Pass 2 — render the GIF using that palette
ffmpeg -framerate 1/2.5 -pattern_type glob -i '*.png' -i /tmp/palette.png \
  -lavfi "scale=1100:-2:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3" \
  -y ../demo.gif
```

## WebP

```bash
cd assets/screenshots

ffmpeg -framerate 1/2.5 -pattern_type glob -i '*.png' \
  -vf "scale=1100:-2:flags=lanczos" \
  -loop 0 -c:v libwebp -lossless 0 -q:v 70 -y ../demo.webp
```

## Knobs

| Want | Change |
|---|---|
| Faster/slower pacing | `1/2.5` → `1/2` (2s) or `1/3` (3s) per frame |
| Smaller width / file | `scale=1100` → `scale=900` |
| Smoother gradients (GIF) | `dither=bayer:bayer_scale=3` → `dither=sierra2_4a` (larger file) |
| Higher WebP quality | raise `-q:v 70` toward `90` |
| Hold the last frame longer | duplicate the last PNG (e.g. `06.png` + `07.png`) |

Notes:

- `-2` (not `-1`) in `scale` forces an even height, which some GIF encoders require.
- `-pattern_type glob -i '*.png'` needs a real shell; if globbing misbehaves, name
  files `%02d.png` and use `-i %02d.png` instead.
