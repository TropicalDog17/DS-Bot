# docs/plans: decided designs

This directory holds the designs that DS Bot has decided: why it works this way, the decided behavior, what is
not done, and the known limits. When you are not sure whether something is a bug or works as designed, check
here and the [vision](../vision.md) first; if it is not written here, ask in an issue.

Design notes are written in English.

## When to write one

- **Large feature**: add a `docs/plans/<date>-<topic>.md` to the same pull request, reviewed and merged together
  with the code.
- **Change to a decided design**: first confirm it with the maintainer in an issue (with the `maintainer`
  label), and update the matching note in the same merge.
- **Bug fix**: no note needed.

## Format

```markdown
# Title

- Date: the date the design was decided (later changes are added under "Changes" at the end)
- Related: issue / pull request numbers
- Code: the main files that implement it

## Why
The problem to solve, and the trade-offs made at the time.

## Decided behavior
Rules that can be checked. Write the current behavior, not the history.

## Not done

## Known limits

## Changes
- Date: what changed, and the pull request.
```

## Contents

| Note | What it covers |
|---|---|
| [DSH concessions ledger](2026-10-13-dsh-concessions.md) | Compromises made because of limits in DSH itself, and how the desktop app handles them later. To tell "a DS Bot bug or a DSH limit", look here first |
| [Roles and permissions](2026-10-07-roles-and-permissions.md) | What the user, a Main Bot, a group admin and a normal Bot can each do; Bot permission presets and the shared permissions of a group |
| [Private Bots](2026-10-27-private-bots.md) | Only the user can turn it on or off; other Bots cannot read its folder, memory or Sessions, and anything sent out needs the user's approval; its own folder, protection after deletion and the isolation boundary |
| [Group chat](2026-10-07-group-chat.md) | Who answers, working at the same time and speaking in turn, @ mentions, handoff batches, progress while working and late replies, approvals and Stop all |
| [Group chat Goal](2026-11-01-group-goal.md) | **Retired by the [Main Bot router](2026-11-22-main-bot-router.md); work is tracked as board cards.** The admin aligns first, then writes the Goal; work is handed to members in stages, each stage accepted with evidence; every turn carries the Goal ledger to stay on track; automatic progress when idle; pause, correct, end; the Session header capsule and the pod show progress and who does what |
| [The `/` menu in Bot chats and group chats](2026-11-13-bot-slash-commands.md) | Running DSH command lines from the `/` menu is masked per agent scope (the menu rows stay); DS Bot actions are in the menu: `/scheduled-task`; `/goal` is refused in Bot chats now that the group Goal is retired; skills are not affected |
| [iOS build and TestFlight](2026-11-13-ios-release.md) | The Apple account, App ID and App Store Connect API Key the user must get; after that, signing, archive, upload to TestFlight and troubleshooting; device pairing waits for the account and devices |
| [Group chat task board](2026-11-12-group-task-board.md) | **Retired by the [Main Bot router](2026-11-22-main-bot-router.md); work is tracked as board cards.** Bots register group tasks explicitly with `group_task`: owner, goal, status, latest progress, result summary, history; a note added on the panel is sent as a user message `@owner`; the data is saved with the group |
| [Shared group to-dos](2026-11-10-group-todos.md) | **Retired by the [Main Bot router](2026-11-22-main-bot-router.md); work is tracked as board cards.** One list per group: members add, check, delete, clear completed and view with `group_todo`; the user views, checks and deletes in the group details; saved and deleted with the group; at most 100 items, when full delete one or clear completed before adding |
| [Browser, search, secrets and connectors](2026-10-08-browser-and-secrets.md) | Each Bot's browser and `read_browser`, `auto` web search, secret cards and replacement rules, the GitHub connector (replaced by the general connectors of 2026-11-04) |
| [Encrypting secrets at rest](2026-11-12-encrypted-secrets.md) | Optional passphrase encryption of `secrets.json`: the same file switches atomically to a scrypt + AES-256-GCM envelope; unattended unlock with an environment variable or a passphrase file; behavior while locked, and rollback |
| [Browser plugins](2026-10-21-browser-plugins.md) | One browser backend for the whole team, one profile per Bot; `refs` / `script` / `task` |
| [Computer use](2026-11-04-computer-use.md) | The master switch and the DSH provider in Settings; four levels per Bot (off / view only / operate in the background / may use the foreground); app grants recorded per Bot; apps that must not be touched; app leases and the foreground lease; indicator, stop, the Computer page; takeover and handoff cards shared with the browser |
| [Context and memory](2026-10-09-context-and-memory.md) | Conversation parts, the context keeper (compact or start a new part), the handoff package, `read_own_chat`; where memory is stored, its format, permissions, tidying and freezing |
| [Four ways to read memory](2026-11-09-memory-layers.md) | Always loaded, incremental, automatic recall, on demand; budgets, the team always-loaded layer, scheduled tidying, the group's durable log |
| [Memory undo and change history](2026-11-01-memory-restore.md) | The memory window's "Change history" lists the changes in `journal.jsonl`; undo a single add, edit or delete by its record id with the inverse operation |
| [Bot runtime settings](2026-10-10-bot-runtime.md) | Agent presets, each Bot's model and thinking effort, the default model for new Bots, the working folder, capabilities (MCP, skills, capability packs) |
| [Local agent CLIs as Bots](2026-11-04-local-agents.md) | Local agent CLIs as a way to run a Bot: choosing and switching how a Bot runs, Session mapping, the tool bridge, approvals, memory, Session management and badges |
| [Avatar library](2026-10-23-avatar-library.md) | A reusable library of custom avatars (`bot/avatars/`, deduplicated by content) and bulk import that tolerates a single failed image |
| [AGENTS.md upkeep](2026-10-27-agents-md-upkeep.md) | Review lasting rules from project work; write them atomically only after the user approves |
| [Message ledger](2026-11-10-message-ledger.md) | Every group message is first written to the group's append-only ledger; the interface, members, memory tidying and IM all read from the ledger; a turn's tool results record only a sequence range, so nothing is lost after a reload |
| [Long messages](2026-10-16-long-messages.md) | state.json stores only the beginning; Bot messages over 20,000 characters become DSH files; how members and the interface read the full text |
| [Reading long replies](2026-11-13-long-reply-reading.md) | For a Bot reply taller than the visible area, a reading capsule appears at the top once the beginning scrolls out: back to the beginning, which section you are reading, jump by heading |
| [Desktop app](2026-10-16-desktop-app.md) | How the shell, the engine and the interface are split; the pinned DSH version, the separate data location, first start and import, how the plugin stays compatible with DSH, install and updates |
| [Linux desktop package](2026-10-21-linux-app-package.md) | AppImage (self-updating) plus deb (fallback for the Debian/Ubuntu sandbox), produced by the same build |
| [Handoffs between Bots](2026-10-16-bot-handoffs.md) | Bots see each other's status; unread messages are merged into one; the handoff tree: work is handed up only after the work below has come back, and nothing may be sent to a Bot that is waiting for a result; no limit on total count or chain length |
| [Bot views](2026-10-20-widget-views.md) | Bots draw views in their answers: JSON blueprints from a fixed component catalog (including charts, inputs and local formulas), anything outside the catalog goes into sandboxed html; a generalization of the question-card loop |
| [Side chat](2026-10-21-btw.md) | A quick side question from the user: a persistent chat in the sidebar, answered with a request shaped like the Session's, runs no tools, does not interrupt, does not enter the model-visible history; follow-ups and several side chats are possible; `ask_bot` between Bots is a separate proposal |
| [Message layout and width](2026-10-22-message-layout.md) | Two layouts, bubbles and flat; in the flat layout a Bot's message carries its avatar, name and time; one slider each for bubble width and flat body width, set as a percentage of the body column |
| [Sidebar sections](2026-11-04-sidebar-sections.md) | Group Bots and group chats into sections by work: collapsed 3D miniature character clusters that show status, the selected row stays visible, a `+` on the section header (create new or add an existing one), grouping by right-click and drag, character cluster tiles in the 88px narrow sidebar, the `section` parameter of the Main Bot tools |
| [Windows onboarding](2026-10-26-windows-onboarding.md) | From download to the first reply: the download area and trust notes, install, a start page where the window appears first, one location and a recommended drive, one-click import on the start page, the model setup card in the Main Bot chat (signed-in or checked key, automatic model choice), the repair card, Windows problems in the first hour, one question on uninstall |
| [Start window](2026-10-26-start-window.md) | How the start page looks and acts: a separate small window (undecided); the Main Bot's whale floats on the waterline, and the ring of three arcs around it is the three real stages; no text when all goes well; clicking it makes it spout; the longer the wait, the slower it gets; cards and the failure page morph on the same sheet; when ready, the ring closes, the whale jumps onto the Main Bot's avatar in the team window, and the team window covers it in the same spot |
| [Start page copy](2026-10-29-start-copy.md) | The text on the start page and in the shell's system dialogs: layered by position on the page, one writing rule per layer; one table in `text.mjs`, a map from old keys to new keys, a test that scans the whole table |
| [IM](2026-11-04-im.md) | Talk to a Bot or a group in WeChat, Feishu, DingTalk, WeCom, QQ, Telegram, Discord and Slack: an IM bot binds to one Bot, an IM group binds to a DS Bot group; only paired accounts are accepted; replies and cards go back to the chat app; only the dsh connection that holds the team lock |
| [Mobile app](2026-10-24-mobile-app.md) | iOS and Android control the Bot team on the computer remotely: the phone runs no agent; QR pairing, end-to-end encryption, the computer only connects outward; full features, and high-privilege actions require unlocking the phone |
| [Mobile client API](2026-10-24-mobile-api.md) | The API for clients that draw their own interface (phones): handshake and versions, group chat items, notifications and resending, avatars fetched by reference, editing memory directly, usage of a single Bot |
| [Office documents](2026-10-27-office-documents.md) | Bots handle .docx/.pptx/.xlsx offline: the payload bundled with the app, the `office.js` command line, the office route replaced by a version with `office-tools` |
| [Connectors](2026-11-04-connectors.md) | The general connector engine, OAuth, gateways, email |
| [Durable waits on herdr panes](2026-11-23-durable-pane-wait.md) | A Bot waits on a herdr pane with `wait_pane` and ends its turn; the wait is kept on the board, survives restarts and new chat parts, and wakes the Bot in the card thread, group or own chat |
