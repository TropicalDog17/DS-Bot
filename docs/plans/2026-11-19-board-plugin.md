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
- Storage is one JSON file, written whole (temp file, fsync, rename) through one queue.
  A second dsh on the same home reads it and refuses changes, using DS Bot's home lock
  on `board.lock`. A file that does not parse is kept beside it as `.broken-<time>`.
- The page: the redesigned board from #5 (columns, drag between columns, segmented
  columns and Add card by the thumb on a phone, card sheet with move, note and cancel).
  It reads the plugin's own route, `POST api/ds-bot-board`, and polls it every 4 s
  while open.
- A note on a Bot's card reads `Note on board card <key or id> "<title>": <text>`, so
  the Bot knows which card it is about. `dsBotNotes` sends it `@Bot` in the card's group,
  else in the Bot's own chat. A note on the user's own card is kept on the card only.

## Limits

- **One browser bundle per package.** DSH keys client modules by package name, so the
  board's page cannot ship as its own bundle while it lives in the `ds-bot` package. It
  is built into DS Bot's `client.js` and stays dormant: it registers in `dsBotPages` only
  when `api/ds-bot-board` answers. Moving it to its own package later needs no change to
  the seams.
- **No import of group tasks.** `room.tasks` (the `group_task` list) is reachable only
  by reading DS Bot's state file, which is not a seam. The board starts empty, and
  `group_task` stays as it is.
