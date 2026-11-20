---
name: issue-triage
description: "Triage issues and pull requests in the DS Bot repository: add type, priority and area labels, decide whether to close, ask for more information, move to Discussions or keep for work, and write the result back to GitHub. Triggers: triage, sort issues, add labels, set priority, should this be closed, ask the reporter, needs-info expired."
---

# Issue triage

Goal: every open issue has **one type and one priority**, and an area when needed; every closed issue has
**evidence**.

[CONTRIBUTING.md](../../../CONTRIBUTING.md#how-we-work) defines what the labels mean and the workflow. This
file only says how to do the work.

**Limits**: only change labels, comments and the open/closed state of issues and pull requests. Do not change
code, do not edit issue bodies, do not merge pull requests. Items with the `maintainer` label get triaged, but
you do not decide them.

## 1. Take a snapshot

Run in the repository root (read-only, does not write to GitHub):

```sh
node .agents/skills/issue-triage/scripts/snapshot.mjs --out /tmp/triage
```

Read `digest.md` before you decide; do not judge by the title only. The digest lists each issue with: labels,
age in days, comment count, a summary of the body and of other people's comments, the commits on `dev`/`main`
that reference it, and the open pull requests that reference it. At the top is **To do**:

- issues with no type or no priority
- issues with two priorities
- `needs-info` older than 14 days with no reply from the reporter

Read [references/gh-gotchas.md](references/gh-gotchas.md) before you start.

## 2. Classify

Give each item three coordinates:

| Coordinate | Values | How to decide |
|---|---|---|
| Type | `bug` · `enhancement` · `documentation` | It is a `bug` only when the behavior differs from the design. When the design is already like that and the user wants something else, it is an `enhancement`. If you are not sure, read [docs/vision.md](../../../docs/vision.md) and [docs/plans/](../../../docs/plans/) first |
| Priority | `P0`–`P3` | `P0` crash, data loss, completely unusable · `P1` affects daily use, a newly introduced regression · `P2` normal bug or feature · `P3` suggestion, narrow case |
| Area | one of `area/*` | Decide by the directory the change would land in. If it spans several areas or belongs to none, add no area |

Rules:

- **Keep an existing priority by default.** It is an earlier decision, not noise. If you think it should change,
  give the reason in a comment.
- **An issue has only one P label.** `--add-label` does not remove the old one; to change the priority, also
  use `--remove-label`.
- Pull requests get no type and no area.

## 3. Decide the action

Group by evidence. **When the evidence is not enough, keep the issue for work**; do not close on a guess.

| Group | Criterion | Action |
|---|---|---|
| Fixed, not released | A commit or a merged pull request on `dev` fixes it | Do not close. Comment with the pull request number; the release pull request's `Fixes #N` closes it at release |
| Fixed, released | The fix is on `main`, CHANGELOG records it, or you can point to a test that guards it | Close as `completed`; the comment names the exact pull request, commit or test |
| Duplicate | Same cause as another issue | Add `duplicate`, link the other one, close as `not planned` |
| Upstream | The cause is in DSH or another plugin | Add `upstream`, link where it belongs. When there is nothing to do on our side, close as `not planned` |
| Question | How to install, how to use | On the web page, **Convert to discussion** into Q&A (the CLI cannot do this, see gotchas) |
| Missing information | The problem cannot be located: no version, logs or steps to reproduce | Add `needs-info` and ask once (template below) |
| `needs-info` expired | No new information 14 days after asking | Close as `not planned`, comment "No further information received; we will reopen this when it arrives" |
| Pull request in progress | An open pull request references it | Leave it |
| Needs direction | Touches product direction, a decided design, the workflow rules, releases or architecture | Add `maintainer` and wait for the maintainer |
| Keep for work | Everything else | Labels are enough. Small, clear ones can get `good first issue` |

## 4. Write comments and close

- **Use the issue's own language**: Chinese if the body is in Chinese, English otherwise.
- A closing comment must be evidence for why the issue can be closed: pull request number, commit hash, file
  and test name, the duplicate issue number, the reporter's own correction.
- Close and comment in one command: `gh issue close <n> --reason "completed" --comment-file <file>` or
  `--reason "not planned"`.
- Write a Chinese comment into a UTF-8 file first, then send it with `--body-file` or `--comment-file`.

Template for asking (edit as needed; say clearly **what is missing**):

```text
Thanks for the report. To find the cause, please add:
1. The DS Bot and DSH versions.
2. … (the specific thing that is missing)
3. …

If there is no new information within 14 days, we will close this issue for now; we will reopen it when you add it.
```

## 5. Read back and check

After writing back, fetch again and confirm:

```sh
gh issue list --state open --limit 300 --json number,labels --jq '.[] | select([.labels[].name | select(test("^P[0-3]$"))] | length != 1) | .number'
gh issue list --state open --limit 300 --json number,labels --jq '.[] | select([.labels[].name | select(. == "bug" or . == "enhancement" or . == "documentation")] | length == 0) | .number'
```

You are done only when both print nothing.

## 6. Report

Report a table to the person who asked: number, title, labels added, action, evidence. Show closes and
follow-up questions to them before you run them; send them after they confirm.
