# The owner's kanban board as a separate plugin

- Date: 2026-11-19
- Related: #5 (the board built into DS Bot, to be closed), #6 (the host seams this uses)

## Why a plugin

The board is one person's way of tracking work: five columns, cards that Bots open
with a `board` tool, notes from the user. Not every DS Bot install wants it, and it
should not grow DS Bot's state file, its host modules or its turn path. OptChat set the
precedent: a companion feature lives in its own plugin and reaches the team only through
services DS Bot provides. #6 adds those services; this plugin uses nothing else.

| Need | Seam (from #6) |
|---|---|
| Which Bot (and group) a `board` call speaks for | `botSessionIdentity.ownerOfSession` |
| Bot names, the Main Bot, a group's admin, the assignee list | `dsBotRoster` |
| A note from the user reaching the card's Bot | `dsBotNotes.deliver` |
| The `board` tool for a Bot on a local agent CLI, which gets tools only through DS Bot's MCP bridge | `dsBotBridge.share` |
| An icon in the sidebar and a full page | `dsBotPages` (browser) |

With the plugin off, DS Bot is unchanged: no tool, no route, no icon.

## Turning it on

Add this to the profile's `cordis.patch.yml` and restart dsh:

```yaml
- insert:
    - id: board
      name: ds-bot/board
```

Cards are kept in `<DSH_HOME>/bot-board/board.json`. To keep them elsewhere:

```yaml
- insert:
    - id: board
      name: ds-bot/board
      config:
        file: /abs/path/board.json
```

## What it does

- The `board` tool, with the same actions (`show`, `open`, `update`, `complete`,
  `cancel`) and permission rules as #5: the assignee, the Bot that opened a card or a
  Main Bot changes it; a group's admin may also cancel a card opened in that group.
- `ask`: when a Bot needs the user to decide, it asks on its own card with a `question`
  and 2 to 6 `options`. The question joins the card's conversation with its options,
  the card moves to Review and is unread. The sheet shows the options as buttons under
  the question; a tap sends the option as the user's note, so the pick reaches the Bot
  the way any note does. Once answered, the options stay with the pick marked. Only the
  card's assignee asks, since the pick goes to the assignee.
- What a Bot wrote on a card (its replies, progress, result, reason) is drawn by DSH's
  Markdown as the chat draws it, and a card it names is a tag that opens that card. A
  card's links go through the same Markdown, so a link shows the site's mark (GitHub's
  for github.com) and a short name: `owner/repo#12` for a pull request or issue,
  `owner/repo@abc1234` for a commit. The card on the board shows one plain line.
- A card that waits on the user (Review or Blocked) leads its sheet with what the user
  must do: the `need` a Bot gives with `board update` (Markdown, so the PR to merge is a
  link), or its progress line on a card from before `need`. Moving the card on or
  finishing it drops the need, and a Bot that moves a card into Review or Blocked
  without one is told to say it.
- A card keeps its steps (`log`): every column and progress it moved to, with the time
  and who moved it, the last 40. The sheet shows the progress line and folds the earlier
  steps under History, so progress no longer overwrites how the work went.
- The sheet shows the card's brief under its links, folded to a few lines when long.
- Storage is one JSON file, written whole (temp file, fsync, rename) through one queue.
  A second dsh on the same home reads it and refuses changes, using DS Bot's home lock
  on `board.lock`. A file that does not parse is kept beside it as `.broken-<time>`.
- The page: the redesigned board from #5 (columns, drag between columns, segmented
  columns and Add card by the thumb on a phone, card sheet with move, note and cancel).
  It reads the plugin's own route, `POST api/ds-bot-board`, and polls it every 4 s
  while open, every 1 s while a card waits for a Bot's answer.
- A note on a Bot's card reads `Note on board card <key or id> "<title>": <text>`, so
  the Bot knows which card it is about. `dsBotNotes` sends it `@Bot` in the card's group,
  else in the Bot's own chat. A note on the user's own card is kept on the card only.
- While a card waits for its Bot, the sheet shows what the Bot is doing about it under
  its mark: its reasoning as it streams and each tool call, named as the chat's activity
  row names it (a local agent CLI's own `▸` lines count as tool calls). The plugin reads
  DSH's own `agent/assistant-stream` and `session/event` events for the Bot's Sessions
  (`botSessionIdentity`) and keeps the current turn of each in memory only (`live.js`);
  only a turn that began after the note shows. When the answer lands (`dsBotNotes`
  `onReply`, matched to the turn by its start time), the card keeps a short copy with
  it: the last 24 steps and at most 2000 characters of reasoning, folded under
  "Thought it through" above the answer.
- A tool line opens on the call's input (one `key: value` line per argument) and what it
  gave back: up to 600 and 1200 characters while the Bot works, 300 and 600 on the
  copy an answer keeps.
- How much shows is the board's own setting, picked in its header and kept in
  `board.json` (`settings.trace`): `off` (the dots only, nothing kept), `tools` (the tool
  calls), `thinking` (calls and reasoning; the default) or `all` (tool lines open, and
  an answer keeps up to 60 steps, 8000 characters of reasoning and the live lengths of
  input and output). DS Bot's own "Show thinking" preference is not a seam, so the
  board does not follow it.

## Limits

- **One browser bundle per package.** DSH keys client modules by package name, so the
  board's page cannot ship as its own bundle while it lives in the `ds-bot` package. It
  is built into DS Bot's `client.js` and stays dormant: it registers in `dsBotPages` only
  when `api/ds-bot-board` answers. Moving it to its own package later needs no change to
  the seams.
- **No import of group tasks.** `room.tasks` (the `group_task` list) is reachable only
  by reading DS Bot's state file, which is not a seam. The board starts empty, and
  `group_task` stays as it is. (Later: the Main Bot router retired `group_task`; the
  board is now the only place work is tracked.)
