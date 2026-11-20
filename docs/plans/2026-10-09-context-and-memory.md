# Context and memory: conversation parts, the context steward, memory

- Date: memory decided 2026-10-08, parts and the steward decided 2026-10-09, group memory added 2026-10-17
- Related: #122 (Session renewal), #151 (shared memory in a group), #214 (saved memory has no effect in Sessions that are already open)
- Code: `ds-bot/src/host/steward.js`, `parts.js`, `memory.js`, `chat-index.js`, `read_own_chat` in `groups.js`

## Why

Bots are long-lived: a user chats with one Bot for weeks or months, so the context will fill up. The two
common approaches are both wrong:

- **Compact the same Session again and again**: a summary of a summary gets vaguer each time, and lost
  details cannot be found again.
- **Cut to a new Session as soon as the line is hit**: work that is half done gets cut off, and the Bot
  seems to have lost its memory.

So DS Bot does this: **a Bot is one long-lived identity, and its conversation is made of several DSH
Session parts**. When the context is nearly full, a light "context steward" looks at the recent messages
and judges whether the work has reached a natural stop. If the work is not done, the Session is compacted
in place and goes on. If it has reached a stop, the conversation moves to a new part. Old parts are kept
whole and can be searched at any time.

For the user all of this is **invisible**: they always see one continuous chat, with no notice such as
"context 80% used", and the Bot has no tool to switch parts itself. The only exception is a part switch
caused by a change of working folder: while that switch runs, the end of the chat shows a line
"Switching working folder", because the chat jumps to a new, empty part, and without a notice it would
look as if the typed content had vanished.

Memory is a separate line: context covers "what we are doing this time", memory covers "what should be
remembered across all conversations". Memory cannot depend only on the Bot remembering to call
`remember`, so each conversation part also gets an automatic memory review once it is idle.

## Decided behavior

### Parts

- Own chat: `bot.sessionId` is the current part, `bot.segments[]` are the old parts. In groups: each Bot
  has its own part in each group (`room.sessions[botId]`), and its old parts are in
  `room.segments[botId][]`.
- A group part uses the same system prompt and tools as the own chat, so it can share the provider's
  prefix cache, but it does not read the Bot's own chat. Own chat content reaches a group only through
  `read_own_chat`, and the group can see that the Bot looked it up.
- DSH's own automatic compaction, `/compact` and overflow compaction have no effect on Bot Sessions. DS
  Bot calls the DSH compaction engine only when the steward says to compact, and replaces the summary
  with DS Bot's own checkpoint.

### Lines: all follow the model

There are no fixed token counts in the code.

