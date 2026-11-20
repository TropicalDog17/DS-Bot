# Bot views (widget views)

- Date: 2026-10-20
- Related: #386, #468 (third version: charts, inputs and formulas, sandboxed html)

## Why

Bot answers are only Markdown text today. Some answers are structured by nature: a few cards, a table, a
set of options, a progress bar. Plain text makes these long and hard to read, and models often get the
format wrong. The industry approach (ChatGPT Apps, MCP Apps, OpenUI) is to let the model put an
interactive interface directly in the chat.

The first proposal of 2026-10-20, "the model writes HTML, an iframe renders it", was rejected in an
external review, mainly because:

- Arbitrary HTML has no compact serialization: the context steward and the handoff pack either overflow
  or lose all of it, and the Bot in the next Session part does not know what the user saw.
- An iframe loses its internal state when the chat's virtual scrolling unmounts it; scripts written by
  the model can submit on their own, causing a turn-hijacking endless loop.
- Opening a GET route for widget content and setting up a CSP depends on undocumented DSH server
  features, and the plugin carries the risk.

Trade-offs (second version):

- No code written by the model is run. The model only picks components from a fixed catalog and fills
  in data; rendering uses ds-bot's own React components. Safety comes from "no code execution", not from
  a sandbox.
- The blueprint is size-limited JSON, which `parts.js` can compress into a summary for the handoff pack;
  history replay re-renders from the same blueprint.
- It reuses the whole loop of the question card: state registration, inline drawing in ToolCell, floating
  above the input box for hidden turns, and the answer fed back as a user message. A view card is a
  generalization of the question card, but storage and reply format are separate, and it does not share
  a map with the question card.

The third version (2026-10-23, #468) adds three things on top of the second; the second version's rules
stay:

- Charts and local interaction: the catalog adds charts, input controls and formulas. When the user drags
  a slider or changes a number, the page recomputes on the spot from formulas the Bot wrote, with no
  model call and no tokens spent.
- Content the catalog cannot draw (custom graphics, small games, flow charts) can be written as an `html`
  component in a sandboxed iframe. Common displays still use the blueprint: it saves tokens, follows the
  theme, is validated, and on an error the model gets an error with a path and can rewrite it.
- Frame: a display-only view sits directly in the answer without a frame; a view with input or answer
  controls has a light frame. The "View" label is gone, and the title becomes an optional small heading.

## Decided behavior

### Tool

- `show_view`: shows the user a view in the Bot's own chat. Parameters: `title` (optional, small
  heading), `view` (JSON blueprint, see below), `await_reply` (optional).
- Combination rules: a blueprint with answer components (options/confirm/form/submit) must have
  `await_reply: true`; input controls (slider/number/choice/toggle) are not answer components; a
  display-only blueprint with `await_reply: true` is refused (the turn would wait for a card that cannot
  be submitted). By default it is inferred from whether the blueprint has interactive components;
  `exec.concludeTurn()` is called according to the **effective** `await_reply`, after validation passes
  and the state is saved to disk.
- Refused in group chat Sessions (with the same message as `ask_user`).
- A validation failure is refused atomically: no state is registered, the turn does not end, and the tool
  result gives a fixable error (with a path and the allowed values, such as
  `view.children[2].type: unknown component "chart"; allowed: stack, text, …`; when over a limit, with
  the measured value and the limit).
- Limits: 8 KiB serialized (UTF-8 bytes, including the title), component tree depth 8, 64 component
  nodes; tables ≤ 50 rows and ≤ 8 columns; forms ≤ 6 fields; options ≤ 8 choices. Nested JSON structures
  do not count toward depth; only the component tree does.

### Component catalog

A blueprint is one component node: `{ type: string, …props, children?: node[] }`.

Layout:

- `stack`: arranges children vertically. `row`: arranges them horizontally, wrapping when narrow. Both
  require `children` (1–16). The outermost container can carry `let: { name: "formula" }`.

Display:

