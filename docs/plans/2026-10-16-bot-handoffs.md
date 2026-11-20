# Handing work between Bots: status, merging and the handoff tree

- Date: 2026-10-16
- Related: #262; replaces the unread limit of #95 (PR #136), the hop limit and the team-wide limit of 40
  messages of #129 (PR #166), and the limit of at most 3 rounds a Bot can start in a group; for work in
  groups see #165 (PR #257)
- Changed together with: [Group chat](2026-10-07-group-chat.md), "Turns that Bots start, and limits"

## Why

Handing work between Bots used to be limited by counts, without looking at the other Bot's status:

- **A Bot cannot see what the other Bot is doing.** DS Bot records each Bot's status for the interface,
  but `list_bots` only gives name, role, model and folder. Only after `message_bot` has sent does the
  result say a sentence or two (busy / waiting for approval / some unread). #95: five messages in a row,
  five "delivered", zero replies.
- **Refused because the other Bot has not read.** When the other Bot has 10 unread messages,
  `message_bot` refuses to send, and the sender does not know why they were not read.
- **Flooding is limited by length and total.** A message chain is cut at 6 hops; after the user last
  spoke, the whole team can send at most 40 messages; a Bot can start at most 3 rounds in a group.
  Count limits cannot tell normal work from spinning: a long handoff chain where every step goes to a
  new Bot and produces a result is cut at hand 7; an A→B→A loop only stops after a full 6 hands; a busy
  team hits 40 messages.

- **Results of handed-off work do not come back.** When B hands part of the work to C and ends its turn,
  B's "handed to C" goes to A as the reply right away, and the exchange is over. When C's result comes
  back to B, what B says in that turn goes to no one; B can only send A a new message. So A never gets
  the final result, or Bots send each other one follow-up message after another.

Trade-offs:

- Status is a fact; Bots judge it themselves. The system only blocks where the structure makes a correct
  result impossible.
- Handed-off work is a tree: while work below has not come back, the reply above waits; when work below
  comes back, the Bot above continues, and when it is done it passes its result up together with the
  results from below. Results travel up on their own, so Bots need not send follow-up messages
  upstream, and no hop or message counts are needed to prevent loops.
- The only thing to block: messaging a Bot that is waiting for the result of this work. That is a loop,
  and it is pointless, since the result goes up anyway. The same Bot may appear several times in one
  piece of work, as long as it is not waiting for that work.
- The root cause of piling up is one sender sending message after message to a Bot that cannot read
  them. Merging the unread ones into one stops the pile-up, so no limit is needed.
- No fallback limit: the user can see what each Bot is doing and can stop it at any time.
- Based on how OpenMausBot and Hermes Agent do it: the first gives `list_bots` status, makes handed-off
  work a tree, wakes the handing Bot automatically with the result, and forbids handing work back
  upstream; the second makes work cards on a board, with the status on the card. Neither limits handoffs
  between Bots by total or chain length.

## Decided behavior

### Status

- Each Bot's status is one of the following, the first that applies from top to bottom:

  | Status | Condition | Extra information |
  |---|---|---|
  | Waiting for user approval | Has a request waiting for approval | Where, and for how long |
  | Moving to a new Session | Writing a handoff and moving to a new part | Where |
  | Working | Has a running turn in its own chat or a group | Where (own chat or which group), for how long, what it is doing (the tool and the file, search or website it is working on, or what it just said), and for whom (the user, or the Bot that handed it the work) |
  | Waiting for another Bot | Has a piece of work waiting for work it handed off to come back | Whom it waits for (Bot or group), and for whom it works |
  | Idle | None of these | — |

- Two more items are given with the status:
  - An unanswered question card: waiting for the user to answer.
  - Unread Bot messages in the inbox, as a count per sender.
- `list_bots` gives one line per Bot, with the status and these two items.
- The result of `message_bot` includes the other Bot's status at send time.
- Status is not written into the system prompt: the system prompt must stay byte for byte stable to
  reuse the cache. A Bot that wants to see status calls `list_bots`.
