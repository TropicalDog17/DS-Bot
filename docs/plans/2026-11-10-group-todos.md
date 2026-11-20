# Shared group to-dos

- Date: 2026-11-10
- Related: #326

## Why

Decisions and to-dos in a group often live only in one Bot's conversation: they are lost
when a new part starts, and other members cannot see them. The group notice is an
instruction the admin writes for the whole group, not a line item that every member can
add.

The maintainer decided to build one list per group in the plugin. Task objects and
progress queries stay with the desktop app ([handing work between Bots](2026-10-16-bot-handoffs.md));
this is only a light list that belongs to the group.

## Decided behavior

- Each group has one shared to-do list, stored in the group record. It is deleted with the
  group; there is no separate storage.
- One line per item: text (at most 200 characters), done or not, creation time and
  creator. When an item is done, who finished it and when are recorded.
- The whole list holds at most 100 items. When it is full, a new item is refused with a
  note to delete one or clear the done items first; existing items all stay and none are
  dropped.
- Group members and Main Bots can add, check, remove, clear done items and view. Bots use
  the `group_todo` tool (`list` / `add` / `check` / `remove` / `clear`); the user views,
  checks, removes single items and clears done items in the group details.
- In the group details, open items come first and done items come after with a
  strikethrough. The title shows the number of open items, and when there are done items
  they can be cleared. Every row can be removed.
- When the tool lists items it gives a short id (the first 8 characters of the uuid);
  `check` and `remove` accept the full id or a prefix that matches exactly one item.
- Checking the same item twice is not an error; unchecking needs an explicit
  `done: false`.
- A change updates only this group record and needs no restart.

## Not done

- No owner, due date, priority, reminders or notifications.
- No input box in the group details: new items come in through the Bot's tool.
- No list across groups, and to-dos are not injected into members' prompts.

## Known limits

- To-dos are not in a Bot's prompt; a Bot has to read them with `group_todo` itself.

## Changes

- 2026-11-10: first version (#326).
- 2026-11-12: added removing single items and clearing done items (group details and
  `group_todo`). When the list is full at 100 items, a new item is still refused with the
  reason; after items are removed, adding works again.
