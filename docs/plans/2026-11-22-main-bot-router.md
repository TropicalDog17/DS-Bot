# Main Bot as the team's Router

- Date: 2026-11-22
- Related: DSH article "Exploring Super-agent Design" (DeepSeek Harness, 2026-11-01);
  [Board plugin](2026-11-19-board-plugin.md), [Two sessions of one Bot](2026-11-13-parallel-sessions.md),
  [IM](2026-11-04-im.md), [Roles and permissions](2026-10-07-roles-and-permissions.md)
- Code: built on `feat/main-bot-router` (see As built)

## Why

Today every Bot's own chat both talks to the user and does the work. It is the design the
Super-agent article calls "single session with a subagent tool": whether work is handed off
depends on the prompt and the model's judgment at the moment, new messages interrupt work
in progress, and the contexts of different tasks mix in one chat. The user also has to know
which Bot to ask and has to open parallel sessions by hand.

The article splits an always-on agent into a Router that only talks to people and dispatches
work, and Workers that each run one task in their own context. DS Bot already has a natural
Router: the Main Bot, whose rights are coordinating the team. Making the Main Bot the Router
keeps the team of named Bots: a Worker is not a generic session but a Bot with a role,
memory, model and browser, running one task.

The owner's setup sets the scope: the event sources are the kanban board (notes typed on
cards) and a private Telegram chat. Both are the owner's own and under their control, so
the design treats every incoming event as trusted. There is no GitHub, email or IM group
source.

## Decided behavior

### The user asks once, the right Bot answers

- The user talks to the Main Bot, in DS Bot or in Telegram, about anything. The Main Bot
  picks the Bot whose role fits and hands the request on. The user never has to pick a Bot
  or a session.
- The answer is written by the Bot that did the work. On the board and in DS Bot it carries
  that Bot's name; in Telegram the Main Bot relays it labelled with the Bot, for example
  `Researcher · LIFE-782: …` (the ticket key when the card has one, else its id).

### One Main Bot, and it routes everything

- A team has exactly one Main Bot, and it is the Router. Every request reaches it first,
  whether typed in its chat, in Telegram or in a group.
- Group admins no longer route: a group's plain message goes to the Main Bot, which hands it
  on like any other request.
- Naming a Bot with `@name` in a group skips the Main Bot: the user has routed it already. That
  Bot opens a card itself if the message turns out to be a task. Only messages that name no Bot
  go to the Main Bot.
- The group Goal is retired. A Goal is the admin breaking work into stages and handing them
  out; the Main Bot does not break work down, and every piece of work is a card instead.

### The Main Bot does not execute

- The Main Bot runs on a Router preset without shell, file-writing or other execution tools.
  It keeps the team tools (roster, Bot status, board, dispatch, memory and recall). The limit
  is structural, not a prompt rule: the article measured that a session allowed to do work
  often does it itself.
- Its replies are a dispatch or a short answer, never the work written out in prose. A long
  Main Bot reply is a signal to watch.
- It runs a strong model at low thinking effort by default (the per-Bot model setting), so
  routing is accurate and replies stay quick. Thinking effort is raised before the model is
  changed if routing goes wrong.
- Its context carries a short digest for routing: each Bot's role, its live status and its
  open cards, with IDs it can follow to read more.

### Tasks are cards, questions are not

- A **task** is anything worth tracking: it changes something, produces a deliverable, or
  needs real digging even when it only reads ("why is the build failing?"). It becomes a
  board card: the Main Bot opens it, names the assignee and hands it on.
- A **question** is answered in one quick turn and changes nothing. It is not a card. If the
  Main Bot can answer from what it can read (board, roster, memory), it answers. Otherwise it
  asks the right Bot and relays the answer.
- A Bot answers a relayed question in its main thread, so the answer draws on everything
  that Bot already knows. Its card threads are not interrupted.
- If a question turns out to need work, it becomes a card at that point.
- Every task is a card wherever it was asked. When the user gives a Bot a task in its own
  chat, that Bot opens the card itself, assigns itself and works on it in the card thread.
- The group task list (`group_task`) and the shared group to-dos are retired: they become
  cards, so "task" has one meaning.

### One card, one Card thread

- A Bot's conversation is a thread: a chain of parts, where a fresh part starts when the
  context fills and the earlier parts stay readable. A Bot has its main thread plus one card
  thread per open card.