- `text`: `{ text, tone?: muted }`, a piece of Markdown. Raw HTML is not rendered; links are http(s)
  only and open in a new window; the model cannot control style, events, className or other DOM
  attributes.
- `metric`: `{ label, value, tone?: good|warn|bad, caption? }`.
- `table`: `{ columns: [{ key, label }], rows: [[…]] }`, read-only. Columns that are all numbers are
  right-aligned.
- `chart`: `{ kind?: bar|hbar|line|area|donut, categories: [label], series: [{ name?, values: [number] }], unit?, caption? }`.
  Each series has as many values as there are categories; a donut has only one series. Drawn with SVG at
  the width it gets, using theme variables only for color (the first series uses the accent color).
  Hover or the arrow keys show one category's values and dim the rest; multiple series get a legend,
  where a click hides or shows a series; a menu at the top right: view as table, copy data (CSV),
  download image (PNG).
- `progress`: `{ label?, percent }` or `{ label?, value, max }`, with optional `valueLabel` (text on the
  right, such as "¥10 left") and `tone`.
- `callout`: `{ text, tone?: info|good|warn|bad }`, a notice.
- `sources`: `{ items: [{ label, url }] }`, small source tags, http(s) only, open in a new window.
- `html`: `{ html, summary, height? }`, see "Sandboxed html" below.

Inputs (values stay on the page, are not sent to the Bot, and do not end the turn):

- `slider`: `{ id, label, min, max, step?, value, unit? }`.
- `number`: `{ id, label, value, min?, max?, step?, unit? }`.
- `choice`: `{ id, label, options: [{ label, value }], value? }`. Up to four short options sit side by
  side as segmented buttons; otherwise they are stacked.
- `toggle`: `{ id, label, value? }`.

Answers (end the turn; the answer is the user's next message):

- `options`: `{ id, options: [{ label, description? }], multi? }`. Single choice submits on press;
  multiple choice toggles checks and shows a Submit button (the same as the question card).
- `confirm`: `{ id, confirmLabel?, cancelLabel? }`, submits on press.
- `form`: `{ id, fields: [{ id, label, placeholder?, value?, multiline?, readOnly? }], submitLabel?, cancelLabel? }`,
  supports preset initial values, single-line and multi-line input, read-only fields, and an optional
  cancel/discard button (cancel settles as `{ canceled: true }`). The description forbids using a form to
  collect secrets; secrets go through `request_secret`.
- `submit`: `{ id, label? }`, sends the current values of the input controls to the Bot ("Send to Bot").

Identity constraints: the `id`s of interactive components and inputs are unique in the whole tree; an
input's `id` must be a name a formula can refer to (letters, digits, underscore, not starting with a
digit); field `id`s in a form are unique within that form; options are identified by their label (the
same as the question card); choice values are unique.

### Formulas

- Written as `{ "=": "expression" }`. Properties that can take a formula: metric value, caption, tone;
  text text; progress percent, value, max, valueLabel, tone; callout text, tone; table cells; each chart
  value.
- An expression reads only input `id`s and names in `let`: numbers, 'text', `+ - * / %`, comparisons,
  `&& || !`, `a ? b : c`, and `min max abs floor ceil sqrt pow round clamp fixed format percent`. No
  property access, assignment or loops, and no access to the page. Parsing and evaluation are in
  `src/core/formula.js` of the `deep-view` package, shared by host and interface.
- The host evaluates every formula once with the initial values the Bot set: a parse failure, an unknown
  name, `let` names that refer to each other, or a result of the wrong type (such as a tone outside the
  allowed values) are all refused as a whole, with a path.
- On the page every input change recomputes; when a formula cannot be computed with the user's values,
  that spot shows a placeholder, without affecting the rest.

### Sandboxed html

- Used only when the catalog cannot draw it; `summary` is required, and handoffs and summaries use only
  that.
- Placed in an iframe with `sandbox="allow-scripts"` (`srcdoc`), without same-origin: it cannot reach the
  app, storage or interfaces. The document starts with a CSP that forbids network access
  (`default-src 'none'`, allowing only inline scripts and styles, and `data:` images and fonts), then
  the model's content.