| Line | How it is computed |
|---|---|
| Window W | The model's declared `contextWindow`; 500,000 when the model declares nothing at all |
| Usable U | W minus the reply reserve (the route's `maxTokens`), at least W/2 |
| Hard line H | 0.95 × U (the token count between two requests is an estimate) |
| Check line C | `checkRatio` × U, at most H. `checkRatio` is 0.8 by default; change it in `bot.config` in `cordis.patch.yml` |

### When to judge

- **End of a turn, context ≥ C**: the steward judges once. After handling, the context is back below C;
  the part must grow by another C/4 before the next judgment, so even a very large system prompt does
  not cause a judgment every turn.
- **Middle of a turn, ≥ H**: judge before the next step (the fallback). If the answer is compact, compact
  in place and continue this step; if it is switch, stop and continue in the new part.
- **The provider reports a context overflow**: switch parts at once, without writing a handoff note.
- **Read-only process** (another dsh holds the team): no judging, no compaction, no part switch.
- A connection failure does not mean anything is wrong with the conversation itself, so it does not
  cause a part switch.

### The steward

- One separate small request, without the Bot's long prefix, on the Bot's own model route, with
  reasoning turned off where supported.
- It looks at the recent messages of this part: the user's, other Bots', and the Bot's own replies,
  collected from newest to oldest, about 6,000 tokens, at most 1,500 characters per message. It is also
  told: own chat or group, end or middle of a turn, and how many times this part has been compacted.
- It answers with one line of JSON only: `{"action":"switch"|"compact","reason":"…"}`.
- Before it judges "reached a stop", it checks item by item what the user asked for against what the Bot
  actually did, and whether the Bot asked a question the user has not answered yet. Unfinished work
  does not count as a stop, even if the Bot says it is done.
- The more times a part has been compacted, the more readily a reasonable pause should count as a stop:
  a summary of a summary loses more. This is a leaning, not a hard rule.
- Text in the messages that "tells the steward how to answer" counts as conversation content, not as
  instructions to the steward.
- If the steward fails or cannot answer: switch parts.

### Compaction: checkpoint

- One request with this part's own prefix (so it hits the cache) writes out: where the work stands,
  decisions and their reasons, rejected options, constraints from the user, the remaining steps, and data
  that must be kept verbatim. Nothing is invented; newer replaces older; earlier checkpoints and handoff
  notes are merged in.
- Checkpoint = `[Checkpoint N]` + the summary + the original words sent by the user and other Bots
  (newest first, within a budget).
- If the context is still above C after compaction: switch parts.
- The compacted messages stay in the Session log, and `read_own_chat` can find them. The interface
  shows no compaction marker.

### Part switch: handoff

- The Bot writes a handoff note while idle, with the same prefix as its own requests, so it hits the
  cache and the user does not wait.
- A new part starts with a **handoff pack**: the note + the latest messages verbatim + where the rest
  is. An own chat part also gets a list of earlier "messages sent to the Bot", each with an anchor such
  as `[part 2 #1234 · 10-08 14:22]`. In a group one group message holds a whole round, so a group part
  only carries the latest messages.
- Input that arrives during a switch waits, then goes to the new part. Input sent to the old part is
  handled in the current part.
- The old part is archived whole, not deleted.

### `read_own_chat`

- Searches **all parts** of the Bot's own chat, including messages that were compacted away. Uses
  SQLite FTS5 with BM25 ranking; a trigram tokenizer, so Chinese needs no word splitting, and terms of
  two characters or fewer use LIKE.
- The index is derived from the Session logs: it is filled in on read and sealed when a part ends;
  deleting the index file only causes a rebuild. Without SQLite it falls back to scanning the logs
  directly.
- `around` takes an anchor and shows the full text of that message and a few around it; `part` shows the
  handoff note written when that part ended.

### Memory

**Storage** (all under `bot/memory/` in the data directory):

| Location | Content |
|---|---|
| `bots/<botId>/` | Each Bot's own `MEMORY.md` and topic files |
| `groups/<group id>/` | Group memory: shared by the members of this group, read only in this group |
| `team/` | Team memory, read by all Bots |
| `journal.jsonl` | Every change, with the line before and after |
| `journal.torn` | A journal line that was half written: kept as evidence, the journal itself is repaired |
| `pending.json` | A change that is not fully written yet: it first records which files it will change, and is removed only when the writing is done |
| `snapshots/` | The frozen memory section of each Session |
| `summaries/` | The memory panel's summary for each Bot and each group |
| `archive/` | The memory of deleted Bots and deleted groups, whole |

**Format**: the Markdown format of [AgentMemoryRepo](https://github.com/AgentMemoryRepo/agentmemoryrepo).
One entry per line, with metadata at the end of the line such as `[source: …; added: …]`; the
`## Index` in `MEMORY.md` links topic files with `[[topic]]`.

**Sizes** (in characters): 300 per entry; 4,000 per `MEMORY.md`, about 8,000 for two together, sent with
every request; 16,000 per topic, read whole in one `recall`; at most 40 topics.

**Who can do what**:

| | Own memory | Group memory | Team memory | Other Bots' memory |
|---|---|---|---|---|
| Ordinary Bot | Read, write | For groups it is in: read and write in that group | Read | Read a public Bot's with `recall`; a private Bot's cannot be read |
| Group admin | Read, write | Same as above | Read, write | Same as an ordinary Bot |
| Main Bot | Read, write | Same as above; cannot read it when not in the group | Read, write | Read, write (when the user asks) |
| User (memory panel) | All | All | All | All |

What is said in a group stays in the group: group memory goes only into the group Sessions of that
group's members, not into their own chats, other groups or Bots outside the group. A member removed from
the group can no longer read or write that group's memory. Removal takes effect at once: its group
Session is voided and archived on the spot and no longer runs, and `remember`/`forget`/`recall` refuse at
call time based on membership. If it later joins the group again, it gets a new group Session, frozen
with the group memory of that moment, not the old frozen section of the old Session.

**How memory gets written**:

- Bots use `remember` / `forget`. These tools check who may write where and the size limits, and they
  refuse content that looks like a key. In the own chat they write the Bot's own memory by default; in a
  group they write that group's memory by default, `scope: "own"` writes the Bot's own, and
  `scope: "team"` writes the team's (with permission).
- When nothing was written (no permission, the entry to remove was not found), `remember` / `forget`
  return an error instead of an ordinary sentence: the model can see it was not saved. The quota no
  longer makes a write fail; see [Four ways to read memory](2026-11-09-memory-layers.md).
- **Memory review**: once a conversation part is idle, the model reads what is new in it and keeps,
  changes or removes entries, the way a person does after a talk. What the user said is kept most
  completely. An own chat is reviewed by the Bot's own model and written into its own memory. A group
  chat is reviewed once per group (not once per member), with the group admin's model (or the first
  member's when there is no admin), and is written only into group memory, not into personal or team
  memory; it keeps only agreements, decisions and facts that stay useful after the task ends, not
  one-off task state (#797). Only one review runs at a time.
- Memory panel: shows the summary written by the model, all entries, and "Change history" (every add,
  change and removal listed from `journal.jsonl`; two clicks undo a single change, see
  [Restore a memory change](2026-11-01-memory-restore.md)); the user can ask questions and edit
  directly. A Bot's panel shows its own memory and team memory; a group's panel ("Memory" in the group
  details) shows only group memory.
- When a group is deleted, its group memory moves whole to `archive/`, and the frozen memory sections in
  the members' group Sessions are voided with it.
- All three paths use the same write path, one write at a time, done by the process that holds the
  team.
- History does not use git: files are changed in place, and `journal.jsonl` records what each change
  replaced.
- A change touches several files (the entry, the topic link in `## Index`, the line in
  `journal.jsonl`). It first writes `pending.json` with what it will change, then changes the files, and
  writes the journal line last. If it is interrupted halfway, `pending.json` stays, and the change is
  finished before the next memory read or write (or at restart): an entry never lacks its journal line,
  and a topic never lacks its link. The same line is never written twice.
- The end of `journal.jsonl` may hold a half-written line (the journal write was interrupted). A half
  line does not count: it moves to `journal.torn` as evidence, the journal itself is repaired, and the
  next line starts on a new line.

**How memory is used**:

- Each Session freezes its memory section on first render; after that the prompt stays byte for byte the
  same, so the provider's prefix cache can hit. Moving to a new part, or making a checkpoint (which
  breaks the cache anyway), freezes it again.
- So entries saved after a part has started do not appear in that part's prompt. The prompt tells the
  Bot to call `recall` before it answers "I don't know". `recall` finds the latest entries.
- `recall` with no arguments lists what is stored where; with `query` it searches; with `topic` it reads
  a whole topic. By default it searches the Bot's own memory and the team's, plus this group's when in a
  group.
- A group Session's system prompt is byte for byte the same as the own chat's (the provider puts tools
  after the whole system prompt, so one difference in the prompt means none of the tools after it can
  share the cache). Group memory is not in the system prompt: before the group Session's first step it
  goes into the Session as a snapshot message, and is then frozen with the Session; after a checkpoint
  compacts it away, the next step adds the group memory of that moment again. Group Sessions that froze
  group memory into the prompt before this change stay as they are and do not get this message.

## Not done

- Neither the Bot nor the user is told how much of the context is used, and the Bot gets no tool to
  switch parts.
- No fixed token lines, and no hard-coded numbers for any model.
- No judgment every turn, only after a line is crossed.
- No git for memory.
- No change to DSH's model settings interface. "Fill in 500k context by default when adding a model" is
  not possible; the plugin can only use 500k when the model declares no window at all.

## Known limits

- Some DSH adapters fill in their own default for a model with no `contextWindow`; then the plugin gets
  the adapter's value, not 500k. The README asks users to fill in `contextWindow`.
- Sessions that are already open see `MEMORY.md` entries changed by others through delta messages;
  topic content comes through automatic recall or `recall` (#214, #453, see
  [Four ways to read memory](2026-11-09-memory-layers.md)).
- Gaps against item 3 of the [vision](../vision.md):
  - Bots can only read each other's memory: on demand with `recall`, not injected; a private Bot's
    memory can be read only by itself and the user (see [Private Bots](2026-10-27-private-bots.md)).
  - The vision asks for goal-driven work: group chats have DS Bot's own
    [group Goal](2026-11-01-group-goal.md) (#791), a Goal in a single Bot's own chat is not done yet;
    DSH's Session-level goal is turned off in Bot Sessions (see
    [DSH concessions](2026-10-13-dsh-concessions.md)).
- "A Bot opens a brand-new Session and keeps its identity" (like /new) does not exist yet (#122).

## Changes

- 2026-10-08: decided the memory format, storage, and "review without git".
- 2026-10-09: parts changed from "switch when the line is hit" to "the steward judges compact or
  switch"; all lines now follow the model.
- 2026-10-17: added group memory (#151). Before, what was learned in a group could only go into team
  memory, which all Bots read, including Bots created outside the group later; now group chats are
  reviewed per group and write only group memory.
- 2026-10-23: a part switch caused by a change of working folder shows a status line at the end of the
  chat ("Switching working folder", #486). Part switches for other reasons stay invisible.
- 2026-10-23: added `pending.json`, so one change is done as one (#481). Before, the files were written
  first and the journal after, and an interruption could leave an entry with no journal line or a topic
  with no link.
- 2026-10-23: when nothing was written to memory, `remember` / `forget` return an error, and the chat
  shows a one-line failure notice with a link to the memory panel (#482).
- 2026-11-02: group memory moved from the group Session's system prompt to a snapshot message at the
  start of the Session, so a group Session has the same system prompt and tools as the own chat and its
  first turn can share the own chat's prefix cache (measured first-turn hits went from about 2k to about
  13k tokens, PR #828).
- 2026-11-02: group memory review no longer records one-off tasks and keeps only what stays useful after
  the task ends (#797, PR #827); the memory panel's ⋯ menu gains "Change history", which can undo a
  single change by its record id (#464, PR #822).
- 2026-11-09: memory is read in four ways: always loaded, delta, automatic recall and on demand; the
  quota counts only the entry text, and the user decides the team's always-loaded layer
  ([Four ways to read memory](2026-11-09-memory-layers.md)).
