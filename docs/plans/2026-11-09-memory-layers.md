# Four ways to read memory

- Date: 2026-11-09
- Related: #797 (group memory fills up fast), #925 (hard-coded limits), #453 and #214 (an open Session does not see new memory), #1185 (group tidying skips lines that scrolled out of the log)
- Code: `ds-bot/src/host/memory.js`, `memory-entries.js`, `memory-copy.js`, `memory-review.js`, `memory-search.js`, `memory-tidy.js`, `group-log.js`

## Why

Scope used to decide both who can read and what is injected every time, and `MEMORY.md`
was both the store and the workbench. So everything a Bot could read went into the
context every time, and new facts that did not fit could not be saved. Both problems have
the same root cause; only raising the limit would make every Session carry more content it
does not use.

## Decided behavior

### Read

| Way | Content | When |
|---|---|---|
| Always loaded | Own, team and group `MEMORY.md` | Frozen when a part starts; the prompt stays byte-for-byte the same within the part |
| Delta | `MEMORY.md` entries changed by others (other Sessions, tidying, the user) | Before the next step, one message appended at the end of the conversation; nothing when there are no changes |
| Auto recall | A few entries from topics that relate to what the user just said | First step of a turn; nothing when there is no match; not repeated within a part; can be turned off in settings |
| On demand | All entries, full topic text, other Bots' memory, the group's original messages | The Bot calls `recall`, `read_group_chat` |

- Filter by scope first, then rank. Ranking computes BM25 in memory, because the chat
  index's trigram match cannot match two-character Chinese words.
- An ordinary Bot can read a public Bot's memory with `recall`; it is not injected. A
  private Bot's memory can be read only by itself and the user.

### Write

- A write never fails because of the quota. When `MEMORY.md` reaches its quota, the same
  write moves the oldest unpinned entries to the topic `earlier` (expired ones first) and
  tells the Bot. When a topic is full, writing continues in `<topic>-2`. When a Bot or
  group reaches its topic limit, the write goes into `MEMORY.md`. Team on-demand entries
  keep going into topics.
- Tidying does deletes and edits first, then additions.
- The quota counts only entry text, not metadata. Defaults: group 12,000, Bot 8,000, team
  4,000 characters, changeable in settings. Each layer takes at most 2% of the model's
  usable window in the prompt; beyond that the newest and pinned entries are kept, with a
  note of how many entries remain.
- In the prompt each entry carries only a short id and a date; the full source comes from
  `recall`.

### Team memory

- Every Bot reads the team `MEMORY.md` every time. It is written only on the user's
  explicit request (`always` in `remember`) or from the memory panel.
- Other team writes go into the topic `shared` and are read through `recall` or auto
  recall. Team topics show only their names in the prompt.
- Automatic tidying does not change the team `MEMORY.md`. A Main Bot's tidying can write
  for a given Bot; a group admin's tidying can write for the group it is in. Rules that
  belong to one project do not go into memory; they go into AGENTS.md.
- A group is the project boundary; there is no project memory.

### Entries

- The format is compatible with Agent Memory Repo:
  `- text [id: 7f3a; source: …; by: …; added: …; until: …; pinned: user]`. Old entries
  without an id get one computed from their text.
- After `until`, an entry no longer goes into the prompt or auto recall. `pinned` is set
  by the user; automatic tidying and making room leave it alone.

### Regular tidying

- A background task that does not take a place in the Bot roster. Changed memory is tidied
  at most once a day.
- Order: resolve contradictions first, then merge duplicates, then handle expired status,
  and last move details into topics.
- One run changes at most one fifth of the entries. Expired entries do not count against
  this quota. For the team, only topics are tidied.
- Only soft archiving: entries that leave are written to `retired.jsonl` in the same
  directory. Each tidying is one batch; the memory panel shows the result, and the whole
  batch can be undone. Once the file has changed again, it can no longer be undone.

### Group evidence

Every group message is in the group's ledger ([message ledger](2026-11-10-message-ledger.md)).
Tidying reads from there and no longer skips messages that scrolled out of the 60-line
window. The source of a group memory is written as `group "group name" #number`;
`read_group_chat` opens it by number and can also search by words.

## Not done

Vector store, git, a separate service, a knowledge graph, several memory types, a scope
tree.

## Known limits

- The window size is known only before the first step. A new Bot's first freeze may not
  respect the 2% limit; it applies from the next part on.
- Auto recall matches words only and does not understand synonyms.
- After an upgrade, existing team entries stay in `MEMORY.md`; the user moves them to
  "Only when needed" in the memory panel.
- When a memory is at the wrong level, the user moves it in the memory panel to the team,
  another Bot or a group. The entry keeps its id, expiry and pinned state. When it moves to
  the team it goes into the topic `shared`, and whether it is always loaded is a separate
  choice. The new location is written before the old one is deleted, so an interruption
  leaves it in both places at most, never lost. Only the panel can move entries; the model
  has no tool for it.

## Changes
