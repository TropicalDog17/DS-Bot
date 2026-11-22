# Several decisions on one question card, in groups and on board cards

- Date: 2026-11-20
- Related: `ask_user` (docs/plans/2026-10-10-bot-runtime.md), group chat
  (2026-10-07-group-chat.md), the board plugin (2026-11-19-board-plugin.md)

## Status

- Done: `ask_user` takes 1 to 4 questions in a Bot's own chat, with one Submit and one
  reply (the first section of "Decided behavior").
- Not done yet: group cards, the board's `ask` with `questions`, and answering a card
  with several questions in IM. Until the IM part is done, IM shows the questions of
  such a card as text without buttons, and the user answers it in the app. A client
  that knows one question only (the phone app) shows the first question of the card.

## Why

A Bot's status report often ends with several decisions for the user. For example:
"PR #1207 is open; merge it with a merge commit? Fix (b) is coded; push it? The Seq Scan
migration is not started; start it?" Today the Bot writes these as prose, and the user
answers them by typing. Three limits keep it from asking with a card:

- `ask_user` takes one question, so one card cannot hold three decisions.
- `ask_user` is refused in groups ("Question cards only work in your own chat"), and
  most status reports come from groups.
- The board's `ask` takes one question with 2 to 6 options, so a card conversation has
  the same limit.

The answer payload (`answer_to_pending_question`) and `AnsweredCell` already carry
`questions[]` and `answers[]`, so the reply side is ready for more than one question.

## Decided behavior

### `ask_user` takes 1 to 4 questions

- A new `questions` parameter: 1 to 4 items, each with
  `{ header, question, options: [{ label, description? }] (2 to 4), multiSelect?, detail? }`.
  `header` is a short tag of at most 16 characters (such as `PR #1207`), shown before
  the question and used in the reply.
- The old single form (`question`, `options`, `detail`, `multiSelect`) still works.
  The host stores it as a one-item `questions` list, so cards already open in a state
  file keep working.
- `allowCustom` applies to the whole card: every question gets an "Other" field.
- Answering: with one single-choice question and no custom field, a tap still sends it
  at once, as now. With more than one question, each question keeps its pick on the
  card, and one Submit sends them all. Submit becomes available once at least one
  question has an answer. A question left blank is sent as skipped, so the Bot knows
  it was not decided.
- The reply stays `answer_to_pending_question`, with one entry in `questions` and in
  `answers` for each question. A skipped one has `selected: []` and `skipped: true`.
- The tool description and the prompt line say: when a reply ends with several decisions
  for the user, write the report first, then put each decision on one `ask_user` card,
  one question each, with short options such as Merge / Not yet / Review.

### Group cards

- `ask_user` works in a member's group Session. The card is stored under the group's
  own Session (`state.questions[<group session>]`), with `askedBy: <botId>` and the
  member's call.
- A group holds one open card. A second card from the same Bot replaces its own open
  card. A card from another Bot is refused with "<Name>'s question is still open in
  this group; ask in your message, or wait until the user answers it."
- The group view shows the card in its question dock above the composer, headed with
  the asking Bot's name.
- The answer goes into the group as the user's message, addressed `@<Bot>`, with one
  line per question (`PR #1207: Merge`). The group relays it the way it relays any
  message the user writes there. A plain message from the user in the group closes the
  card as "Answered by message", like in a Bot's own chat.
- The member's turn ends when it asks, as in its own chat. Its report text is posted to
  the group as usual before the card shows.

### Board card conversations

- `board ask` takes `questions` with the same shape, as an alternative to
  `question` + `options`. A card holds at most 4 questions.
- The sheet shows each question with its options as buttons. With one question, a tap
  sends it, as now. With more than one, picks are kept and a Submit button sends one
  note: `Answers on board card <key> "<title>":` followed by one line per question.
- Once answered, every question keeps its options with the pick marked.

### IM

- Telegram shows a multi-question card inline: one message with every question, and an
  inline keyboard with one row of option buttons per question, then a Submit row. A tap
  marks the pick with ✓ in that row (the message is edited, nothing is sent yet); Submit
  sends every pick at once, blank questions as skipped. `callback_data` carries indices
  only (`<card>:<question>:<option>`), so it stays under Telegram's 64-byte limit.
  The IM layer's buttons gain rows (`buttons: [[…], […]]`); a flat list keeps meaning
  one button per row.
- Platforms without editable buttons get numbered text: each question with its options
  lettered, and the hint "Reply like 1A 2C 3B". A reply in that form answers the card;
  anything else closes it as "Answered by message".
- A single-question card keeps its current buttons everywhere.

## Not in scope

- Answering each question on its own as soon as it is picked (that wakes the Bot once
  per question). The card waits for one Submit.
- More than 4 questions on one card. A Bot with more decisions asks again after the
  answer.

## Tests

- Host: the old single form is stored as one question; `questions` validation (count,
  options, header length); a skipped question in the reply; a group card is stored under
  the group Session, a second Bot is refused, the same Bot replaces its card; the
  answer reaches the group as `@Bot` with one line per question.
- Board: `ask` with `questions`; the note text; the sheet keeps picks until Submit.
- Client: the card with three questions, Submit disabled until one is answered, the
  settled card showing every pick. Checked in the browser on a Bot chat, a group and a
  board card.
