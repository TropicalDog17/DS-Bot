# Group chat task board

- Date: 2026-11-12
- Related: Issue #1441

## Why

Several Bots can be working in one group at the same time, and messages scroll by fast;
the user cannot tell from the chat who is doing what or how far they are. Handed-out work,
progress and results are scattered through the chat history, and to add a requirement the
user has to scroll back to find the right message. The task board is the group's own
answer: one row per task, registered explicitly by the Bot doing the work, shown in the
group details drawer.

## Decided behavior

- A task belongs to one group and one member. Fields: id, member, one-sentence goal,
  status, start and last update time, latest progress, result summary, user notes.
- Status: `active` in progress, `review` waiting for review, `blocked` blocked, `done`
  done, `cancelled` cancelled. The first three count as in progress; the last two go into
  history.
- A Bot registers its own tasks with the new `group_task` tool: `open` when it takes on
  work, `update` while it works, `complete` with a one-sentence result summary when done,
  `cancel` when it stops, and `show` to see the current board. Registration must be
  explicit; nothing is parsed from chat messages.
- Only the Bot that registered a task can update or complete it. Group admins and Main
  Bots can cancel other members' tasks, and a task's owner can always cancel its own.
- The user does not change status on the board directly. Adding a note (an extra
  requirement or a changed goal) records the note on the task and sends it into the group
  as a user message `@owner …`; the group engine calls the matching Bot, which receives it
  in the Session where it is working. Cancel on the board is the board's own action.
- Tasks are stored in `room.tasks`, in the same room object as the group goal, group
  memory and work folder, and are saved with `state.json`: deleting the group removes
  them, and after a restart they are still there, like the group itself.
- Done and cancelled tasks are final and cannot be updated or completed again; history is
  not deleted automatically by count. All text is squeezed into one line: goal 200,
  progress 300, result 2000, note 500, cancel reason 500 characters.
- The board is in the group's details drawer: in-progress tasks first (member, status,
  goal, latest progress, start time), and history can be expanded to show the result
  summary or cancel reason. The board reads the same state the rest of the app reads, so
  when a Bot changes status the board follows without a page refresh.

## Not done

- No board across groups, no hours or time tracking, no showing code changes (that is
  #1446).
- No parsing chat messages to guess tasks and status.

## Known limits

- Only Bots can open tasks; to hand out work, the user still says so in the group and the
  Bot registers it.
- A note is sent as an `@owner` message, so the group engine calls members by its @ rules.
  If the group is paused or stopped at that moment, the message stays in the group until it
  resumes.
- History is kept with the group data and is deleted only when the group is deleted.
