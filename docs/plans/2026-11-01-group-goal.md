# Group chat Goal

- Date: 2026-11-01
- Related: #791; group chat design [2026-10-07-group-chat](2026-10-07-group-chat.md), Bot handoffs
  [2026-10-16-bot-handoffs](2026-10-16-bot-handoffs.md)

## Why

When a group has to finish something big, chat alone falls apart easily: which step the work is at,
who owns which part and whether it is done can only be guessed from the chat history, and a long
task easily drifts along the way.

A group chat Goal makes "one thing to get done" first-class state of the group. The admin first
aligns with the user, writes a Goal with a way to check it, splits it into stages and hands each
stage's tasks to members. Each stage must pass its check before the next one starts, until the whole
Goal passes its final check. The user can pause, correct course, resume or stop at any time.

The Goal belongs to the group and lives in DS Bot's own state (`room.goal`), not in DSH's
Session-level Goal: the group's own Session does not call the model, and members' group Sessions
move on to new parts. A Session-level Goal cannot survive either of these.

## Decided behavior

### States

There is only one `room.goal` at a time. States:

| State | Meaning |
|---|---|
| `drafting` | The admin is aligning with the user; the Goal is not written yet |
| `active` | Running; `current` points to the current stage |
| `paused` | Paused by the user or the admin: no stage moves forward and the admin is not woken automatically; work already started finishes as usual |
| `complete` | All stages passed and the admin did the final check |
| `stopped` | Stopped |

`complete` and `stopped` stay in the group until the user clears them or starts a new Goal; the old
Goal moves into `room.pastGoals` (the last 5 are kept).

A Goal has: a title, an objective, a final check (acceptance: how to check it is done, such as
commands, tests, files and evidence to look at), constraints (including the user's corrections along
the way) and a list of stages. Each stage has a title, a stage check and a list of tasks; each task
goes to one member. Task states: `pending` (not started) → `working` (the admin has `@`ed the member)
→ `reported` (the member handed in its result) → `done` (the stage passed). Stage states: `pending`
→ `active` → `passed`.

### Who can change it

- The group admin and a Main Bot write and advance the Goal with the `group_goal` tool. Other members
  can only look at it with `show`; to change it, they tell the admin in the group.
- A group without an admin cannot start a Goal: set an admin with `update_group` first.
- The user pauses, resumes, stops and clears in the interface, or says so in the group, and the admin
  calls the tool.

### Aligning (before the Goal is written)

Two ways in:

1. The user tells the admin in the group what to achieve.
2. The user clicks "Set a goal" in the group details or under "+" in the input box and writes one
   line. This line goes into the group as a user message, and the Goal enters `drafting`.

During `drafting` the admin aligns with the user by the bundled skill `goal-grill`. Facts that can be
found in files, code or records it looks up itself, or `@`s a member to look up, instead of asking
the user. Only the forks that really need the user's decision are put into one round of numbered
questions, each with a recommended answer. When the user has answered, the admin writes the Goal.
When the request is already clear, it can write the Goal right away.

### Running

- After `start`, the first stage becomes the current stage. The admin hands out this stage's tasks
  with `@member` in its reply, and the members named in the same message start at the same time.
- When all members have handed in (the group chat's work batch: the admin is woken once, when the
  last one hands in), the admin checks the results against the stage check, and can also `@` a
  reviewing member to verify them.
  - Passed: `pass`, which must carry evidence (test output, which files changed, check results); the
    tool refuses it without evidence. The next stage becomes the current stage, and the admin hands
    out the next stage in the same reply.
  - Not passed: `rework`, saying what is missing. The tasks go back to not started, and the admin
    `@`s the members again.
- After the last stage passes, the admin checks against the final check, and `complete` carries the
  evidence and a summary for the user.

### Staying aligned

Every time a member speaks in the group, the prompt for that turn carries a `<group_goal>` block:

- The admin: the full ledger: objective, final check, constraints, the state of every stage and
  task, the latest rework notes and corrections, and what to do now.
- Other members: objective, constraints, the current stage and its check, and the tasks given to
  that member; they are asked to hand in results with evidence.