- Theme variables (`--bt-ink`, `--bt-line`, `--bt-accent` and others) and the color scheme are injected;
  switching light and dark sends a message to update them. Scripts in the frame can only report their
  own height, and the iframe grows with it.
- The iframe has no submit channel: it cannot answer the Bot or end the turn; its state is not saved.
- When the iframe navigates to another page (a second load), it is replaced by a notice and no longer
  shown.

### Frame

- A display-only view has no frame and follows the answer directly, as wide as the body text; a view with
  input or answer controls has a light frame; a pending view floating above the input box keeps its
  raised style.
- There is no "View" label; when `title` has a value it shows as one line of small heading.

One view can hold several interactive components; **one submission settles the whole card**: it carries
only the `values` of the triggering component (options: `{ selected: string[] }`; confirm:
`{ confirmed: boolean }`; form: `{ fields: { [fieldId]: string } }`; submit: `{}`); unsubmitted input of
the other components is dropped, and their controls are no longer usable in the answered rendering. When a
view has input controls, every submission carries `inputs: { [inputId]: value }`: missing ones are filled
from the initial values, and the server checks each one (range, choice value, boolean). An answered view
shows the values as sent, with read-only controls. Empty submissions: options need at least one choice,
confirm must have a button value, a form allows all fields empty. Text values are limited to 2,000
characters.

### State and lifecycle

- A pending view is stored in `state.views`, one per current chat Session
  (`{ id, callId?, title, view, askedAt }`). A new pending view replaces the old one in the same Session;
  it is withdrawn when an ordinary user message or an answer arrives; on a part switch it moves over and
  loses its `callId`; when the Bot is deleted it is cleaned up with each part. This matches the consumer
  rules of `state.questions` one to one.
- How the two stores relate: a pending question card and a pending view in the same Session can
  **coexist**, and neither replaces the other; an ordinary message withdraws both. A display-only
  `show_view` does not affect any pending record.
- Display-only views are not in `state.views`: they are rendered from the accepted tool call arguments,
  and their visibility does not depend on a pending record.
