# Office documents

- Date: 2026-10-27
- Related: Issue #613; [desktop app](2026-10-16-desktop-app.md), [Bot runtime settings](2026-10-10-bot-runtime.md)

## Why

A Bot must be able to work on .docx/.pptx/.xlsx files directly: open them to see their
structure, check the health of the package, and make targeted edits, without the user
installing anything. DSH ships a set of Office skills (python-docx to write documents,
LibreOffice Kit to render, recalculate and export PDF). What is missing is the
package-level tool: structure reads with stable ids, relationship and content-type checks,
targeted edits across runs, accepting and rejecting tracked changes, and the box model and
contact-sheet review of slide objects.

## What the desktop app bundles

Following DSH Desktop, the desktop app ships a payload with the package (`npm run runtime`
downloads it from a locked manifest and checks SHA-256):

- CPython and document libraries (python-docx, python-pptx, openpyxl, lxml, Pillow, pandas
  and others)
- A standalone Node
- The LibreOffice Kit CLI and native engine
- The material for DSH's seven Office skills

The install grows by about 245 MB (841 → 1086 MB); the download by about 91 MB. Without the
payload the app still starts, only the skills are absent: the same `office.patch.yml` is
generated only when both plugins are available.

## ds-bot's own command line (`office.js`)

A single-file CLI packed into the npm package. It depends on Node built-ins plus a bundled
XML parser and works on every runtime surface (desktop app, DSH Desktop, DSH Web). Exit
codes: 0 success, 1 findings remain, 2 usage error or failure. With `--json` it prints
`{"ok":true,"data":…}` / `{"ok":false,"error":{…}}` (findings are in `data.findings`, and
ok stays true). Edits save to a new file by default (`-o`); only `--in-place` writes in
place.

- `unpack`/`pack`: unpack the package into readable XML (`pack` restores the layout
  whitespace and runs `check --against`)
- `check [--against] [--fix]`: checks only for problems that make Office refuse to open a
  file or offer to repair it: well-formed XML, complete content types, reachable internal
  relationships, existing r:id references, pptx shape and slide ids, docx docPr/paraId,
  `xml:space`, consistent comment ids. `--against` looks only at newly introduced problems;
  `--fix` fixes the safe kinds
- `docx read [--changes]`: body blocks numbered `p1…`/`t1…`, headers and footers,
  footnotes and endnotes, comments and their anchors. Tracked changes show as accepted by
  default; `--changes` uses inline marks such as `{+inserted (author)+}`
- `docx fields`: instructions and current results of simple and complex fields
- `docx edit --ops`: atomic batch ops: `replace` across runs (keeps the format of the
  first run, skips deleted text, regex with `$1`), `set_cell`, `set_field`, `insert`,
  `delete`, `comment`, `accept_changes`/`reject_changes`
- `pptx inventory`: slide size, theme fonts, every shape on every slide (id, name, type,
  placeholder, box in inches, including group coordinate transforms and placeholder
  inheritance from layout and master), text per paragraph with run font and size, image
  media
- `pptx layout [--autofit]`: findings for overlapping text boxes and boxes that run off
  the slide; `--autofit` writes `a:normAutofit`; overflow inside a box shows only when
  rendered
- `pptx slides --order`: reorders by current position; a repeated position is a copy
  (slide, rels, notes page, charts, embedded workbook), a skipped one is a delete; then
  runs clean
- `pptx clean [--dry-run]`: slides not in sldIdLst, unreachable parts, dangling
  relationships and Overrides, unreferenced media (shared with docx/xlsx)
- `xlsx inventory` / `xlsx read --sheet [--range]`: sheet state, dimensions, cell and
  formula counts, merges, tables and charts, defined names, error cells and their formulas,
  a hint when cached values are missing; reads cached values, formulas and ISO dates as a
  grid
- `sheet`: joins rendered pages into a contact sheet with page numbers (pure JS PNG
  encoding and decoding)

## Two skills

Registered by the ds-bot plugin (provider `ds-bot-office`). They take effect only when the
host has the `skills` service: a cordis child fiber makes them silently absent where there
is no skills service, without blocking plugin start.

- `office` (rank 550): reuses the body of DSH's routing skill, adds a line that points
  "structure reads, package checks, targeted edits" to `office-tools`, and states that
  skills missing from the catalog are not available in this environment. The rank is 550
  because a lower value wins within a tier: DSH's own office skill is bundled at rank 600,
  and user and project skills at 100–500 still win over ours.
- `office-tools` (rank 600): an original SKILL.md: how to choose a command, one workflow
  each for Word, PowerPoint and Excel, XML only through `unpack` + a real parser +
  `pack --against`, the finishing standard, and layout rules for new decks. On load it
  appends `{"officeTools":{"node","cli"}}` for the environment. For node it tries in order
  `DS_BOT_OFFICE_NODE` (desktop app payload) and `process.execPath` on a pure Node host;
  otherwise it asks for node from `load_workspace_dependencies`, and if that fails it says
  the commands are not available. cli is the absolute path of `ds-bot/office.js`, mapped
  to `app.asar.unpacked` inside an asar.

DSH's six format and operation skills (office-docx/pptx/xlsx, office-render,
office-recalculate, office-export-pdf) stay as they are; only the small router is
replaced.

## Runtime on each surface

- Desktop app: everything works: the payload's Python, Node and LibreOffice, DSH's Office
  skills, and all `office.js` commands (the host injects `DS_BOT_OFFICE_NODE`, and
  office.js runs from `app.asar.unpacked`)
- DSH Desktop: DSH's own Python and renderer work as usual, plus our `office.js` commands
  (a pure Node host uses the host interpreter; otherwise the skill text says to call
  `load_workspace_dependencies` for node)
- DSH Web: only the `office.js` commands. There is no bundled Python (creating new files
  is limited) and no renderer (unless the user installs the Office sidecar that DSH
  provides)

## Not done

- No template or theme generation; layout rules are written as skill text
- No XSD validation: `check` covers only the "Office refuses to open or offers repair"
  level
- `accept_changes`/`reject_changes` do not handle tracked changes nested in field
  instructions, and do not roll back the content of `w:numberingChange` (a numbering
  change only loses its mark; the numbering is not restored)

## When DSH is upgraded

Change the lock file version: take `scripts/primary-runtime/lock.json` from the matching
DSH tag, overwrite `app/scripts/primary-runtime.lock.json` with it, run `npm run runtime`
to rebuild the payload, and check again with `npm run check-packed`. At the same time,
review our office router against the new `assets/office/SKILL.md`.