This block is in each turn's group message, not in the system prompt, so it does not affect the
prompt prefix cache.

When the user corrects course, the admin first changes the Goal with `revise` (giving the reason)
and then goes on. Stages already passed are kept; stages from the current one on can be reordered
and reassigned.

### Moving forward on its own

When a turn ends, if the Goal is running and no member or subagent in the group is still working,
DS Bot wakes the admin once (a "Goal check") to take the next step: hand out tasks not yet done,
check a stage that was handed in, or do the final check.

- When the admin is waiting for the user, it replies `[PASS]`. The Goal is marked "waiting for you"
  and the admin is not woken again.
- After two wake-ups in a row without progress (the Goal did not change, no member used tools, the
  user said nothing), the Goal is also marked "waiting for you".
- When the user says something in the group, or the Goal changes, "waiting for you" is cleared and
  automatic progress resumes.
- No wake-ups while paused; when the user clicks "Resume", the admin is woken once.

### Pause and stop

- Pausing only stops progress: the admin no longer hands out work or passes stages; member turns
  already running finish as usual. The pause panel also has "Stop current work too", which is the
  same as "Stop all" in the group details.
- What the user says in the group while paused still goes to the admin, and the admin writes the
  correction into the Goal with `revise`.
- Stop: the Goal is marked `stopped`, and all work in progress in the group stops too.

### Interface

- The "dynamic island" at the top of the group chat (the pill in the conversation header) is the
  Goal's status screen. When there is a Goal, the pill grows longer and normally shows the Goal's
  short title and "current stage/total". Only on hover (or keyboard focus) does it switch back to the
  group name and the arrow that opens the details.
- Below the pill hangs a pod of one piece with it, as wide as the pill and forming one surface. It
  shows the current stage's title (or "Setting a goal", "Paused · stage name", "Checking · stage
  name", "Waiting for you · stage name", "Goal reached", "Stopped", "Final check"), a stage progress
  bar and the avatar states of this stage's members. When the panel is open, the progress bar and
  avatars fold away, leaving only the dot, the title and the arrow.
- Clicking the pod springs the same surface open into a panel focused on the selected stage. At the
  top is a row of step dots, one per stage (a green check for passed, an outlined number for the
  current one, hollow for ones not reached). Clicking a stage shows only its check, rework history,
  evidence and assignments below; when another stage is selected, the title row offers "Back to
  current stage". The bottom row has "Goal and checks" on the left, which expands the full Goal, the
  final check and the constraints, and buttons on the right: pause / stop while running (click again
  to confirm), plus "Stop current work too" and resume while paused, clear after completion or stop,
  and cancel while aligning.
- Stages are no longer drawn as separate cards: state is shown only by shape (the color of the step
  dots), and task state only on the avatars (spinning while working, a green check when handed in,
  half-transparent when not started).
- The group's conversation records Goal changes as event lines: set, stage passed, rework, revised,
  paused, resumed, complete, stopped.

## Not done

- No Goal in a single Bot's private chat (the data structure does not rule it out later).
- Bot Sessions do not run DSH's Session-level Goal. When the desktop app starts, it removes the goal
  command and tools from the preset (the goal bar above the input box stays, and DSH goals left from
  before can still be paused and cleared). In the plugin, `/goal` is still in the "/" menu (DSH has
  no interface to remove a command per Session); using it is blocked with a hint to use "Set a goal".
- No limit on rounds or duration; the only guard against idling is "stop and wait for the user when
  there is no progress".
- Stages move forward in order, with no parallel stages; tasks in the same stage can run at the same
  time.

## Known limits

- The admin and the reviewing members check the evidence; DS Bot does not run the check commands
  itself.
- After DSH restarts, the Goal does not resume progress on its own: the next time someone speaks in
  the group, or the interrupted work resumes, automatic progress picks up as usual.

## Changes

- 2026-11-01: The panel now focuses on one stage (step dots + selected stage + bottom-row buttons);
  removed the panel header and colored labels. When the desktop app starts, it removes DSH's goal
  command and tools; the plugin's `/goal` hint now points to "Set a goal".