- Hidden turns: a pending view floats to the dock (it goes into `CARDS`, with the same `useShownCards`
  bookkeeping as the question card; the dock keeps QuestionDock's suppression during history loading);
  a display-only view in a hidden turn is not shown persistently and stays only in the turn record.

### Rendering and submission

- ToolCell draws `show_view` as a view card (`WidgetCell`), styled by the `--bt-*` variables; light and
  dark themes, narrow layout, keyboard use, table overflow, and disabled/submitting/error states must all
  pass.
- Submission goes through a new case `view-reply` of `POST /api/bot`: resolve the Session → check the
  pending id → validate the submitted values against **the blueprint the server holds** → claim first,
  then queue → `agent.followup` + `flush` → record for recovery on failure → save. Stale and duplicate
  submissions are refused.
- The user message fed back: the shape of `readReply`/`replyText` is extended by a discriminator field.
  With `kind: 'answer_to_pending_view'` it reads `views`/`answers`
  (`views: [{ id, title, view (validated blueprint) }]`, `answers: [{ id, action, values }]`); the
  original `questions`/`answers` branch is unchanged, and the two branches validate separately and never
  read each other's data. The history extraction and archiving in `parts.js`, and the live rendering of
  the reply node (`AnsweredView`, the view version of AnsweredCell), all branch on the discriminator
  field.
- An answered view is drawn on the **reply node**, with data from the reply message itself, in a
  read-only style. The original pending card then collapses and disappears (the same as `bt-q-gone`).
- Interface text goes through `t()`; titles and labels written by the model are generated in the user's
  language and are not used as translation keys.

### Compaction and handoff

- `viewCardText` (same shape as `cardText`): `[View card] title` (only `[View card]` when there is no
  title) + one line listing the components (with key values/options, such as
  `metric: Progress=70%; options: A/B/C`, at most 40 characters per component and at most 8 components)
  + a summary of the answer when answered. The answer summary is taken from the reply event, not from
  state.
- A display-only view is also compressed into a one-line summary. Formulas are evaluated with the initial
  values and the results written into the summary; inputs are written as `slider: label=value`; charts
  write the categories and the values of the first series; `html` writes its `summary`.
- In the answer summary, inputs are written as `label=value` (choice writes the option label).

## Not done

- HTML/JS written by the model runs only in the sandboxed iframe of the `html` component; other
  components run no model code. No external pages are embedded.
- No MCP Apps host of our own; once DSH officially supports SEP-1865, we will evaluate bringing in the
  MCP UI of connectors.
- No OpenUI Lang. Its real advantage (Apache-2.0, progressive parsing and rendering, about 2/3 fewer
  tokens than JSON) is that the blueprint appears as tokens stream in; this design renders only once the
  tool arguments are complete and validated, so a large blueprint near the limit has a noticeable delay
  before first paint. A small card of 8 components is not worth that parser for now; re-evaluate after
  measuring calls near the limit.
- Views are not in group chats. A group has nowhere to draw a view (the group page reads DS Bot's own
  group record, where each entry is only text), and interactive views would conflict with the group chat
  rules of "who answers, and speaking in order"; this needs its own design.
- Values the user dragged are not saved: after unmounting they return to the initial values the Bot set;
  the Bot does not know them by default, and they are sent only when the user presses `submit`.

## Known limits

- The blueprint survives, but **a half-filled form does not**: after unmounting by virtual scrolling or a
  part switch, unsubmitted input, dragged values and state in the html frame return to their initial
  values.
- Displays outside the catalog must be written as `html`: that costs more tokens than a blueprint, the
  style depends on the model following the theme variables, and the model gets no error when a script
  fails.
- The `html` frame forbids network access, but cannot stop it from navigating itself to an outside
  address (data can leave with the URL); after the navigation the frame is replaced by a notice, but the
  request has already gone out.
- Blueprint quality depends on how well the model follows the schema; a validation refusal costs one tool
  call.
- After the Session is compacted, an answered view is only a one-line summary, and the Bot cannot see the
  full blueprint of that time.
- The 8 KiB limit is a starting point based on the current shape of `ask_user_question` arguments in DSH
  Session logs; the hard limits of DSH or providers have not been verified against real persisted logs.
  The smoke test must measure calls near and over the limit.

## Code location

The implementation of blueprints, formulas, the reply format and the card components lives in the
separate `deep-view` package; ds-bot depends on it and no longer carries its own copy. ds-bot also no
longer registers `show_view` globally: each Bot's own Session and group Sessions register a tool of the
same name in their own Agent scope (a scoped registration takes precedence over a global one), so another
plugin's global `show_view` (Deep View, for example) only covers Sessions that ds-bot does not manage;
calls in groups are still caught by ds-bot's registration, which answers that views can only be drawn in
the Bot's own chat.

## Changes

- 2026-10-20: first draft (declarative catalog, second version). Reviews: Antigravity rejected the first
  version's iframe approach; Codex first review (ship with changes): separate state.views, answered view
  on the reply node, interaction combination rules, the limit on unsubmitted input, summaries with key
  values.
- 2026-10-20: Codex second review (ship with changes): concludeTurn bound to the effective await_reply;
  the reply format changed to two branches by a discriminator field; identity uniqueness and the shape of
  values fixed; the first submission settles the whole card; the coexistence rules of views and questions
  written down.
- 2026-10-20: Codex third review signed off (ship, no more changes needed).
- 2026-10-23: third version (#468): charts, input controls and formulas, row/callout/sources, sandboxed
  html; display-only views lose the frame and the "View" label, and the title is optional.
- 2026-10-27: the core code moved into the separate deep-view package; show_view is now registered per
  Session in the Agent scope, taking precedence in Bot Sessions and group Sessions over a tool of the same
  name registered globally by another plugin.