- In the interface, the Bot's character animation shows its status (sidebar, chat title, details
  panel):
  - Working, waiting for approval, moving to a new Session: as before (by tool: thinking, searching,
    working, messaging; waiting for approval jumps with a "?").
  - Waiting for another Bot: no turn is running, but handed-off work has not come back. The character
    sways left and right with circling eyes, as when coordinating teammates (in line with Grok Bot: the
    same motion for waiting and for waiting on subtasks); no green "working" dot, because no turn is
    running. The sidebar row says "Waiting for X".
  - While a turn is running, the turn's status is shown; waiting for approval or a question card comes
    before waiting for another Bot.

### Unread messages are merged into one

- When X sends Y a message, and X sends another before Y has read the first, and both belong to the same
  piece of X's work (or neither belongs to any work): the two are merged into one, the original first and
  the new one after. It is still the same exchange; Y reads one message and answers both with one reply.
- If one of the two interrupts the current work (`when: "now"`), the merged message interrupts the
  current work; otherwise it queues after the current work.
- The merged message is stored and delivered by the rules of
  [Long messages](2026-10-16-long-messages.md).
- The result tells X: Y has not read the previous one, they have been merged, and Y's current status.
- If Y has already read it (the message went into a turn Y is running), X's next message is a new
  message, as before.
- So each sender has at most one unread message in an inbox, and there is no unread limit any more.

### Request identity (request_id)

- `message_bot` gains an optional parameter `request_id`: the sender names its own piece of work. The
  same name with the same content is the same piece of work.
- The name belongs to the sender: its scope is "sending Bot + where it speaks (own chat or which group)
  + name". Someone else using the same name is a different piece of work; a Bot that moves to a new
  conversation part (the Session parts in `state.json`) keeps the same name; a Bot that is deleted and
  created again gets a new id, so its names are new too and do not mix with old work.
- What is recorded is the request itself: a fingerprint of the recipient (by id), the body (outer
  whitespace trimmed, line breaks normalized), `reply_to` and `when`.
- Results:
  - Same name, same content: not sent again; the first receipt is returned as is.
  - Same name, different content: refused, not sent. A name is the name of one piece of work, not a
    template.
  - No name: as before, nothing is recorded or blocked.
- The receipt is written into `state.json` before the message is sent: so after a restart, or after the
  other Bot has read the message, a retry only gets the original receipt back and does not send again.
- No resend when the outcome is uncertain: if sending fails midway, or DS Bot stops after the message
  went out, the outcome of this attempt is "unknown". The tool tells the sender that it was not sent
  again, and to check first whether the other Bot received it rather than send again with the same name.
- The same holds in groups: calling someone with `message_bot` in a group posts an `@name` in the
  group, and the same name is not posted twice. Merging unread messages works the same way: the merge
  belongs to the first piece of work, and each keeps its own receipt.
- Request identities and receipts are kept with the team and are not dropped automatically by age or
  count. Otherwise a retry of an old request would be taken as new work and done twice. To do the same
  work again, the caller chooses a new `request_id` explicitly; archiving or cleaning up receipts is a
  separate design.

### The handoff tree

- A piece of work: a message one Bot sends another with `message_bot` that asks for a reply (those with
  `reply_to: "user"` do not count). Work that B hands off in the turn where it answers A's work, and in
  later turns where it continues that work, is work below this piece of work.
- When the turn in which B answers this work ends:
  - All work below has come back (or none was handed off): what B said in this turn goes back to A, as
    before.
  - Some work below has not come back: nothing goes back yet. B's status is then "Waiting for another
    Bot".
- When a piece of work below comes back, B continues the work above, and the message it receives says
  which work it is for and for whom. When that turn ends, it checks again: if everything has come back,
  the result goes to A; if not, it keeps waiting.
- The reply to A is what B said in its last turn, followed by every result that came back from below for
  this work (who returned it, and the original text), delivered by the rules of
  [Long messages](2026-10-16-long-messages.md). If B said nothing in its last turn, the last text B said
  for this work is used; if B never said anything for this work, the reply says B finished with no reply.
