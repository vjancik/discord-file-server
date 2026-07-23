# Dependency regressions & version pins

Upstream regressions that force us off the latest version of a dependency.
Each entry records *why* the pin exists so a future bump (or dependabot PR)
doesn't silently reintroduce the break. Remove the pin once the upstream fix
lands and is verified.

## `radix-ui` pinned to exact `1.6.4` (no caret)

**Discovered:** 2026-07-23, while unblocking the dependabot minor-and-patch
group bump (`radix-ui ^1.6.1 → ^1.6.5`).

**Symptom:** `radix-ui@1.6.5` crashes any **server component** that transitively
imports a primitive at module-eval time. In our app the chain is
`src/app/(app)/layout.tsx` (async server component) →
`src/components/site-header.tsx` → `src/components/ui/button.tsx` (no
`"use client"`) → `import { Slot } from "radix-ui"`.

The failure:

```
TypeError: e.createContext is not a function. (In 'e.createContext(B)', 'e.createContext' is undefined)
    at module evaluation (src/components/ui/button.tsx:2:1)
    ...
Failed to collect page data for /admin/files
```

`Slot` calls `React.createContext` at module top-level, resolving against
Next's vendored RSC React build where `createContext` is `undefined` (it only
exists in the client React build). This is an upstream regression — a
`"use client"` boundary that 1.6.5 dropped from a primitive's build output.

**How it manifests:**
- `next build` — fails hard: "Failed to collect page data" (fast, deterministic).
- `next dev` / Playwright e2e — the dev webserver crashes on first render of an
  `(app)` route, so Playwright's `webServer` never comes up and the run **hangs
  forever** waiting for it. (This is what made the e2e job look like it stalled.)
- Unit tests, typecheck, and lint all **pass** — none of them evaluate the RSC
  server-component render path, so they don't catch it.

**Bisect result** (via `next build`, which fails fast instead of hanging):

| radix-ui | build |
|----------|-------|
| 1.6.1 (pre-bump) | ✓ |
| 1.6.4 | ✓ |
| 1.6.5 (dependabot) | ✗ `createContext is not a function` |

`react` (19.2.4 → 19.2.8) and `next` (16.2.10 → 16.2.11) were both ruled out:
the crash persisted with each of them bumped and only cleared when `radix-ui`
was moved off 1.6.5. (A transient `onCheckedChange` implicit-`any` type error
in 1.6.3 was a separate, self-resolving red herring — 1.6.4 and 1.6.5 both
typecheck clean.)

**The pin:** `"radix-ui": "1.6.4"` in `package.json` — **exact, not `^1.6.4`**.
A caret range would re-resolve to 1.6.5 and reintroduce the crash, which is
exactly how dependabot surfaced it.

**When to revisit:** try a newer `radix-ui` (> 1.6.5) once available; reproduce
with `rm -rf .next && bun --bun next build`. If it generates all pages without
the `createContext` error, restore the caret range (`^`) and delete this entry.
