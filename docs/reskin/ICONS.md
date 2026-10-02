# Title bar layout icons: exact SVG spec

These are the four buttons at the top right that toggle the side bars and panel. Together
they need **7 SVG files**, because three of the buttons show a different picture when their
panel is open and when it is closed.

| File name | Button | Shown when |
| --- | --- | --- |
| `sidebar-left.svg` | Primary side bar | the side bar is **open** |
| `sidebar-left-off.svg` | Primary side bar | the side bar is **closed** |
| `panel.svg` | Bottom panel | the panel is **open** |
| `panel-off.svg` | Bottom panel | the panel is **closed** |
| `sidebar-right.svg` | Secondary side bar | **open** |
| `sidebar-right-off.svg` | Secondary side bar | **closed** |
| `layout.svg` | Configure Layout (the fourth button) | always |

If you move the primary side bar to the right in settings, the app reuses the same files with
left and right swapped, so you do not need extra mirrored files. Draw the "left" and "right"
ones as mirror images of each other so it looks right either way.

## Format

- **Canvas:** `viewBox="0 0 16 16"`. Optional `width="16" height="16"`.
- **Colour:** one colour, any colour. The app uses only the **shape** (the transparent
  parts stay transparent) and paints it in the theme's colour, so hover, pressed and disabled
  states work automatically. Do not rely on two or more colours or on opacity to show meaning;
  tell "open" from "closed" by shape (for example, a filled panel region versus an outline).
- **Background:** transparent. No background rectangle.
- **Padding:** keep the drawing inside about 1px from each edge (x and y from 1 to 15).
- **Strokes are fine**, but check them at 16px: a 1px stroke should sit on whole-pixel positions
  (for example `x=1.5` for a 1px line) to stay crisp. Filled paths are the safest.
- **Plain SVG only:** no `<text>` or fonts, no `<image>`, no external links or `<use>` of other
  files, no scripts or CSS `@import`, no filters or gradients. A single `<svg>` containing
  `<path>`, `<rect>`, `<circle>`, `<line>` or `<polygon>` elements is ideal.
- **No colour attributes needed:** `fill="currentColor"` is fine and will be ignored.
- **File names exactly as in the table** (lower case, `.svg`).

## Where they go

`src/stable/src/vs/workbench/browser/media/layout-icons/` in this repo (the build copies it
into the app). The files that are there now are the stock icons, so dropping in your own
replaces them one by one; a missing file would break the build, so keep all seven.
Wiring is in `src/vs/workbench/browser/media/mollycodel.css` (patch `60-ui-cleanups`).

## Notes

- The picture is drawn at 16px. A 24px source scaled down will look soft; export at 16.
- These apply to the title bar buttons only. The same pictures inside menus keep the stock
  icons until we reskin those too (see `PLAN.md`).