- If a result from below is read in another of B's turns (for example together with a message from the
  user): that turn ends as usual, and afterwards the result is delivered to B once more on its own, so B
  continues the work above.
- Work below that fails (the other Bot's model call fails), is stopped, or whose Bot is deleted also
  counts as returned, and the result says so.
- If the turn answering this work is stopped (by the user, or by `stop_bot`): A is told at once "B was
  stopped" and no longer waits for the work below; work below that comes back later goes only to B and
  no further up.
- Wait relations are stored in `state.json`, so waiting continues after DSH restarts.
- Groups:
  - When B posts with `post_to_group` for this work and asks for a report (`report_back`), that round is
    also work below; when the group's report comes back, B continues.
  - Posts that do not ask for a report are not waited for.
  - An `@` in a group, and `message_bot` called in a group (the same as an `@`, see group chat), are not
    part of the handoff tree and follow the group chat rules.

### Giving up a wait

- While a Bot waits for handed-off work, the right-click menu of the Bot in the sidebar shows
  "Give up waiting for <name>". It appears only when this Bot really is waiting, with one item per branch
  when it waits for several. Giving up goes through the client's existing action → host channel and does
  not change the ledger structure.
- Giving up settles only the child work that was clicked: it goes back to the work above as an explicit
  result that says "no receipt from the other side, the wait was given up", so the Bot above continues
  its work; other unanswered branches of the same work are not touched, and in a multi-level chain it is
  settled upward only once.
- A real receipt that arrives late does not create a second result and does not put the Bot back into
  waiting; its content is delivered as usual, marked as belonging to a wait that was given up.
- At restart DS Bot reconciles: an unanswered wait whose target Bot, group chat or subagent Session no
  longer exists is settled through the same give-up path; a wait whose target still exists but has not
  returned a receipt is never given up automatically. After giving up, the child work is gone from
  `state.json` and the work above carries that result, so a restart does not roll it back.
- No automatic timeout: no TTL, and no change to the timing or delivery order of normal handoffs.

### No messages to a Bot that waits for the result

- When X, while doing a piece of work, uses `message_bot` to message a Bot that is waiting for the result
  of this work (the Bot that handed X the work, or one further upstream): refused. The tool tells X: this
  Bot is waiting for the result of this work; finish, end this turn, and the result goes back on its own.
  - If this turn answers this very work and has not written any text yet, and the refused message is not
    queued and not `reply_to: "user"`: the message is kept as what X said for this work (see "If B said
    nothing in its last turn" above), and is delivered if the turn ends without text, keeping only the
    first 2000 characters. Several refused messages in the same turn are kept joined; one refused in a
    later turn replaces what was kept before. The refusal says what was kept and to whom it goes.
- Everything else is allowed. The same Bot can appear several times in one piece of work, for example:
  - A coordinates itself: A hands to B, B returns; A hands to C for review, C returns; A accepts.
  - Relay: A hands to B, B hands to C for review; C's comments go back to B, B returns to A together with
    C's comments; A accepts.
  - Rework: C asks for changes, back to B; B changes it and hands to C again; once it passes, B returns
    to A.
- Other work is not affected: for separate work the user gave B in B's own chat, B can still ask A.

### Approval notices

- When a Bot is waiting for user approval in its own chat, and the work of this turn was handed to it by
  another Bot (the request it answers, or the work it continues after a return): a notice goes at once
  to the own chat of the Bot that handed off the work. The notice says who is waiting, the tool to run, a
  short reason, and where to approve; the handing Bot tells the user in a sentence or two, and does not
  message the waiting Bot.
- Approvals in a group are already shown in the group chat and get no extra notice.
- If an approval is still unanswered after 5 minutes (`APPROVAL_REMIND_MS`): the same notice (with how
  long it has waited) goes once to each Main Bot, except Bots that already got it and the waiting Bot
  itself.
- The same approval goes to the same Bot only once; once the approval is answered or canceled, no more
  notices go out. A notice cancels nothing.
- Notices are not part of the exchange record between Bots, need no reply, and are not part of the
  handoff tree.

### Limits removed

- The 6-hop message chain, the 10 unread messages, the 3 rounds a Bot can start in a group, and the 40
  team-wide messages after the user last spoke are all removed, with no fallback.
- The limit on relays between Bots in a group is removed too (see group chat).

### Rule text

- The team rules say: `list_bots` shows what each Bot is doing right now; after handing off part of the
  work, end this turn, you continue when the result comes back, and your reply goes to the Bot that
  handed you the work only when everything has come back; do not message a Bot that is waiting for the
  result of this work.
- The existing rules stay: send only when the other Bot must act or a fact is needed; send no thanks,
  confirmations or progress echoes; once a reply arrives, the exchange is over.

## Not done

- No status in the system prompt (cache).
- No proactive notice to the handing Bot that "the other Bot is stuck": every notice makes the handing
  Bot run the model again. The handing Bot sees it the next time it calls `list_bots` or `message_bot`.
  The only exception is waiting for user approval: only the user can unblock it, and the user may not be
  in the chat that shows the approval card (see "Approval notices" above).
- No board-style task objects: work still lives in the Bots' Sessions, and handing off is still a
  message. Task objects, progress queries and "ask without acting" are left to a separate app.
- No fallback limit on total, chain length or rounds.
- No batch handoff interface, and no other use of `request_id`: it is only the name the sender gives its
  own piece of work.

## Known limits

- Bots that keep asking each other questions, or work that is reworked endlessly, run until the user
  stops them.
- If work below never comes back (for example, the other Bot waits for user approval), the work above
  waits forever; DSH has no timeout. The status shows whom it waits for.
- Status is kept only in memory and is rebuilt from new events after DSH restarts, the same as the status
  in the interface; wait relations are the exception, as they are stored in `state.json`.
- When X itself splits one piece of work into several different requests to different Bots, that is not
  a duplicate.
- One `request_id` maps to one content only: changing one character makes it a different piece of work,
  and it is refused. A sender that wants to change the content uses a new name.

## Changes

- 2026-10-16: decided (#262).
- 2026-10-16: the Bot's character animation shows "Waiting for another Bot" (#262).
- 2026-10-23: the full text of a returned result is kept in a file in `bot/handoff-results/`, and
  `state.json` stores only the start, so a restart does not cut short results that are already done
  (#479).
- 2026-10-23: `message_bot` can take a `request_id`: a retry of the same work is sent only once and gets
  the original receipt back, the same name with different content is refused, and nothing is resent
  when the outcome is uncertain (#480).
- 2026-10-23: when DS Bot restarts, a turn that DSH was still running but DS Bot did not see is settled
  once from the Session's persistent record (DSH's `session/event` record): if the turn wrote an answer,
  the answer goes to the Bot waiting for it (the original request is not resent); if the turn stopped,
  that is reported; if the turn was cut off, the work is picked up and continued as before; if no result
  can be read, the result is reported as unknown (naming the Session, counted as neither success nor
  failure, and the request is not resent). So wait relations do not hang forever (#483).
- 2026-11-08: a message refused because it went to a Bot waiting for the result is kept as what was said
  for this work when the turn has not written any text yet, and is delivered if the turn ends without
  text; the `message_bot` description also says not to message a Bot waiting for the result (#1140).
- 2026-11-08: unanswered question cards and view cards in the status say how long they have waited
  (minutes, hours, days); `list_bots` can list only one Bot or one group's members with `bot` or `group`,
  still one line per Bot, and the rules for private Bots are unchanged (#1141).
- 2026-11-09: a lost receipt no longer makes a Bot wait forever: the Bot's right-click menu can give up a
  wait, which goes back to the work above as an explicit result; a late receipt is marked late and not
  settled twice; at restart, waits whose target no longer exists take the same path (#919).
- 2026-11-19: when a Bot waiting for user approval is doing work another Bot handed it, the handing Bot
  gets a notice at once; when an approval is unanswered for 5 minutes, the Main Bots get one notice (see
  "Approval notices").
