# Message ledger

- Date: 2026-11-10
- Related: #1316

## Why

One group chat message used to be stored several times: the interface read the replies in
the `group_relay` tool result, members read the last 60 lines in `state.json`, memory
tidying read `group-logs`, and the full text of long messages was kept apart in
`group-lines`. Different code wrote each copy, and when one write was missed, the
interface and the members saw different things. A round's replies lived in the tool
result, and DSH truncates very long tool results, so after a refresh the replies of a very
long round could disappear ([DSH concessions](2026-10-13-dsh-concessions.md) C12).

DS Bot keeps its own append-only ledger: a message is written to the ledger first, and
every other place reads from the ledger.

## Decided behavior

### Ledger

- One ledger per group: `bot/ledger/group-<group id>.jsonl`. One record per line, ordered
  by sequence number from old to new, append-only; old lines are never changed.
- A record has: sequence number, who spoke, what was said (full text), kind (message,
  notice, searched its own chat, started work, waiting for your approval, resumed after an
  interruption, stopped, done), time, and the fields the kind needs.
- The ledger is written first, then used elsewhere. Everything said in a group goes
  through one write path.
- The first time a ledger is used, the whole ledger is read into memory; later reads come
  from memory. Disk writes are queued in order.
- A read-only window does not write the ledger, and reads it again when the file grows.
- The ledger is deleted with the group. Nothing is deleted automatically by count or age.

### Who reads what

- A group's last 60 lines in `state.json` are a cache of the end of the ledger; each line
  stores only its first 2,000 characters and the total length. When a member reads a line,
  the full text comes from the ledger, up to 20,000 characters.
- When the ledger is newer than the saved `state.json` (the process exited before it
  saved), the group continues numbering from the last ledger record, and the missing lines
  are added to the last 60 lines.
- `read_group_chat`, memory tidying and IM all read from the ledger.
- Group chat page: each `group_relay` call records an anchor in the ledger (with its own
  id), and the tool result is the anchor's sequence number (`from`) and id. Below that call
  the page shows the lines from it up to the next anchor in the ledger, so what is said
  after the user's next message shows below that message; when nobody spoke between two
  calls, the earlier slot is empty. The newest slot refreshes every second while the group
  is working, and once the group is quiet it refreshes only when team data changes. Lines
  are drawn from the ledger and do not change after a refresh, and the tool result is no
  longer truncated for being too long.
- The message that opens a round (sent by the user, or a Bot post that opens a round) is
  shown by the group's own Session and is not repeated in the lines.

### A round runs in DS Bot

- A `group_relay` call only records an anchor and returns at once; DS Bot runs the round
  itself and does not hold the group's DSH Session. The limit of about 10 minutes per
  round in old PTC groups is gone.
- A group runs one round at a time. While a round is wrapping up after it ends (goal
  check, save, report), the group still counts as busy. When the user sends another
  message while a round is running, the message joins the running round, and the members
  it names answer in this round. A goal message, the first round after a group is created,
  a message with images or a quoted conversation, and a message that arrives during the
  wrap-up wait until this round has wrapped up and then open the next round.
- When the user stops the round, waiting messages do not open a new round by themselves;
  they are handled with the group's next message.
- When a round ends, a record goes into the ledger: the range of the round, who skipped,
  who failed, and whether it was stopped.
- A round is stopped with "Stop all" in the group details: it stops this round and the
  member turns it started. The stop button next to the DSH input box no longer maps to a
  round. When the plugin unloads or exits, a running round stops with it.

### Work batches in a group

- When a Bot names several members at once in a group, that is a batch: who it waits for,
  who has finished, which ledger records hold the results, whether tools were used for
  work, and whether anyone followed up. Batches are stored with the team in `roomBatches`
  in `state.json` and survive a restart.
- After a restart, interrupted turns resume first; a member that is still not working
  after that is no longer waited for in the batch. When someone in a batch has finished
  work, the Bot that handed out the work is woken once, with the results so far; a batch
  where nobody finished is cleared and nobody is woken.
- Batches are stored separately, not in the handoff tree of the Bot's own chat: a node in
  the handoff tree is "give to one Bot, the answer goes up", while a group batch is "name
  several members at once, wake the Bot that handed out the work when they are done". The
  two follow different rules.

### Messages between Bots

- One ledger per pair of Bots: `bot/ledger/pair-<id>-<id>.jsonl` (the two ids sorted and
  joined).
- The request, reply and stop of `message_bot` are written to this ledger first, then
  delivered into the other Bot's Session. After delivery, a "delivered" record is written.
- The exchange dialog lists only delivered messages, with full text read from the ledger;
  messages over 20,000 characters that were sent as files are still read from the file.
- `state.json` no longer collects messages between Bots. The first time a pair's ledger is
  used, it is built from the earlier exchange records in `state.json`.

### Old data

- When there is no ledger, one is built from the earlier `group-logs`, the last 60 lines
  in `state.json` and the full text in `group-lines`. Only the DSH that is writing data
  writes this file.
- The old `group-logs` and `group-lines` are no longer written; they are deleted with the
  group.
- Tool results from before the ledger carry the replies themselves and still show as
  before.

## Not done

- No moving the user's own chat with a Bot into the ledger: that conversation is the Bot's
  own DSH Session.
- No change to DSH.
- No limit on the number of records, and no automatic cleanup of old messages.

## Known limits

- A ledger in use is kept whole in memory; a very long group takes more memory.
- Disk use grows with messages and is freed only when the group is deleted.

## Changes

- 2026-11-10: group chat messages go into the ledger (#1316).
- 2026-11-10: work batches in a group are saved; after a restart they keep waiting or wake
  the Bot that handed out the work (#1316).
- 2026-11-10: messages between Bots go into one ledger per pair (#1316).
- 2026-11-10: the round moves out of `group_relay` and DS Bot runs it itself; the chat is
  split into slots by anchor (#1316).
