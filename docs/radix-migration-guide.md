# Radix → Base UI migration guide

Measured 2026-07-31. Not scheduled — this is the prep so the switch is a decision,
not an investigation.

## Where we are

`components.json` has `"style": "radix-nova"` and `"registries": {}`, so the
primitive library is named explicitly in `style` — this is a newer shadcn scaffold
than most. Dependency is `radix-ui` 1.6.4 (pinned), the unified single package.

Footprint: **14 components, 1138 lines**, all in `src/components/ui/`. Eleven import
`radix-ui`:

badge, button, checkbox, dialog, dropdown-menu, label, progress, select, separator,
switch, tooltip

`input.tsx`, `table.tsx` and `sonner.tsx` don't — the first two are plain markup,
sonner wraps an unrelated library, so all three migrate for free.

**Zero Radix imports outside `components/ui/`.** The copy-in model held — the
primitive is fully contained in a leaf directory.

## When to switch

There's no forcing function here today. Base UI's advantages over Radix are a richer
primitive set (Combobox with `multiple`, Autocomplete, NumberField, Meter, Toolbar)
and being the actively-developed successor by the Radix authors + MUI. Radix is
still shadcn's default and actively maintained, so there is no rot argument — switch
when you want a primitive Radix lacks, not on principle.

Good moment to do it: any time you're already touching the UI layer broadly. Bad
moment: alongside a feature, since it inflates the diff for no functional gain.

## What actually changes

shadcn's Base UI variant keeps the same exported names — `DropdownMenuContent`,
`DialogContent`, `SelectItem` all still exist. The primitive swap (Radix
`Content`/`Overlay` → Base UI `Popup`/`Positioner`/`Backdrop`) happens *inside* the
wrapper files, so consumers mostly don't notice.

One thing does leak into app code: **`asChild` becomes `render`.**

```diff
- <DialogTrigger asChild><Button variant="outline">Open</Button></DialogTrigger>
+ <DialogTrigger render={<Button variant="outline" />}>Open</DialogTrigger>
```

This is the bulk of the work here — **14 call sites** outside `components/ui/`
(23 total; the wrappers get replaced wholesale). They split into three kinds, and
the kind matters (see gotcha 2):

| kind | where | treatment |
|---|---|---|
| trigger wrapping a `Button` | `mobile-nav.tsx:34`, `preview-dialog.tsx:74,75,97`, `delete-file-button.tsx:59`, `download-file-button.tsx:18` | `render={<Button …/>}`, children move out |
| **`Button` wrapping a link** | `site-header.tsx:75` (`<Link>`), `download-file-button.tsx:19` (`<a>`), `watch-view.tsx:73,79` (`<a>`) | **drop the Button** — use `buttonVariants({…})` as the link's className |
| `DropdownMenuItem` wrapping `<Link>` | `mobile-nav.tsx:42,47,52,58` | `render={<Link …/>}` — `Menu.Item` renders a `<div>` and `role="menuitem"` on the anchor is correct here |

## Test exposure: low

`e2e/upload-flow.spec.ts` has one relevant assertion, `getByRole("dialog")` on the
delete-confirm path. Role-based, so it survives the swap — both libraries expose
`role="dialog"`. `e2e/admin.spec.ts` doesn't assert on menus at all.

The unit tests (`src/bot/*`, `src/lib/*`, `src/server/*`) don't touch the UI layer.
`src/components/copy-button.test.tsx` is the only component test — check whether it
renders a Radix-backed primitive before assuming it's safe.

## Steps

1. Point `components.json` at the Base UI style (the counterpart to `radix-nova`).
   Confirm the current naming with the CLI; don't hand-edit `style` on a guess.
2. Re-add the 11 Radix-backed components from the base registry. **Don't hand-port** —
   diff the new files against ours and re-apply only our deliberate deviations.
3. Fix the 14 `asChild` → `render` call sites.
4. Drop `radix-ui` from `package.json`, add `@base-ui/react`.
5. `bunx tsc --noEmit`, `bun test`, `bunx playwright test`.

## Verify

- Type-check clean (the `render` prop change is type-visible, so this catches most
  missed call sites)
- Manual pass over the four interactive surfaces: mobile nav, file dropdown menus,
  preview dialog, delete confirm
- Tooltip and switch need a real hover/keyboard check — neither has test coverage

## Gotchas — measured on job-hunt, which did this migration on 2026-07-31

The sibling project completed the same switch. Everything below actually bit,
in the order it surfaced. Its `docs/radix-migration-guide.md` has the long form.

**1. `asChild` left in place nests buttons.** Base UI composes by *merging into*
the `render` element, so a leftover `asChild` renders both and puts a `<button>`
inside a `<button>` — invalid HTML, React hydration error, and `asChild` itself
lands on the DOM node as an unknown attribute. This was the only failure that
announced itself.

**2. Never wrap a link in Base UI's `Button`.** The tempting translation is
`<Button render={<a/>} nativeButton={false}>`. It is wrong: `nativeButton={false}`
makes Base UI *add* `role="button"` to the anchor, which removes it from
`getByRole("link")` and misreports navigation to assistive tech. Use
`buttonVariants({ variant, size })` as the link's className instead. **This is
the single biggest item here** — 4 of the 14 call sites are this shape, one of
them a next/link `<Link>`.

**3. `Select.Icon` ships a default `▼` child that `render` does not remove.** It
gets merged into whatever you render, ending up inside the chevron SVG — invisible
but present in `textContent`. Pass the icon as *children*, not via `render`. Only
matters if you keep a Select; this project has one.

**4. `Select.Value` renders the raw value, not the item's label.** Radix rendered
the selected item's children. Where value ≠ label you need
`<SelectValue>{(v) => …}</SelectValue>` or `items` on `Select.Root`.

**5. `closeOnClick` already defaults to `false` on `Menu.CheckboxItem`.** Any
Radix-era `onSelect={(e) => e.preventDefault()}` is dead code, and `onSelect`
isn't a Base UI prop — React forwards it to the DOM as a text-selection handler.

**6. Registry components reference utilities that live in shadcn's globals.css,
not in the component.** job-hunt's reimported combobox arrived using
`no-scrollbar` with nothing defining it — inert class, no error. Grep any newly
added component for classes your CSS doesn't define.

**7. Your test suite will not catch gotcha 1.** All 40 of job-hunt's e2e specs
passed while the console was throwing hydration errors — role and text assertions
see the settled DOM, not the warning. Given this project's *low* test coverage of
the UI, that is the main risk here. Verify with a console listener:

```ts
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") …});
page.on("pageerror", …);
```

Drive it through the four interactive surfaces (mobile nav, file dropdowns,
preview dialog, delete confirm) and assert the collected list is empty.

**8. Screenshots taken right after opening a popup look broken.** They catch it
mid-`fade-in`/`zoom-in-95` — transparent background, staggered rows. Wait out the
animation before diagnosing anything.

**What did *not* need touching:** the theme layer. Every colour token resolved
unchanged, and Base UI happens to set the same positioner variable names the
popup classes use (`--available-height`, `--anchor-width`, `--transform-origin`)
where Radix used `--radix-*`-prefixed ones — so no CSS port was needed. Check for
`[data-radix-*]` selectors in your own CSS; job-hunt had none.

## Order

If both projects are switched, do job-hunt first — done, so this note is settled:
its e2e suite surfaced the aria/role differences (gotchas 2 and 4) that this
project's tests would have let through silently.