- When a card starts, the assignee opens a card thread for it. The card's work, notes and
  questions stay in that thread; three cards on one Bot are three contexts, not one. A long
  card moves on to fresh parts inside its own thread like any other conversation.
- A note typed on the card goes straight to the card thread, without passing through the
  Main Bot (the article's subscription fast path).
- Something the user tells the Main Bot about an existing task is matched to its card by the
  Main Bot and passed on to the card thread (the slow path).
- The card thread closes when the card is done or cancelled. Its parts stay readable from the
  card.
- What the user reads on the card (notes, questions, replies) is the card conversation. It is
  separate from the card thread, which is the assignee's working context.
- The Main Bot reads the board for its overall view instead of keeping every task in its own
  context.

### Telegram

- The Telegram bot is bound to the Main Bot. It is the one voice on the user's phone.
- The Main Bot may push to its own bound Telegram chat without a Telegram message having
  started the turn, but only for: a card question (`ask`), a card moved to Review or Blocked,
  a card done or failed, progress on a long card, and a watchdog alert. Each push is short (about 100 words) and names the card
  (ticket key or id); the detail stays on the card. This changes the IM rule "a reply goes only to the
  source" for the Main Bot alone.
- Replying in Telegram to a message tagged with a card goes straight to that card thread,
  the same as a note typed on the card.

### The board watchdog

- On a schedule, the Main Bot checks the board for cards stuck in progress without
  progress, cards waiting in Review, and cards without an assignee. It tells the user only
  when something needs them.

## Build order

1. Router Main Bot: the preset, the routing prompt and the routing digest.
2. Card threads. The board is a plugin that reaches DS Bot only through seams, and
   `dsBotNotes.deliver` today targets a Bot's current chat or a group. This needs a new
   seam: open a thread for a card and deliver to it.
3. Telegram push and reply-to routing.
4. The board watchdog.

## As built

- Router Main Bot: `src/host/roster.js` keeps one Main Bot (a team saved with several keeps
  the first). `src/host/routing.js` masks `bash`, `write` and `edit` on the Main Bot's chat
  and group Sessions, and a tool guard refuses any other work tool (`apply_patch`, browser
  actions) with a pointer to the board. The mask moves when the role is handed over. The
  routing digest is a per-turn context only the Main Bot gets, and companions add lines to it
  through `dsBotRoster.addRoutingPart` (the board adds the open cards).
- Card threads: `src/host/threads.js` and `parts.js`. A card thread is an open part with the
  card id. It closes on complete, cancel, the user's cancel or a move to Done; a close during
  a running turn waits for that turn to end. Closed threads stay readable and searchable.
  Seams: `dsBotNotes.startCard`, `closeCard` (with `stop`: the reason, steered into a
  turn that still runs there), `deliver` with `cardId` (steers the thread), `cardBusy`
  and `tellCard`.
- Telegram: `dsBotNotes.push` sends to the Main Bot's own IM chats only. A reply to a pushed
  message goes to the card (a note, then the card thread). A reply to a push about something
  else goes to the Main Bot, marked as a reply.
- Board: a card for another Bot needs a brief, and opening it starts the assignee's card
  thread. `board note` passes the user's words on to a card. Pushes and the watchdog
  (stuck 3h, Review 24h, no assignee, and In progress with nothing running for 20 min:
  the Bot is nudged first, then the user is told) are in `src/board/watch.js`.
- Groups: in admin mode (the default) a plain message goes to the Main Bot when it is a
  member, otherwise to the admin as before. "Everyone" mode stays the user's explicit choice:
  every member answers. `@name` goes to that Bot. A group without the Main Bot keeps its
  admin first.
- The group Goal, `group_task` and `group_todo` are removed.
- Every card a Bot holds has a card thread, including one it opens for itself: `board open`
  needs a brief for any Bot assignee, and the opening thread is told to stop and tell the
  user in one line. Without card threads the Bot does the work where it is. A card for the
  user has no thread.
- A card that is open without a card thread (opened before card threads, or its thread
  failed to start) moves into one a minute after start (`adoptOnce` in
  `src/board/plugin.js`). Its brief is built by code, with no model call: the card's brief,
  status, progress, links and latest three notes, and where its earlier work is (the group
  or the Bot's own chat) to search with `read_group_chat` or `read_own_chat`. A waiting card
  (Review, Blocked) only confirms its state. `dsBotNotes.cardThread` tells whether a card
  has an open thread.
- The Main Bot's board rules: a follow-up about a card goes through `board note` to the card
  thread, never `@name` in a group or `message_bot`, also for a card that came from a group.
  A status question is answered from the card's status and progress first; only when that
  is not enough does a note go to the card, and the Main Bot does not wait for the answer.
  A Main Bot's note shows in the card conversation under its name.
- Follow-through, after three days of live use where the user asked "how is it going" about
  twelve times and a member Bot ran most of its commands in the group conversation:
  - A card that moves to Blocked pushes, with what it needs. A card older than 10 minutes
    pushes a new progress line, at most once per 30 minutes per card (the time of the last
    push is kept in memory, so a restart may push one line early). Every Bot's rules say to
    `board update` progress in one line at each step of a long card, and a wake from
    `wait_pane` on a card asks for it.
  - One open card per ticket. A title that starts with a ticket key (`LIFE-782: …`) sets the
    card's key, so a second card for the ticket is refused with the open card's id and a
    pointer to `board note`. A next step on a finished card's ticket is a new card whose
    brief names the finished one.
  - In a group, a member Bot (not the Main Bot) answers in a few lines; work that takes more
    than a quick look goes to a card it opens, and the group gets the card id.
  - Every Bot gets the bundled `herdr-panes` skill (`src/board/skill.js`): pick or start a
    pane, prompt it without `--wait`, `wait_pane` and end the turn, read the pane when woken.
    herdr's own skill stops outside a herdr pane, where a Bot always runs.

### Evaluation

- Offline A/B: `ds-bot/dev/routing-prompt.mjs` prints the Main Bot's real prompt, digest and
  tool set at any version, built from a fixed five-Bot team with the test fakes. The deploy
  side runs a fixed set of 24 requests (16 tasks with the expected Bot, 8 questions) through
  the same model at two versions, into the Langfuse dataset `ds-bot-routing`. Scores are
  deterministic: right Bot reached, work done by the Main Bot itself, brief present, board
  used, reply length.
- Live: the per-release health trace adds the Main Bot's work-tool calls per turn, its median
  reply length, cards opened and the share handed on to another Bot. Before this design
  (release 0.3.8) the Main Bot made 0.55 work-tool calls per turn, with replies of about 140
  words.

## Open questions

- Whether a relayed question runs under a read-only preset, so a question can never change
  anything and anything that would has to become a card.
- A checkpoint built by code for card threads, after dsh-fabric's deterministic compaction:
  goal, files changed, open items, status and the latest messages, rebuilt each time from the
  Session log with no model call, so it never becomes a summary of a summary. Today every
  checkpoint and handoff note is written by a model.

## Changes to decided designs

This note changes earlier decisions; each needs its note updated in the same merge.

- [Roles and permissions](2026-10-07-roles-and-permissions.md) and the [vision](../vision.md)
  (requirement 4): "there can be more than one Main Bot" becomes exactly one. A team that has
  several picks one; the others lose the Main Bot role.
- [Group chat](2026-10-07-group-chat.md): "admin answers first" is replaced by the Main Bot
  routing group messages.
- [Group chat task board](2026-11-12-group-task-board.md): `group_task` is retired; group tasks
  become cards.
- [Group Goal](2026-11-01-group-goal.md): retired, with the Goal check and its wake-ups.
- [Shared group to-dos](2026-11-10-group-todos.md): retired; to-dos become cards.
- [IM](2026-11-04-im.md): the Main Bot may push to its own Telegram chat (see Telegram above).

## Not done

- Listening to streams nobody addressed (IM groups, GitHub, email): the owner has no such
  sources.
- Defences against untrusted input: all sources are the owner's own.
- Running while the computer sleeps: events wait or are lost as today.
- Full-duplex Telegram: a Router that does no work keeps its turns short, so waiting for the
  current turn costs little.

## Known limits

- Routing quality depends on the Bots' role descriptions; vague roles route badly.
- One Main Bot is one queue: a burst of requests is batched into its next turn, not handled in
  parallel.
- The live metrics count the Sessions of the Bot that is Main now; a team that moved the role
  sees the old Main Bot's history under the new one.
