# Propose AGENTS.md updates from project work

- Date: 2026-10-27 set the behavior
- Code: `ds-bot/src/host/learning.js`, `src/client/learning-card.js`

## Why

A user's lasting requirements for a project, repeated corrections and check steps belong in the project's `AGENTS.md`, so that every Bot that later works in that folder can read them. The file should stay short and accurate; a Bot can only propose changes backed by evidence from its work, and cannot write them itself.

## Decided behavior

- Reuse the existing learning schedule and the pending work records. A folder is reviewed at most once per round, and the review gathers the work of all Bots in it.
- Only folders that pass the `workFolder` check and contain `.git` or `AGENTS.md` are reviewed. A missing `AGENTS.md` can only be created in a folder that contains `.git`.
- No change by default. A candidate rule must apply to most later tasks, be backed by evidence, not be obvious, stay valid for a long time, and not repeat a rule already in the file.
- A proposal contains only 1–3 exact whole-line additions, replacements or deletions. Secrets, dates, versions and task numbers are checked; files that are too large and results that are invalid or make no real change are not proposed.
- The proposal shows in a conversation card of the Bot concerned, with the folder, the diff of each item and the reason. It is written only after the user approves.
- Before approval, DS Bot checks again that the file is still the same as when the proposal was made; if it matches, it writes a temporary file in the same folder and replaces the file atomically. If the file has changed, the proposal is kept and the user can reject it.
- Rejected changes are recorded per folder for later reviews to refer to. `agentsMd: false` turns off only the project file review, not skill learning.

## Not done

- Project files are not written or replaced automatically.
- No timers for ordinary tasks, no review of folders without a project marker, and no progress of a single task written into `AGENTS.md`.

## Known limits

- Whether a Bot proposes an update depends on whether the model can find a lasting, reusable rule in limited work records; when unsure, it should propose nothing.
- Only an `AGENTS.md` that fits the size limit and can be read is handled.

## Changes

- 2026-10-27: set the behavior of a silent project file review and an atomic write after the user approves.
