---
name: herdr-panes
description: Hand coding work to agents in herdr panes and follow it from a Bot - find or start the right pane, prompt it, wait without holding your turn, read the result. Load before any herdr command.
---

# herdr panes, from a Bot

A Bot runs outside herdr and drives it with the `herdr` binary (`herdr` on PATH, or `~/.local/bin/herdr`). `herdr <group> --help` is the authority on flags; the commands below are the ones a Bot needs.

## Pick the pane

1. `herdr agent list`: every agent with its pane id (like `w1:p1T`), cwd, `agent_status` and `terminal_title` (what it is doing).
2. Work on the repo, branch, PR or topic a pane is already on continues in that pane. Read where it is first: `herdr agent read <pane> --lines 80`.
3. New work, or the only pane on that repo is busy with something else, gets a pane of its own:
   - the repo has a workspace (same cwd): `herdr tab create --workspace <workspace id> --cwd <repo> --label <name> --no-focus`
   - it has none: `herdr workspace create --cwd <repo> --label <repo name> --no-focus`
   - take the pane id from the JSON, then `herdr agent start <name> --kind claude --pane <pane id>` (`--kind opencode` for OpenCode). The name is lowercase letters, digits, `-` or `_`, and not taken.
   - when another pane has uncommitted changes in the same repo, give the new one a worktree (`herdr worktree --help`).

## Hand the work over

- Prompt only a pane that is `idle` or `done`. A `working` pane is busy. A `blocked` pane waits for input or an approval: read its screen and tell whoever gave you the work; do not answer for the user.
- `herdr agent prompt <pane> "<task>"`, without `--wait`. Say the task, when to stop, and what to report.
- One task per pane at a time. Different panes run side by side.

## Wait without holding your turn

- After the prompt: board update with `pane` and a one-line progress, call `wait_pane` with the pane, and end your turn. You are woken in the same conversation when the pane is done, idle or blocked, also after a restart.
- Never wait with `herdr agent wait`, `herdr agent prompt --wait`, a background job, job_output wait or sleep. While your turn is held, the user's messages and card notes do not reach you, and a restart loses the wait.

## When you are woken

- `herdr agent read <pane> --lines 120`, board update the progress in one line, then report: the pane, what it did, the result, links to the PR or commit, and what the user must decide.
- To stop a pane's work: `herdr agent send-keys <pane> esc`.
- Never `/clear` or restart an agent that is already there.

## Close the pane when its work is finished

Close a pane only when all of these hold:

- you opened it for this card (`tab create` or `workspace create`) and it is on the card's `herdr pane:` line; a pane you found already there is never yours to close;
- nothing waits on it: you are completing the card, and no open PR may still need fixes from it;
- its agent is `idle` or `done`, and `git status` in its cwd shows nothing uncommitted or unpushed;
- you read its last screen (`herdr agent read <pane> --lines 120`) and put the result and links on the card.

Then `herdr pane close <pane>`. If you created a tab or workspace for it and it is now empty, close that too (`herdr tab close <tab id>`). When one condition fails, leave the pane open and say why in your report.
