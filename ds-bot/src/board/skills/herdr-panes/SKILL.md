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
- DS Bot tracks panes you create with `herdr tab create`, `herdr workspace create` or `herdr pane split`. When the card reaches Review, Done or Cancelled and the pane has finished its work, DS Bot saves the last output and closes it. For a pane created outside a card, call `wait_pane` with `release: true` when you finish.
- Never close a pane, tab or workspace, and never `/clear` or restart an agent that is already there.
