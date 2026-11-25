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
- A card is Done only when its code is in. When a Bot calls `board complete` on a card
  with a GitHub pull request in its links (or the `link` it brings), the board asks
  `gh pr view <url> --json state` first. If any PR is not reported `MERGED` (or gh can't
  tell), the card goes to Review instead. It keeps the result, gets `need: Merge <the
  PRs>`, and is marked `waitsMerge`. Its thread stays open, and the phone push says it
  is ready for review. A Bot that moves a card into Review with a PR, or adds a PR to it
  there, marks it the same way. Every 5 minutes (`config.mergePollMs`), the board asks
  gh about the PRs of each card that waits, and moves the card to Done once all of them
  are merged. Then it closes the card's thread and pushes "all merged". The Bot that
  opened the card hears when the work is finished and waits for the merge, not a second
  time at the merge; a card that got into Review another way is reported at the merge.
  A card that leaves Review (the user drags it back, the Bot moves it on) stops waiting.
  A PR closed without merging leaves the card in Review for the user, and the card says
  so: its `need` names the closed PR and the choices (reopen and merge, a note with what
  to do instead, or Done), and one push tells the user. The same happens when gh cannot
  read a PR three polls in a row. Both clear by themselves when the PR is open or
  readable again. gh is found at `config.gh`, else `/usr/bin/gh`, else on the PATH, and runs as
  the user who runs dsh.
- The sheet shows the card's brief under its links, folded to a few lines when long.
- Work a Bot hands to a [herdr](https://herdr.dev) pane runs outside its turns, so the
  card's own trace goes quiet while the pane works. A card keeps the panes its work runs
  in (`panes`, the newest 4): a shell command from the card's thread that drives herdr
  (`herdr agent prompt w1:p1T …`) adds the panes it names, except `pane close`; from
  anywhere else the Bot names one with `board update pane`. The sheet shows a Terminal
  toggle under the steps; opened, it shows the newest pane's last 200 lines (`herdr pane
  read --source recent-unwrapped`) and herdr's agent state, read again every 2 s while
  open, through the route's `pane` endpoint. That endpoint reads only a pane on the
  card, so the page cannot read any other pane. herdr is found at `config.herdr`, else
  `~/.local/bin/herdr`, else on the PATH.
- Storage is one JSON file, written whole (temp file, fsync, rename) through one queue.
  A second dsh on the same home reads it and refuses changes, using DS Bot's home lock
  on `board.lock`. A file that does not parse is kept beside it as `.broken-<time>`.
- The page: the redesigned board from #5 (columns, drag between columns, segmented
  columns and Add card by the thumb on a phone, card sheet with move, note and cancel).
  It reads the plugin's own route, `POST api/ds-bot-board`, and polls it every 4 s
  while open, every 1 s while a card waits for a Bot's answer or shows a running turn.
- A note on a Bot's card reads `Note on board card <key or id> "<title>": <text>`, so
  the Bot knows which card it is about. `dsBotNotes` sends it `@Bot` in the card's group,
  else in the Bot's own chat. A note on the user's own card is kept on the card only.
  A note to a card's own thread steers it (`sessionController.prompt` with `mode:
  'steer'`): a turn that runs there reads the note at its next step instead of after
  the turn, so a long wait in a turn no longer holds the user's words back.
- In a card's thread a `board` call without an `id` is about that card. Anywhere else it
  is the Bot's newest open card, as before. A Bot with several cards side by side can no
  longer update the wrong one by leaving the id out.
- The user's own moves are reported like a Bot's. Moving a card to Done or cancelling it
  on the board writes a step in the card's log, tells the Bot that opened the card (a
  quiet note: the user did it, so there is nothing to tell them), and, when the card's
  thread is in a turn, steers the reason into it so the Bot stops instead of working on
  a closed card. Moving a finished card back to In progress opens a new thread for its
  Bot with the brief and the result so far.
- A card In progress that nothing runs for is noticed (`watch.js` `idleStep`, checked
  with the watchdog): its thread is in no turn, no note waits for an answer, and it
  keeps no `wait_pane`. After 20 minutes (`config.idleMs`) the Bot is nudged in the
  card's thread to go on, wait on its pane, hand the card to the user or finish it. If
  the card is still quiet 20 minutes later the user gets one push. Then the board stays
  silent about it until the card waits on a pane, leaves In progress or gets a note.
- While a card waits for its Bot, or its thread is in a turn for any other reason (the
  brief, a wake from a pane, a nudge), the sheet shows what the Bot is doing about it
  under its mark: its reasoning as it streams and each tool call, named as the chat's activity
  row names it (a local agent CLI's own `▸` lines count as tool calls). The plugin reads
  DSH's own `agent/assistant-stream` and `session/event` events for the Bot's Sessions
  (`botSessionIdentity`) and keeps the current turn of each in memory only (`live.js`);
  for a waiting note only a turn that began after the note shows, and without one only
  a turn that has not ended. When the answer lands (`dsBotNotes`
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
