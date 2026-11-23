# The `/` menu in Bot chats and group chats

- Date: 2026-11-13
- Related: Issue #810 (see also #133, #791)

## Why

DS Bot has already replaced the command button in the Bot chat and group chat input box
with its own "+" menu, but typing `/` still opens DSH's command menu, and from there both
the user and the Bot can get back to DSH commands. For example `/goal` goes to DSH's
long-task goal instead of the group goal, and `/plan`, `/permission`, `/compact` and others
also bypass the interface and behavior that DS Bot keeps for Bots.

DSH 0.2.2-rc.1 has no documented API to "remove a DSH command from the `/` menu of one
Session":

- The host `commands` registry has only `register` / `list` / `find` / `execute`, with no
  per-Session removal. An agent-scoped registration can **shadow** the definition of a
  command with the same name, but that row is still in `list(agent)`.
- The client `/` menu sources are registered at the **root, globally**.
  `InputTriggerService` resolves the controller only by session and has no interface to
  hide other sources per Session. The README of `dsh-client-ui-input-trigger` says under
  "Known Limitations": "Global source layer only — session-scope source registration
  (per-session shadowing) is designed but not enabled".
- A client `ctx.commandUi` contribution with the same name as a host command fails with an
  error (it cannot shadow). A decoration only replaces the host's bare invocation; it keeps
  the catalog row and argument claiming, and cannot remove the row either.

So this version does only what the documented API allows: **the DSH rows are still in the
menu, but a typed `/command args` in a Bot chat or group chat does not run the DSH
command**. It also adds DS Bot's own actions to the `/` menu.

## Decided behavior

- The host module `src/host/agent-commands.js` mounts a small plugin on every Agent and
  gets the command service through reflection (`child.get('commands')`). Reading
  `agent.ctx.commands` directly throws "cannot get property commands without inject", so
  it must be a plugin mounted under the agent context. It does not use
  `inject: ['commands']`: in practice the injection resolves only on the first Agent, and
  Agents mounted later do not get the service, while a reflective `get` works on every
  Agent. Only when the Session is confirmed to be a Bot's own chat or a group's own room
  Session does it register same-name shadow commands for **all currently visible command
  names** in that agent's scope.
- A new Bot's Agent may appear before the Bot's state entry: the plugin mounts first and
  checks again once the state is saved (`onSaved`), so the new Bot's first command is not
  missed.
- Typing `/name args` in these Sessions: the DSH handler does not run, and a clear result
  is returned; `/goal` says to track the work as a card on the board. Skills (a
  separate `/` source) are not affected.
- It listens to the global `commands/change`: it first lifts its own shadows, then takes
  the current set and registers again, so new commands are shadowed too. Shadows are
  unmounted with the Agent scope.
- The whole shield is in one module behind one switch: host config `commandShield: false`
  turns it off. Removing this module and its line in MODULES in `index.js` retires it
  completely (that is the step to take once DSH upstream enables per-Session source
  filtering).
- The client `src/client/command-actions.js` adds DS Bot action rows through
  `ctx.commandUi`:
  - `/scheduled-task`: opens the scheduled tasks of this Session (Bot or group).
  - "Reference a chat" stays in the "+" menu: `ActionSpec.run(session)` receives only the
    Session, not the composer's caret or insertion, and the reference menu depends on the
    span from `captureInsertion`.
- DSH Sessions that are not Bot Sessions stay as they are.

## Not done

- No removing DSH command rows from the menu (the documented API cannot do it).
- No intercepting `/` at the DOM level and no redrawing the composer ourselves (that would
  give the menu two sources of truth and depend on DSH's internal interface structure).
- No replacing the whole composer component.

## Known limits

- DSH command rows are still visible in the menu; what is guaranteed is that typing them
  does not run them. First-party command rows keep DSH's own titles and descriptions (the
  client renders by definition identity); the shadow replaces only the execution.
- On the command path (menu open, a row selected, or Enter pressed directly) the user gets
  DS Bot's clear refusal. If the user presses Esc to close the menu first and then types
  the line, it is sent to the Bot as an ordinary message. Neither path runs the DSH
  command.
- If another plugin registers a command with the same name in the same scope of the same
  agent, shadowing fails with a warning, and that command may still run the DSH version.
- When a skill has the same name as a host command, DSH's existing rules still resolve it
  to the host command (which is now shadowed to DS Bot's refusal). Skills whose names do
  not clash with host commands work as usual.
- Once DSH upstream enables per-Session source filtering (#133), this module should be
  removed and the menu should use native filtering.

## Changes

- 2026-11-23: the group Goal is retired ([Main Bot router](2026-11-22-main-bot-router.md)); the bare `/goal` row in group chats is gone and `/goal` is refused like other DSH commands.
