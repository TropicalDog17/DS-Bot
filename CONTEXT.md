# DS Bot

A persistent team of Bots that the user works with: the Main Bot takes the user's requests and hands them to the Bot whose role fits, and each piece of work is tracked on the user's board.

## Language

### The team

**Bot**:
A long-lived identity with a name, a role, instructions, a model and its own memory, that talks and does work.
_Avoid_: agent, assistant, worker

**Main Bot**:
The one Bot in a team that receives every Request, tells Questions from Tasks and hands each to the right Bot; it holds team-wide rights and does no work itself.
_Avoid_: Router, dispatcher, orchestrator, admin, lead

### Requests

**Request**:
Anything the user asks the Main Bot, in DS Bot or in Telegram.
_Avoid_: prompt, command

**Question**:
A Request answered in one quick turn without changing anything. It is never a Card.
_Avoid_: quick ask, query

**Task**:
A Request worth tracking: it changes something, produces a deliverable, or needs real digging even when it only reads. Every Task is a Card, wherever it was asked.
_Avoid_: job, ticket, group task, to-do, goal

**Dispatch**:
The Main Bot handing a Request to the Bot that will answer or do it.
_Avoid_: handoff, delegation, forward

### The board

**Card**:
The board's record of one Task, with one Assignee and a status column.
_Avoid_: ticket, thread, task (for the record itself)

**Assignee**:
The one Bot that does a Card's Task.
_Avoid_: owner, worker

**Need**:
What the user must do for a Card that waits on them (in Review or Blocked), with where to do it. It goes when the Card moves on.

**Note**:
What the user writes on a Card for its Assignee, or what the Main Bot passes on there from the user; it reaches the Card thread.
_Avoid_: comment, message, @mention (for work on a Card)

**Card conversation**:
The Notes, questions and replies shown on a Card; what the user reads, not the Assignee's working context.
_Avoid_: card thread, card history

### Conversations

**Part**:
One stretch of a Bot's conversation with its own context; a long conversation moves on to a fresh Part and the earlier ones stay readable.
_Avoid_: session (outside DSH internals), segment

**Thread**:
A chain of Parts that make up one conversation of a Bot. A Bot has one main Thread and one Card thread per open Card.
_Avoid_: session, chat (for the chain)

**Card thread**:
The Thread an Assignee keeps for one Card's work only. Every Card a Bot holds has one, also a Card it opened for itself.
_Avoid_: card part, worker session, task session

**Push**:
A message the Main Bot sends to the user's Telegram without the user having asked in that turn.
_Avoid_: notification, alert
