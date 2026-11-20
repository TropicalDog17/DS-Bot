# Bot runtime: preset, model, thinking effort, work folder, capabilities

- Date: 2026-10-10 set the preset and capability packs; more added over time
- Related: #99 (thinking effort), #159 (model change has no effect), #208, #209 (work folder), #227 (default model for new Bots), #798 (Bots do not dispatch subagents)
- Code: `ds-bot/src/host/roster.js`, `models.js`, `folders.js`, `capabilities.js`, `permissions.js`; the new Bot form is in `src/client/bot-draft.js`

Permission presets (Read only / Workspace / Full access) and a group's shared permission are in [Roles and permissions](2026-10-07-roles-and-permissions.md) and are not repeated here.

## Why

Each Bot is an identity that works on its own. Which harness it runs on, which model it uses and which folder it works in should belong to that Bot, and should not change with the user's other settings in DSH. Otherwise, when the user changes "default for new tasks" or the default model in DSH, the whole team changes with it.

At the same time, the DSH standard harness is good enough already, so there is no need to ship a set of specialist Bots or rework the harness. Specialized abilities (writing code, doing research) are capability packs that can be added to any Bot.

## Decided behavior

### Agent preset

- There is only one Bot preset: DS Bot's Bot core plus the DSH standard harness (`standard`), unchanged.
- DS Bot owns this preset: new Bot Sessions, group Sessions and conversation parts explicitly use `standard` and **do not follow** the "default for new tasks" the user set in DSH. Only when DSH has no usable `standard` does DSH decide.
- Bot tools are attached only in the Bot scope; they do not appear in ordinary DSH Sessions.
- A Bot's own chat and group Sessions drop three kinds of DSH tools, along with the usage notes DSH writes into the system prompt for them: the question tool `ask_user_question` (Bots use their own `ask_user`); the goal tools (Bots do not run goals); the delegation tools (`subagent`, `subagent_fork`, `workflow` and others), the subagent control tools (`send_message`, `interrupt_agent`, `list_agents`) and the Agent Teams teammate tools (`spawn_teammate`, `wait_agent`, `team_task_*`, together with its `team:policy` note). Tools that DSH registers in the Agent's own scope (`subagent` and the Agent Teams tools) cannot be dropped: since DSH 0.2.2 they still appear in the tool list, and only refusal stops the calls. If a call still comes in, it is refused, with a hint that the Bot should do the work itself or hand it to another Bot. DSH Sessions that are not Bots are unchanged.
- For parallel work, several Bots work at once: `message_bot` hands out work, and `@` calls on members in a group (see [Handoffs between Bots](2026-10-16-bot-handoffs.md), [Group chat](2026-10-07-group-chat.md)). Bots do not dispatch DSH subagents: a running subagent cannot be seen or stopped by the user, it is cancelled along with the Session when the conversation moves to a new part, and its conclusions are lost (#463, #788).
- Group Sessions created earlier under the PTC preset can only call `run_code`, so DS Bot handles group relays for them separately; new group Sessions all use the standard preset (#37, #168).

### Model

- Each Bot has **its own model**, set when the Bot is created and changed later only in the Bot settings or by a Main Bot. Later changes to the DSH default model do not affect existing Bots.
- The choice is saved on the Bot's Session. DSH's `selectModel` also writes the choice as the profile's default model, so after each choice DS Bot writes the user's original default back. Only one choice runs at a time, and it waits for the write-back to finish.
- "Usable models": a model in the list whose provider still lacks a key (`needsKey`) is not usable. When DS Bot picks a model itself, it picks only from usable ones; when none is usable, it does not pick and leaves the choice to the user. A model the user picked for a Bot is kept even if it lacks a key.
- Where a new Bot's model comes from:
  - Settings → General → New Bots → "Default model" sets the team's default model for new Bots (`defaultBotModel`). Existing Bots are not affected.
  - New Bot form: preselects the team's default model for new Bots (if it is still served and usable), otherwise the DSH default model (if it is still served and usable), otherwise the first usable model. The user can change it.
  - A Main Bot calls `create_bot` without a model: it uses the team's default model for new Bots first (if it is still served and usable); when that is not set or not usable, the creator's own model (if it is still served and usable); otherwise as above (#227).
  - The team's **first Main Bot** has no model and waits for the user to pick one in its chat before it greets. If the user sends a message before picking a model, the opening is not lost: once the model is picked, the Bot first answers that message, then says in one sentence that it manages the team.
- When a Bot's turn fails because of a missing key, a wrong key, an empty balance or an expired account login, the failure is recorded on the Bot (`blocked`: failure code, HTTP status, request id, provider; the raw text is not stored) until its next turn completes, the key or provider changes, or it changes model. The fix card in the chat reads it; the card's "Retry" makes the Bot answer the user's last message again without sending it again. An opening that fails for these reasons is kept and sent again after the fix.
- When a Bot's model is no longer served: it goes back to the model it last actually used, then to the DSH default (both only when usable), then to the first usable model; when none is usable, it picks nothing.
- Providers that register later: DS Bot waits for the provider to register before it picks a model for the matching Bot, and the greeting also waits for the model to be available, so it never reports "no adapter registered".
- The model list can change quietly in DSH settings, so the picker fetches it again before it opens.

### Thinking effort

- Each Bot can set a thinking effort, in the new Bot form, the Bot details, and `create_bot` / `update_bot`.
- Only an effort level the current model offers is sent; when the model lacks that level, the model's own default applies. A provider refuses a level it does not know, so a level is never forced.
- The setting is kept when the model changes and when a new part starts.

### Work folder

- Where a Bot works: when a group has a folder, its members use the group's folder; otherwise the Bot's own; when neither is set, the team workspace.
- The user changes the team workspace in DS Bot Settings → General → "Locations". Bots and groups that use the team workspace move to a new part on their next turn; the old folder and its files are left as they are. The team workspace also cannot be inside DSH's or the team's data, or contain it; the plugin's built-in default location is inside DSH's data, and the user can switch back to it after moving away.
- A Session's folder is fixed when it is created, so changing the folder moves the conversation to a new part (see [Context and memory](2026-10-09-context-and-memory.md)).
- It cannot be set to the folder where DSH or the team keeps its data, or to a folder that contains it: a Bot that can write there can change its own permissions or the whole team.
- Setting it outside the team workspace widens what the Bot can write. So when a Bot wants to give such a folder to a Bot whose "writes are limited to the folder", it asks the user for approval first.
- The real path is saved, matching the Session's cwd display.
- A Bot can set its own folder on one sentence from the user (`update_bot`), under the same rules.
- DSH's `working_directory` tool (since DSH 0.2.1): when a Bot moves into a folder inside its work folder, only this conversation changes place; nothing is saved, no new part starts, and the next part goes back to the work folder. Moving into a folder outside the work folder means setting a new work folder for itself: the same rules as `update_bot` apply, it is saved in the Bot's settings, and the next step moves to a new part. When the group has a folder, members can only move inside the group's folder.
- When a work folder is removed or renamed from outside: a missing team workspace is rebuilt automatically; when a Bot's or group's own folder is missing, DS Bot switches to the fallback folder before building the prompt, then moves to a new part there, so no message is lost (#209).

### Capabilities

- Settings → Capabilities is a list shared by the team, with three kinds: MCP servers, skills, and capability packs (a set of MCP servers and skills).
- Capabilities only **add**: tools, skills, MCP servers, prompt sections. Settings that can only have one value (how tools are presented, persona, compaction engine) do not go into capability packs; they are Bot-level settings.
- Once enabled for a Bot, a capability takes effect from its next message, and also in the group chats it is in.
- A local MCP command that a Bot adds runs only after the user approves it. A capability that other Bots use can only be changed or removed by the user or a Main Bot; a creator that is not a Main Bot cannot rewrite a capability a Main Bot uses.
- A secret needed in an MCP config is written as `$DSH_SECRET_<name>`; the value comes from the secret store and is not written into the config.
- Names use only lowercase letters, digits and single hyphens, up to 32 characters; `github` is reserved for the built-in GitHub connector.

## Not done

- No preset specialist Bots (writer, programmer, ...). There is only one default Bot; the user and Main Bots create the specialists.
- No rework of the DSH standard harness: only the tools above, which Bots do not use, are dropped.
- Bots do not follow the "default for new tasks" preset or the default model the user set in DSH.

## Known limits

- **"Usable" only checks whether a key is set**: `needsKey` only covers providers whose profile entry has `apiKeyEnv`. A key that is set but wrong, a zero balance, or a login-based provider such as a DeepSeek account that is not logged in all still count as usable, and this only shows when the first turn fails (a fix card follows the failure). Checking the key when it is saved and greeting only after it works is M2 in [Windows onboarding](2026-10-26-windows-onboarding.md).
- The contents of the "coding" and "research" capability packs are not decided yet.
- Delegation tools are recognized by their DSH default names; one renamed in the profile (`toolName`) is not recognized.

## Changes

- 2026-10-10: DS Bot owns the Bot preset; no preset specialist Bots; capability packs only add.
- 2026-10-14: new Bot Sessions, group Sessions and parts explicitly use `standard`, which fixes group chats not relaying under the PTC preset (#37).
- 2026-10-16: when a work folder is removed or renamed, the team workspace is rebuilt automatically or DS Bot switches to the fallback folder and moves to a new part, so messages are no longer lost (#209, PR #250).
- 2026-10-19: when a Bot uses DSH's `working_directory` to move outside its work folder, this counts as setting its own work folder (with the same checks and approval) and moves to a new part; moving inside the work folder only steps in (#345).
- 2026-10-20: the user can change the team workspace in Settings; the Chinese label `团队工作区` was renamed `总工作区` (both "team workspace" in English) (#364).
- 2026-10-26: when DS Bot picks a model itself, it picks only usable ones (not those lacking a key); typing first no longer loses the first Main Bot's opening; credential failures are recorded on the Bot for the fix card and "Retry" ([Windows onboarding](2026-10-26-windows-onboarding.md) M1).
- 2026-10-30: `create_bot` and `update_bot` can already set thinking effort, so the outdated limit "can only be set in the interface" was removed (#99).
- 2026-11-01: Bots no longer dispatch DSH subagents: the delegation tools and subagent control tools do not appear in Bot Sessions, and the goal and workflow usage notes are removed from the Bot system prompt (#798).
- 2026-11-02: Settings → General can set a team default model for new Bots; the new Bot form and `create_bot` without a model use it first (#227, PR #823).
