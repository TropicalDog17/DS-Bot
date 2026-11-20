# An imported earlier chat as part 0 of a Bot's own chat

- Date: 2026-11-20
- Related: the OptChat plugin (#9, #10)

## Why

A Bot can take over from an earlier assistant (such as the old TropMaid on Telegram).
What the user said to that assistant should be as easy for the Bot to find as its own
chat. Until now it lived only in the OptChat plugin, behind `optchat_search`. When the
Bot looked something up with `recall` and `read_own_chat`, both said "nothing", and the
Bot concluded it had never been discussed. Two history tools that never mention each
other turn a wrong tool choice into a wrong answer.

So the earlier chat joins `read_own_chat` as part 0 of the Bot's own chat. There is one
way to look up what was said, and the OptChat plugin can be turned off.

## Decided behavior

- The earlier chat is a file, `DSH_HOME/bot/imported-chat/<botId>.jsonl`, one message
  per line: `{ seq, time, who: 'user' | 'you', text }`. DS Bot only reads it.
- `scripts/import-chat.mjs <bot home> <botId> <OptChat store> [--replace]` writes it from
  an OptChat store (`main/*.jsonl`). It keeps what the user said (`user`) and the
  assistant's answers (`talk`), and leaves out tool calls, tool output and notes. `seq` is
  the original message ID. An existing file is written again only with `--replace`. The
  store is only read.
- When the file exists, `read_own_chat` treats it as part 0:
  - A word search covers it with the other parts. Its anchors look like
    `[part 0 #1465 · 11-02 00:30]`, and every other part's anchors then carry their part
    number too.
  - `around` opens a part 0 anchor. An anchor without a part still means the current part.
  - The parts list names part 0 as "an earlier chat imported from before you existed",
    with its first and last date. `part 0` answers that it has no handoff note and
    points to a word search or an anchor.
  - Reading the latest messages (no arguments) reaches part 0 last, only when the other
    parts do not fill the page.
- The chat index stores part 0 whole in the same FTS table, as session `import:<botId>`,
  and rebuilds it when the file changes (another modification time or size). Without
  SQLite, the log scan reads the file too.
- A damaged file (bad JSON, a missing field) means no part 0 for that Bot and one
  warning; the other parts stay searchable.

## Not done

- The earlier messages are not written into a DSH Session: the plugin API cannot add
  events with past dates, so every date would be wrong.
- No memory is made from the earlier chat, so `recall` does not find it. Remembering its
  decisions takes a separate memory review.
- Part 0 is not shown in the interface; it is only for the Bot to look things up.

## Known limits

- The index version goes to 4, so the first lookup after the upgrade rebuilds the whole
  chat index from the logs.
