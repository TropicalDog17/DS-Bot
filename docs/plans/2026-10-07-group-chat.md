# Group chat

- Date: 2026-10-07 decided on speaking in order and group management; adjusted several times since,
  see "Changes" at the end
- Related: #129, PR #19, PR #175, PR #79, PR #180

## Why

Group chat is the main way several Bots work together. It has two basic problems:

1. **Coordination.** Early on, members wrote in parallel and checked for new messages before they
   sent. Even counting off went wrong: the model kept the broken numbers and sent them anyway. The
   model cannot do the ordering well. So in a discussion (plain messages that everyone answers in
   turn) **only one member speaks at a time**, and each member reads the latest group before it
   speaks. Handing out work cannot queue, though: when one message names several members, they must
   start at the same time, or the group loses the point of several Bots working together.
2. **Cost.** Every member that is called runs the model once with the whole context of its Session.
   The cost grows linearly with the number of speakers, with a large factor. So by default few
   members are called: a plain message goes to the admin first, and the admin decides whom to call.

Also, when a member gets a long task in a group, the user must not face a page that does not move
(a "black box"), and finished results must not get lost.

## Decided behavior

### Who answers

- A group has two answer modes:
  - **Admin answers first** (the default for a new group): a plain message without `@` goes only to
    the Main Bot when it is a member, which answers a quick question or hands the work on as a card
    (see [Main Bot as the team's Router](2026-11-22-main-bot-router.md)). In a group without the Main Bot it goes to the admin, and the admin calls other
    members with `@name`.
  - **Everyone in turn**: each member answers a plain message in order, the admin first.
  - A group without an admin answers as "everyone in turn".
- `@name` calls only the named member. `@all`, `@everyone`, `@所有人` ("everyone") and `@全体` ("all")
  call every member. In a member's reply these words count only when the admin says them, so that
  members cannot wake a whole crowd for each other.
- Members named in the same message start at the same time: a user's `@` message, several members
  named in a member's reply, `@all`. Whoever is ready first posts first. Members called together do
  not see each other's answers for this turn; the prompt says who else is answering at the same time.
  When one member needs another's result, use a relay: call one member first and have it `@` the
  next one when it is done.
- An `@` takes effect as soon as it is posted: the members named in what a member says while it
  works, in its final reply, or in a post a Bot makes during a turn start right away. They do not
  wait for the speaker to finish.
- What the user says during a turn goes into the group at once and goes to whoever it should call
  (the admin in admin mode). It does not queue behind the member that is answering.
- A member answers only one message that calls it at a time. It starts the next one when the
  previous answer is done (or has moved to background work).
- A plain message for everyone in turn (without `@`) still goes in order: the next member starts
  when the previous one has posted (or passed). Each member sees everything said before it in this
  turn and its own place in the order.
- When a reply `@`s someone, that member speaks next (a relay). A relay with real progress (tool
  calls, new content) has no limit. It pauses only when Bots go 6 rounds in a row with 0 tool calls
  and only repeat themselves, post polite acknowledgements, or post status posts such as "nothing
  pending / standing by" that `@` nobody. The group then shows why it stopped. The calls that were
  stopped go on only after the user writes; a Bot's post or a late reply does not release them. The
  count belongs to the group: each 0-tool turn of a Bot counts once, and the post that opens a turn
  does not count on its own (so in an everyone-in-turn round, three members each replying one line
  is three). When a stage of work is done, a status post from a Bot neither adds a round nor calls
  other members. Calls suppressed while the group is stopped are parked until the user writes. Tool
  calls and real content reset the count only while the group has not stopped yet, which avoids
  stopping by mistake (#853). To stop the work in a group, the user clicks "Stop all" in the group
  details, or stops members one by one.
- Every member can pass (`[PASS]`) and need not speak every turn. If a member called to do work
  only replies "Got it / checking now" and ends its turn without calling any tool, the host posts
  that line to the group as progress and pushes it once more on the same call, so that it calls the
  tools and finishes the work (#469). If that line was already a complete answer, the member replies
  `[PASS]`, and the group does not show it twice. A line that says the work is already done, such as
  "checked it" or "handled it", gets no push.

### Mentions

- Only `@name` counts as a mention, and only it renders as a link with an avatar. A name without
  `@` is plain text. The client and the server use the same rule (`ds-bot/src/shared/mentions.js`).
- An `@` after a letter, a digit, `_` or `.` (an email or other address) does not count. A name
  followed right away by a letter, a digit, `_` or `-` (a longer word) does not count. Mentions in
  code, links and quotes do not count. Names are case-insensitive, and longer names match first.
- `all`, `everyone`, `所有人` ("everyone") and `全体` ("all") cannot be Bot names.
- The `@` menu in the input box lists Bots first (in a group: the members and "Everyone"; in a
  private chat: the other Bots). Quoting other conversations is under "+".

### Turns that Bots start, and limits

- A Main Bot can post to any group, and other Bots can post to the groups they are in
  (`post_to_group`). The Bot that posts does not take part in answering.
- Posts from a Main Bot or the admin call members by "Who answers". A post from another member calls
  only the members it names with `@name`; `@all` and the like do not count. If it names nobody, the
  post only goes into the group and nobody answers. If the same relay carries other messages, those
  messages pick the members.
- Turns that Bots start and Bot messages across the team are not counted (see
  [Handing work between Bots](2026-10-16-bot-handoffs.md)). Bots are told not to send thanks or
  acknowledgements, and not to reply to a reply.
- When a Bot posts for work another Bot handed it and must report back (`report_back`), this turn is
  work under that work: its reply to the Bot that handed it the work waits until the report is
  delivered.

### Progress during work, and late replies

- When a member gets a task in a group that needs work, and it is still working 15 seconds after its
  first tool call, the turn moves on and stops waiting for it.
- While it works, its first line and every line with an `@` go to the group at once. Lines less than
  30 seconds apart are merged into one post. Bot group posts, progress and completion messages that
  come in during a turn are handled as part of the current turn and are no longer added to the group
  Session's outgoing queue (#663).
- Handed-out work is collected per batch. Whether a named member finishes within 15 seconds or
  after, and whether or not its reply has a hand-written `@` for the Bot that handed out the work,
  once it has called tools and finished, it counts as a finished item of that batch. When one
  message names several members in parallel, each one's finishing line goes to the group at once,
  and the Bot that handed out the work is woken once, when the whole batch has landed (#619). If that
  Bot is still in its own turn, it is called when that turn ends. For a member the user called
  directly, the result is for the user, and the admin is not called as well. A member that needs the
  admin to decide writes `@admin`.
- A reply that finishes after the turn has ended still goes to the group, and the members it calls
  still speak next.
- The answer timeout (4 minutes) runs only while the member's Session shows no activity at all. A
  member that did not answer in time, or needs an approval, leaves a faint event line in the group,
  so that the user knows what happened.

### Approvals and status

- Approval requests from members in a group (for example for raised rights) are brought into the
  group by DS Bot. The status pill above the input box lists the busy members, with the ones waiting
  for approval first. In the group details the user can choose "Allow once" or "Deny". A member that
  needs an approval gives up its turn to speak at once.
- While a DSH subagent (`subagent`) that a member started in a group is running, the member stays
  busy in the group and counts in the work batch, even if its own turn ended first. "Stop all" and a
  single member's "Stop" in the group details also interrupt the subagent and ignore its later
  completion notices (#701).
- While a member is working in this group (including waiting for approval or running a subagent),
  the title of the member list in the group details has a "Stop all" button. It stops the turn
  running in this group and every member's work in this group in one go. Each stopped member leaves
  a line in the group saying it was stopped. Their work in private chats and other groups goes on.
  DSH's own stop stops only this turn; it cannot reach members still working after the turn has let
  go. In the group details they can still be stopped one by one.
- A group's work folder and shared permissions are group settings; see
  [Roles and permissions](2026-10-07-roles-and-permissions.md).
- A group's own Session is made of parts, like a Bot's private chat: the group's identity (the group
  id) stays the same, and the current part is the latest one. When the group's work folder changes,
  the group moves on its next turn to a part opened in the new folder, and the group's files panel
  then shows the group folder. Earlier parts are archived and can still be read by scrolling back in
  the group. In a group without its own folder, a folder a member switches to with
  `working_directory` applies only to this group; it does not change this Bot's private chat or
  other groups.

### Group settings

- When the user creates a group without a first message, the admin first says hello and asks what
  the group is for. Not when a Main Bot creates the group with a tool.
- The group notice (at most 2000 characters) goes into the prompt for every reply. A group has at
  most 12 members. Group names must be unique (at most 60 characters); a group without a name shows
  its members' names.
- A Main Bot can see every group; other Bots can see only the groups they are in.
- A message sent with `message_bot` in a private chat goes only into the other Bot's private chat;
  that Bot's work in groups is not affected.

### One piece of work has one place

- Work in a group stays in the group. Calling a member of this group with `message_bot` from the
  group is the same as writing `@name` in a reply: the line is posted to the group, the member does
  the work in the group, the Bot that handed out the work takes the result, and the member's private
  chat gets nothing.
- Calling a Bot outside the group with `message_bot` from a group is refused by the tool, with a hint
  to add it to the group first (a Main Bot or the admin can add members with `update_group`, and the
  group shows this step).
- If a Bot names another Bot with `post_to_group` in a private chat and then hands it work with
  `message_bot` in the same turn, the tool refuses: one piece of work takes one route.

## Not done

- No speaking in parallel and checking for conflicts afterwards.
- No multi-round discussion that "goes round until nobody speaks": every message would cost a whole
  extra round of passes. When a discussion is needed, use an `@` relay.
- A member does not hold the turn to speak during a long task: long work is done in the background
  and reported to the group afterwards.

## Known limits

- DSH's "conversation" quote group still shows in the `@` menu; typing `@name` in a group and
  pressing Enter right away may pick it (C3).

## Changes

- 2026-10-08: A plain message goes to the admin first by default (fewer members called); a group has
  its own Session.
- 2026-10-10: Mentions only count as `@name`; in a new group the admin says hello first.
- 2026-10-11: The `@` menu lists Bots first; quoting conversations moved under "+" (PR #19).
- 2026-10-12: Approvals in groups, the status pill, the timeout counts only time without activity,
  late replies are still posted (PR #79).
- 2026-10-13: A limit of 40 Bot messages across the team (#129).
- 2026-10-14: Progress during work goes to the group, and the Bot that handed out the work takes the
  result (PR #175); shared permissions for a group (PR #180).
- 2026-10-16: Work in a group stays in the group: `message_bot` in a group only calls members of this
  group and is the same as `@name` (#165).
- 2026-10-16: Removed the limits of 3 turns per Bot in a group and 40 messages across the team; posts
  that must report back go into the handoff tree (#262).
- 2026-10-18: Other members can also post to the groups they are in, calling only the members they
  `@` (#198).
- 2026-10-22: Removed the limits per member per turn, per turn in total and of 10 late replies in a
  group. A relay between Bots pauses at the group's limit and goes on when the user clicks "Continue"
  or writes; a user's `@` always gets an answer (#395).
- 2026-10-29: A group's stop button stops this group's turn and all members' work in this group in
  one go. It sits beside the title of the member list in the group details, not beside the status
  pill (#592, PR #616).
- 2026-10-30: Removed the limit on relays between Bots, its group setting and the "Continue" button;
  calls that had stopped at the limit go on in the group's next turn (#655).
- 2026-10-30: Members named in the same message start at the same time, an `@` takes effect as soon
  as it is posted, and during a turn the user's messages and Bot posts go to the right members at
  once. Only plain messages for everyone in turn still go in order (#726).
- 2026-10-31: Handed-out work is collected per batch, and the Bot that handed it out is woken once
  when the whole batch has landed (#619). A turn that only says "got it / starting" without calling
  tools gets one automatic push (#469). 6 rounds in a row of 0-tool repeats or polite idling pause the
  group automatically. Group posts already taken in during a turn are no longer added to the group
  Session's outgoing queue (#663). DSH subagents started by group members count in the group's busy
  state and stop controls (#701).
- 2026-11-01: A group's own Session also moves on in parts; changing the group folder moves to a new
  part in the group folder. A folder a member switches to in a group applies only to that group
  (#277).
- 2026-11-03: If the Bot that handed out the work is still in its own turn when the batch lands, it is
  called when that turn ends. Removed calling the admin on words like "needs a decision". A push can
  be answered with `[PASS]`, and a line that says the work is done gets no push. Calls stopped by the
  idle guard go on only after the user writes, and the notice says the Bots went back and forth
  without progress (#872).
- 2026-11-07: Status posts that `@` nobody and carry no tools, such as "nothing pending / standing by
  / waiting for the next step", count for the idle guard. The count is per group: each 0-tool turn
  of a Bot counts once, and the post that opens a turn does not count on its own. After 6 the group
  no longer starts turns on its own. All calls suppressed while it is stopped (including `@all`) are
  parked until the user writes, and only the user's message releases them. The group shows a line
  with the reason it stopped (#853).
- 2026-11-10: Every message in a group is first written to the group's ledger, and the interface,
  the members and memory upkeep all read from the ledger. Work batches are saved to disk and survive
  a restart ([Message ledger](2026-11-10-message-ledger.md), #1316).
- 2026-11-10: DS Bot runs a turn itself, no longer inside the `group_relay` call. Messages the user
  sends during a turn join that turn. Old PTC groups no longer have a limit of about 10 minutes per
  turn ([Message ledger](2026-11-10-message-ledger.md), #1316).
- 2026-11-23: in admin mode a plain message goes to the Main Bot when it is a member; the admin answers first only in groups without it ([Main Bot as the team's Router](2026-11-22-main-bot-router.md)).
