# Reskinning plan

Goal: move mollycodel away from the recognisable VS Code look, a step at a time, without
ever having a build that is visibly broken. "Reskin" differs from "theme" in one way: a
theme can only change colours (and a few font settings). A reskin also changes **metrics**
(sizes, gaps, padding, radii, borders) and **assets** (icons, logos, fonts). Metrics and assets
are the parts a theme cannot reach, so this plan is mostly about those.

Everything below was checked against the source in `vscode/` (VS Code 1.135.0), except
where marked *to verify*.

## 1. What the source gives us to work with

There are five levers. They differ a lot in how risky they are.

| Lever | What it controls | Where it lives | Risk |
| --- | --- | --- | --- |
| **A. Design tokens** | Spacing, corner radius, font ramp, shadows, surface colours, as CSS variables (`--vscode-spacing-size40`, `--vscode-cornerRadius-large`, `--vscode-surface-*`, `--vscode-fontSize-*`) | `platform/theme/common/sizes/baseSizes.ts` (37 registered sizes), `sizeUtils.ts`, colour registry | Low. Changing a value changes every consumer consistently. |
| **B. Modern UI mode** | Floating cards for side bars and panel, margins, rounded corners, refreshed header styles | `workbench.experimental.modernUI` setting; `workbench/browser/media/floatingPanels.css`; `FLOATING_PANEL_MARGIN` in `services/layout/browser/layoutService.ts` | Low. Already shipped and tested by Microsoft; we turn it on and tune it. |
| **C. Own stylesheet** | Anything CSS can reach, loaded last | one new file, imported from one place | Medium. Specificity fights, and any size change must match code (see 3). |
| **D. Icons** | Every `$(codicon)` in the UI (about 750 names), file icons, logos | codicon font (`codicon.ttf`), product icon theme, file icon theme, SVGs | Medium. Wide, but there is a supported replacement path (see 2). |
| **E. Layout constants in code** | Activity bar width (48), tab and title heights (35), breadcrumb (22), part header (35), ... | `activitybarPart.ts`, `part.ts`, `editorHeaderControl.ts`, `layoutService.ts` | High. The grid does pixel math in TypeScript; CSS alone desyncs it. |

The surface area (from `python3 dev/reskin-inventory.py`): about **395 CSS files and 8,700 `px`
literals**: 648 in the core workbench chrome, about 6,000 in feature code (`contrib/`), 1,720 in
the Agents Window. We will not edit those. They read **768 distinct `--vscode-*` variables**,
which is the point: the variables are the handle.

**The key constraint.** A CSS change that alters the *size* of a part (activity bar width,
title bar height, tab height) must be matched by the same number in the TypeScript layout code,
or the editor area and the chrome stop lining up. Spacing *inside* a part, colours, radii,
shadows, borders and icons are free of this. So the plan front-loads the free changes and
treats size-of-part changes as a separate, later phase with its own patch.

## 2. Icons: why it is not as simple as it looks, and the way through

What makes icons hard:

- The UI names icons, it does not contain them. Code says `$(search)` or `Codicon.search`; a
  CSS rule maps `.codicon-search::before` to a character in `codicon.ttf`. There are about 750
  names, and ~100 are visible in a normal session (activity bar, explorer, tabs, status bar,
  title bar, Source Control, search, debug, chat).
- Several different systems draw icons and each needs its own answer:

| Kind | Examples | Replace by |
| --- | --- | --- |
| Product icons (codicons) | activity bar, toolbars, tree twisties, view headers, status bar | **A product icon theme** (supported mechanism, below) |
| File and folder icons | Explorer, tabs, breadcrumbs | A file icon theme (a built-in extension; Seti is current default) |
| Extension-contributed icons | activity bar entries from extensions | Not ours to change; they bring their own SVG |
| Logos and illustrations | window/dock icon, welcome page, empty-editor "letterpress", sessions logo | Direct SVG/PNG replacement in the build overlay |
| Hard-coded SVG in CSS/TS | a handful of widgets | Found by search; patched one by one |

**The supported path:** a *product icon theme* is a JSON file plus an icon font. For any
codicon id it can substitute a different glyph from a font we supply (`iconDefinitions` ->
`fontCharacter`, with `fonts` declared; schema in
`workbench/services/themes/common/productIconThemeSchema.ts`). Icons the theme does not
mention fall back to the codicon, so we can replace them in batches and the app is always
complete. This avoids forking the codicon font. Shipping it as a built-in extension and making
it the default (via `configurationDefaults` for `workbench.productIconTheme` in `product.json`)
leaves users free to switch back.

**Where the glyphs come from** is a decision for you (open question 1). Whatever the source,
we need an icon *set with a permissive licence* (Lucide, Phosphor and Tabler are all MIT/ISC),
or ones drawn for mollycodel. We convert SVGs to a font with a script, so the set is a build
input, not hand-edited binary.

## 3. Strategy: one stylesheet, one icon theme, tiny patches

To stay mergeable with upstream and keep every step reversible:

1. **One new CSS file we own**, `workbench/browser/media/mollycodel.css`, imported from a single
   line in `workbench.ts` (and one in the sessions entry point). Variables overridden on `:root`
   first (lever A), then targeted rules (lever C). All our look lives there.
2. **One built-in extension** for icons (`extensions/mollycodel-icons`, a product icon theme),
   plus a file icon theme later.
3. **A new user patch per phase**, generated with `dev/make-user-patch.py` like the others, so
   each phase can be reverted by removing one patch.
4. **`product.json` `configurationDefaults`** to make our look the default (modernUI on,
   product icon theme, font settings) without touching settings code.
5. **Code constants only in the last phase**, a few at a time, each paired with its CSS change.

## 4. Phases

Each phase ends with a build, screenshots of a fixed list of views, and your sign-off before
the next begins. Phases 0 to 2 touch no layout code.

**Phase 0: Prep (this document + tooling).** Baseline screenshots of the current app in a fixed
set of views (empty window, Explorer open, editor with tabs, Search, Source Control, panel with
terminal, Agents Window list, a Pi chat, a settings page), light and dark, so every later phase
can be compared. Confirm a fast dev loop: whether the CSS can be iterated against a running
dev build rather than a 20-minute app rebuild (*to verify*; `npm run watch` + `scripts/code.sh`
is the usual route). Add `dev/reskin-inventory.py` so the metrics in section 1 are
reproducible. Nothing user-visible changes.

**Phase 1: Foundations.** Create `mollycodel.css` and the import; turn on `modernUI` by default
(floating cards, radii, gaps) and see how far that alone moves the look. Then override tokens:
corner radius scale, spacing scale, font ramp, shadow. This is the biggest visual change for
the least risk. The Agents Window shares these tokens, so the two windows stay consistent.

**Phase 2: Icons, batch 1.** The icon theme extension, covering the ~25 most visible icons:
activity bar, Explorer actions, tab close/dirty, status bar, title bar buttons, Chat/Agents.
Plus the logos: window icon already done; welcome page, empty-editor letterpress, sessions logo.
Fallback to codicons for everything else.

**Phase 3: Icons, batch 2 and file icons.** Widen coverage to the ~100 common icons, then
a file icon theme (folders and common file types) so the Explorer stops looking like stock.

**Phase 4: Chrome shape.** Activity bar (position, width, icon size), tab style (height, radius,
active indicator), status bar, title bar, panel headers. This is where lever E applies: each
change is paired with its code constant, and we add a test that fails if CSS and code disagree.
Smaller changes can be done here with no code change (padding, radius, borders).

**Phase 5: Typography and density.** UI font, sizes, line heights, density presets
(compact/comfortable). Editor font is the user's, and we leave it alone.

**Phase 6: Identity and the Agents Window.** The look of the second window: session list,
composer, chat bubbles, tool cards. These are our own components (`src/vs/sessions` and the Pi
parts), so there is no upstream to stay mergeable with, and this is where the app can be most
different. Welcome and first-run screens.

**Phase 7: Own default theme.** Colours: a mollycodel colour theme (dark and light) that matches
the shape work, set as the default.

## 5. How each step is verified

- **Visual:** the fixed screenshot set from Phase 0, before and after, light and dark. I take
  these from the real built app (not only a dev build) and show you the comparison.
- **Layout integrity:** after any size change, resize the window, drag every sash, and check
  nothing overlaps or clips; open the Agents Window and the side-panel chat.
- **No regressions elsewhere:** high-contrast themes must still work (modern UI and our CSS use
  the variables, so contrast themes override them); zoom 80% / 150%.
- **Reversibility:** each phase is one patch, so `rm` it and rebuild to get the previous look.

## 6. Risks and how we handle them

- **Upstream churn.** We track a pinned VS Code tag, not main, and keep our CSS in one file, so
  an upgrade means re-checking one file and a handful of patch hunks.
- **`!important` and specificity.** Modern UI already uses `!important` in places. Our rules go
  in a late, scoped stylesheet; if a rule needs `!important` it is listed in the file header so
  it can be audited.
- **Experimental flag.** `workbench.experimental.modernUI` is Microsoft's, labelled
  experimental, and may change shape in a later tag. We rely on it for Phase 1 only and can
  copy its rules into our own file if it moves.
- **Extension icons and webviews.** Extensions that draw their own UI (and the Settings editor,
  some webviews) take colours from the theme but sizes from themselves. We accept imperfect
  consistency there.
- **Licensing.** Any icon set must be MIT/ISC/Apache or our own; each is recorded in
  `ThirdPartyNotices`. No icons or art copied from other editors.

## 7. Decisions needed from you

1. **Icon source:** draw our own, or adopt an open set (Lucide / Phosphor / Tabler) and adjust?
   This sets the whole feel; I would start with one open set and replace icons selectively.
2. **Direction:** "just a bit different" in which direction: softer and rounder (cards, more
   air), denser and flatter (editor-tool feel), or something else? A reference app or
   screenshot is the quickest way to tell me.
3. **Phase 1 first?** Turning on Modern UI is a one-line, reversible change that shows how far
   Microsoft's own shape work gets us before we write any CSS. I suggest doing it first.
