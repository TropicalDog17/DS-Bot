# Main Bot as the team's Router

- Date: 2026-11-22 (draft, under discussion)
- Related: DSH article "Exploring Super-agent Design" (DeepSeek Harness, 2026-11-01);
  [Board plugin](2026-11-19-board-plugin.md), [Two sessions of one Bot](2026-11-13-parallel-sessions.md),
  [IM](2026-11-04-im.md), [Roles and permissions](2026-10-07-roles-and-permissions.md)
- Code: not started

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
  started the turn, but only for: a card question (`ask`), a card moved to Review, a card done
  or failed, and a watchdog alert. Each push is short (about 100 words) and names the card
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
