# Roles and permissions

- Date: 2026-10-07 set the three role levels; 2026-10-11 added permission presets for Bots; 2026-10-14 added a shared permission for groups
- Related: PR #180 (shared permission for groups), PR #154 (each Bot can change its own settings)

## Why

The team must be able to organize itself: a Main Bot creates Bots, creates groups and dispatches work, a group admin manages its own group, and the other Bots focus on their work. At the same time, actions beyond a Bot's rights (removing a Bot, changing another Bot's settings, opening up sandbox permissions) need a clear boundary. Otherwise one Bot's wrong judgment can affect the whole team.

There are two layers of permissions, independent of each other:

- **Role permissions**: who can manage Bots, groups and team memory. DS Bot checks them itself.
- **Sandbox permissions**: what a Bot's tools can reach (read files, change files, run commands). These use the permission presets that DSH provides, and DSH enforces them.

## Decided behavior

### Role permissions

| Who | Scope | What it can do |
|---|---|---|
| User | Everything | Every action, including setting and removing a Main Bot, turning a private Bot on or off, setting the sandbox permissions of Bots and groups |
| Main Bot | The whole team (except private Bots) | Create Bots (`create_bot`), change any non-private Bot (`update_bot`), stop the running turn of another non-private Bot (`stop_bot`); create groups, change any group, remove groups, post in any group; write team memory, and read or write the memory of a non-private Bot when the user asks; add and remove capabilities on any non-private Bot |
| Group admin | The groups it manages | Change its own group (name, notice, members, admin, reply mode), post in its own group, write team memory. It cannot remove the group or change the group's work folder |
| Regular Bot | Itself | Change its own name, role, color, model, thinking effort, work folder and instructions; add and remove its own capabilities; speak in groups, call on members with `@`; post in the groups it is in (only the members it calls with `@` are called); in its own chat, message any non-private Bot with `message_bot` (in a group it can only call members of that group, see [Group chat](2026-10-07-group-chat.md)); in a group, read and write that group's memory (see [Context and memory](2026-10-09-context-and-memory.md)). A Bot that the user sets as private has an extra one-way isolation boundary, see [Private Bots](2026-10-27-private-bots.md) |

- A team has exactly one Main Bot, and it routes the user's requests without doing the work itself: its shell and file-writing tools are taken away (see [Main Bot as the team's Router](2026-11-22-main-bot-router.md)). Setting another Bot as Main moves the role. Only the user can set or move the Main Bot.
- A Main Bot cannot be removed directly. Remove its Main Bot role first.
- Each group has at most one admin, and the admin must be a group member. The admin cannot leave the group directly or leave the group without an admin; it hands over first. When a Main Bot creates a group, it is the admin by default. When a Bot is removed, the groups it managed have no admin.
- A tool call beyond a Bot's rights is refused, and the refusal tells the Bot what to do instead (for example "Only a Main Bot can create Bots; ask a Main Bot to do it"), so the Bot can change course on its own.

### Sandbox permissions

- Each Bot has its own permission preset (the ones DSH provides: Read only / Workspace / Full access). It is stored on the Bot and used for its own chat, the groups it is in, and later new conversation parts. When it is not set, the DSH default preset applies.
- **Only the user can set it.** Every change a Bot starts is refused; neither `update_bot` nor `update_group` has this parameter.
- Choosing "Full access" asks for a second confirmation, and the label always shows in red.
- A group can set one shared preset ("Same for every member") that overrides each member's own. It applies at once to all members' Sessions in that group, and also to new Sessions members open in the group later and to the new part after the group moves to a new part. A member that changes its own preset does not affect a group with a shared preset. When the shared preset is turned off, each member goes back to its own preset.

## Not done

- No fine-grained table of role permissions (who can `@` everyone, who can read group chats, and so on), and no permission matrix in the interface.
- Bots cannot raise their own or another Bot's sandbox permissions.
- A group's shared permission cannot be handed to DSH's automatic review (Auto review works only on a single Session).

## Known limits

- The DSH "+" and "/" menus still have a permission entry. If the user changes the permission there in a Bot Session, it bypasses the setting on the Bot (see [DSH concessions](2026-10-13-dsh-concessions.md) C4).

## Changes

- 2026-10-14: shared permission for groups, PR #180.
- 2026-11-23: exactly one Main Bot, which routes and does no work; the Goal is retired ([Main Bot as the team's Router](2026-11-22-main-bot-router.md)).
