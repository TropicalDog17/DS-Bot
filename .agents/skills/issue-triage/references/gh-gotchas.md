# gh and GitHub gotchas

Problems we ran into during triage. Read this before you start.

## Labels

- `gh issue edit --add-label P2` does **not** remove the old `P3`. To change the priority, write
  `--add-label P2 --remove-label P3`, then read back as in step 5 of the SKILL.
- Label names are case-sensitive: `p1` and `P1` are two labels. Use only existing labels; do not create new
  ones on the fly.

## Closing

- `Fixes #N` works only when the pull request is merged into the **default branch `main`**. A fix merged into
  `dev` does not close the issue, on purpose: an open issue means "fixed on `dev`, waiting for the release".
  The release pull request lists every `Fixes #N` of the batch in its body.
- There are only two close reasons: `completed` (fixed, answered) and `not planned` (duplicate, upstream, will
  not do, missing information expired). Quote the `--reason` of `gh issue close`: `--reason "not planned"`.

## Moving to Discussions

- **Convert to discussion is only a button on the web page.** Neither REST nor `gh` has this operation. During
  triage, list the issues to move and ask someone with write access to click it in the issue page's right
  sidebar.
- After the move, the old issue number redirects to the discussion, and all comments move with it.

## Chinese text and Windows

- In PowerShell or cmd, Chinese text passed directly in `--body` or `--comment` can be garbled or cut off.
  Write Chinese text into a UTF-8 file first, then use `--body-file` or `--comment-file`.
- Git Bash rewrites `/tmp/...` arguments passed to Windows programs into `%TEMP%\...`.
  `snapshot.mjs --out /tmp/triage` really writes to `%TEMP%\triage`; when you then read the files in node, use
  the path that the script prints at the end.
- Strings in `--jq` cannot contain escapes like `\s` or `\|`; write `[\n ]` and `[|]` instead.
- `gh issue list --search` does not match Chinese titles reliably and can miss results. To find duplicates,
  fetch everything with `--json number,title,body` and filter locally.

## Queries

- `gh issue list` returns only 30 items by default; add `--limit`.
- `gh issue list --json comments` fetches all comments and is slow when there are many; the snapshot script
  fetches them only when needed.
- To filter labels in `--jq`, use `[.labels[].name]`, not `.labels.name`.
