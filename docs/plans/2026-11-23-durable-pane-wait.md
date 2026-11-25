# Durable waits on herdr panes

- Date: 2026-11-23
- Related: [Board plugin](2026-11-19-board-plugin.md), [Main Bot as the team's Router](2026-11-22-main-bot-router.md)
- Code: `ds-bot/src/board/waits.js`, the `wait_pane` tool and the poller in `ds-bot/src/board/plugin.js`, `wake` in `ds-bot/src/host/companions.js`

## Why

A Bot hands long work (a coding agent run, a test suite) to an agent in a herdr pane. To
learn when it is over, Bots ran `herdr agent wait` or `herdr agent prompt --wait`, often as
a DSH background job. Such a job lives in the DSH process and in one Session: a deploy or
restart stops it, and so does a new part of the chat once the context fills up. The
restart notice (resume.js) now tells a Bot which jobs a restart stopped, but the Bot still
has to notice and start over. The wait itself has to outlive the process.

## Decided behavior

- A Bot calls `wait_pane` with the pane id, the states to wake on (`idle`, `done`,
  `blocked`; all three by default) and an optional one-line note, then ends its turn.
  `stop: true` ends its wait on that pane. One wait per Bot and pane: a new one replaces
  it. At most 10 waits per Bot.
- The wait is kept in the board's own file (`bot-board/board.json`, key `waits`), so it
  survives a restart, a new part of the chat and a deploy.
- The host that holds the board lock polls each waited pane every 15 seconds with
  `herdr pane get` (the agent's state only). A read-only host does not poll.
- A pane that is still idle right after the prompt has not started yet. A wait counts a
  state it waits for only after it saw the pane in another state, or 2 minutes after it
  started.
- Once the pane gets there, the Bot is woken with a DS Bot note (not a user message): the
  state, the card it works on, its own note and the pane's last 40 lines. The wait is
  dropped only after the wake went out, so a crash in between wakes it twice rather than
  never.
- Where it is woken: the card's thread while the card is open and the wait was started
  there; else the group it asked from while it is still a member; else its own chat, in
  the part that is open at that moment.
- A pane that is gone wakes the Bot with that news. A wait that is not over after 24 hours
  wakes it once and ends.
- A pane that runs no agent (herdr reports `unknown`: the agent ended or crashed and left
  a shell, or it never started) can never get to a waited state. After 2 minutes in a row
  without an agent the Bot is woken with that news and the pane's last lines. An agent
  that shows up again in between resets the count.
- A wait that belongs to a card ends without a wake once the card is finished or
  cancelled: nobody is left to do anything with the result.
- A wait started from a card thread also adds the pane to the card, so the user can watch
  it on the card.
- The board rules tell Bots to use `wait_pane` and never to wait with `herdr agent wait`,
  `--wait` or a background job.

## Not done

- No wait on things other than herdr panes (a CI run, a file). The same store and wake
  seam would carry them if needed.
- The user does not see the list of waits on the page; the card shows the pane.
