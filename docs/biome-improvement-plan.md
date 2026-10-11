# Biome improvement plan

Written 2026-08-08 from job-hunt's Biome rollout. It assumes job-hunt's
`biome.json` is copied here as the base — that file documents its own settings,
so this one covers only **what differs for this project** and **what the rollout
cost us to learn**.

Baseline: `biome check .` currently reports **0 diagnostics**, and
`noNonNullAssertion` is **0** (this repo has no `noUncheckedIndexedAccess`, which
is what generated 285 of them in job-hunt). Everything below is opt-in scope
expansion, not cleanup.

## 1. Config deltas

- **`lineWidth`.** job-hunt uses 120; this repo leaves it unset (= 80) and is
  formatted to it. Copying the config as-is reformats the whole repo. Decide
  first, and land it as its own commit — `git blame` otherwise gets a bad day.
- **Delete `suspicious.noUnknownAtRules: "off"`.** Measured: forcing the rule on
  gives **0** diagnostics, because `css.parser.tailwindDirectives: true` already
  parses the Tailwind v4 at-rules. The override predates it and is now dead.
- **Keep `css.parser.tailwindDirectives`.** You already have it; job-hunt had to
  add it. Without it, `@apply`/`@utility` are *parse errors* and Biome silently
  skips the whole file — it reports the error but formats nothing.
- **Exclude `.claude/settings.local.json`.** Biome reads `.gitignore`,
  `.ignore` and `.git/info/exclude` — **not** the global
  `~/.config/git/ignore`, which is where that file is ignored. So Biome lints it
  and will fight Claude Code's 2-space writes on every run.
- Bump `@biomejs/biome` 2.5.5 → 2.5.7 to match the config's `$schema`.

## 2. Domains

Measured on this repo with `biome lint --max-diagnostics=none --only=<domain> .`:

| domain | hits | verdict |
|---|---|---|
| `test` | **310** | Adopt. 303 are `useConsistentTestIt` defaulting to `it()`; this repo is 300 `test(` / 0 `it(`. Set **both** `function: "test"` **and** `withinDescribe: "test"` — there are 69 `describe` blocks, and setting only `function` leaves every nested test flagged. That drops it to the 7 real `noConditionalExpect` hits. |
| `tailwind` | **29** | Adopt `useSortedClasses` with `functions: ["cn", "cva", "clsx", "twMerge"]` (45 `cn`, 2 `cva` here). Without `functions`, calls outside a `className` attribute are invisible to it. Fix is **unsafe** — apply with `--fix --unsafe` and re-run e2e. |
| `types` | **12** | **Worth measuring properly here, unlike job-hunt.** Our objection there was that Biome's inference doesn't model `noUncheckedIndexedAccess`, which made 9 of 25 `noUnnecessaryConditions` false positives — this repo doesn't set that flag, so the objection doesn't transfer. Note the 2 `useArraySortCompare`: bare `.sort()` is lexicographic, so `[3, 10]` sorts to `[10, 3]`. That was a real latent bug in job-hunt. |
| `drizzle` | **0** | Enable anyway — it's free and you're the only one of the two projects with an ORM, so nothing else is watching this. |
| `playwright` | **0** | Enable, scoped to `e2e/**`. Clean today; the rules catch flaky-wait patterns. In job-hunt, unscoped they misfired on non-test code (a `page.waitForTimeout` in a production driver, an unrelated local `describe()`). |
| `project` | **550** | Skip. 449 are `useImportExtensions`, which is wrong under Bun — extensionless imports resolve fine and are the house style. |
| `next` | **0** | Already set, and genuinely nothing to find — 0 even with every Next rule forced on. Keep as a guard. |
| `react` | **43** | Already set, but at `"recommended"`, which finds **0**. Raising it to `"all"` surfaces 43: `noJsxPropsBind` 20, `noLeakedRender` 9, `useComponentExportOnlyModules` 9, `useUniqueElementIds` 5. See §3 on why `"all"` is a separate lever from the nursery question. |

Not applicable: solid, svelte, vue, qwik, reactNative, turborepo.

## 3. Findings

- **Domains do not enable nursery rules on a stable build.** Verified on both
  `tailwind` and `playwright`: `"recommended"` and `"all"` each yield 0 hits,
  while naming the rule explicitly works. Every rule in §2 marked nursery —
  `useConsistentTestIt`, `useSortedClasses`, all 11 Playwright rules, most of
  `types` — must be listed one by one under `linter.rules.nursery`.
- **`"recommended"` vs `"all"` is a *different* lever, and it does work.** The
  point above is only about nursery. For non-nursery rules the level decides
  real coverage: measured here, `react: "recommended"` finds **0** and
  `react: "all"` finds **43** (job-hunt: 0 → 72, same four rules). So a domain
  set to `"recommended"` reading "clean" says little. Worth raising deliberately
  — `noLeakedRender` alone is the `{count && <X/>}` bug that renders a literal
  `0`, and `useUniqueElementIds` catches duplicate DOM ids. `noJsxPropsBind` is
  the bulk of it and is the most arguable, especially with the React Compiler
  already in your build.
- **`useExhaustiveDependencies`' autofix silently drops trigger dependencies.**
  The highest-risk item here, given React + Next. It removed `[query]` and
  `[text]` from two effects whose bodies only touch a ref: one stopped a list
  resetting on filter change (caught by e2e), the other stopped a renamed item
  being re-measured (**no test caught it**). After any `--fix --unsafe`, grep the
  diff for `}, [` before trusting it.
- **`noNonNullAssertion`'s unsafe fix failed ~15% of the time** in job-hunt —
  164 autofixes produced 25 typecheck errors, all where `!` was load-bearing
  (`arr[0]` after a length check, a SQL `RETURNING` row). Irrelevant here at 0
  hits, but relevant if `noUncheckedIndexedAccess` is ever turned on.
- **Suppression comments must be the *immediately* preceding comment.** A reason
  wrapped across several `//` lines is silently ignored and the rule still
  fires — keep the reason on the directive line and put prose in a block above.
  In JSX, `{/* biome-ignore */}` **cannot** precede the root element of a
  parenthesised `return` (it becomes two adjacent expressions); a `//` line
  comment there is valid and works.
- **`biome check --verbose --max-diagnostics=none`** prints the exact file list
  Biome will process — the only reliable way to audit `files.includes`.
- **Count diagnostics from header lines only.** Grepping rule names across the
  whole output inflates counts, because names repeat inside diagnostic bodies:
  `grep -cE '^\S+:[0-9]+:[0-9]+ (lint|assist)/'`.
- **Default `--max-diagnostics` is 20.** Any measurement that comes back as
  exactly 20 is truncated, not a result.

## 4. Order

1. Copy the config, settle `lineWidth`, land a **format-only** commit.
2. `biome check --fix` (safe fixes only) → run `bun test` and `test:e2e`.
3. Add the §2 rules, then apply `--fix --unsafe` **one rule at a time**, with a
   `tsc --noEmit` gate between each; revert any rule that fails the gate rather
   than patching up after it.
4. Hand-fix whatever has no autofix, suppressing with a stated reason only where
   the rule is provably wrong about this code.
