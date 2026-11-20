---
name: record-browser-gif
description: "Record browser / web interface actions as an optimized GIF: prefer the browser-control workflow that is available now (when it supports recordVideo, turn on Playwright Videos for a higher frame rate), use the bundled encoder to trim, change speed, hold the last frame and control size and file size; to attach it to a pull request use gh --attach, and fall back to a dedicated assets branch when that is not available. Triggers: record a GIF, screen recording, interface demo, pull request demo evidence, screenshots. A pull request that changes user-visible interface behavior needs screenshot evidence by the template; a GIF recorded with this skill from that pull request's branch, with the real service and a real model flow, meets it."
---

# Record a browser demo GIF

Produce a short, real interface demo GIF. Run the publishing steps at the end only when the task includes
"attach it to the pull request". Prefer the browser-control workflow that is available now; when that workflow
supports continuous video, use [Playwright Videos](https://playwright.dev/docs/videos) for a higher frame rate.
Use the bundled encoder (`scripts/encode_gif.py`) for trimming, speed, the final hold, dimensions and file size.

Two rules come from the DeepSeek Harness skill of the same name (source in `NOTICE`): one storyboard comes from
one isolated run only; before publishing, check the output and the demonstrated pull request's head commit
again.

## Demo GIFs for interface pull requests

A pull request that changes user-visible interface behavior needs screenshot evidence by the pull request
template. A GIF recorded with this skill meets that requirement; embed it in the pull request body or attach it
to a comment (see [Publish the GIF](#publish-the-gif)).

The recording itself is part of the evidence: start the real service from that pull request branch's code tree,
use a real API key, run real model turns. Do not replace them with fixture queries, a mock transport, synthetic
event injection or test hooks, unless the user explicitly asks for a fixture recording. Next to the GIF, state
the exact commit SHA demonstrated, the code tree that served it and where it came from, any mode switches or
browser-state exceptions, and whether real model turns ran, so reviewers know what the recording proves.

## Keep recording and publishing apart

- Recording produces only local video or screenshots and a `.gif`, and never touches remote state.
- Publishing (attaching the GIF to the pull request with `gh --attach`, or, when that is not available, pushing
  to an assets branch and embedding the URL) is a separate last step, run only when the task includes attaching
  it to the pull request. It never touches the pull request's own branch.
- Keep the agreed recording conditions. A real-service / real-API demo must not be swapped for fixture
  queries, a mock transport, synthetic event injection or test hooks. When credentials or the service are not
  available, report it honestly; do not substitute a fixture.
- Never read or expose credential values. Use the app's normal configuration path and a harmless demo prompt.
  Screenshots and videos must not show keys, tokens or personal data either (a hard requirement of the pull
  request template).

## Set up the app being demonstrated

A GIF recorded for a pull request demonstrates that pull request's code tree. Set it up per pull request:

1. The working tree must be clean. Record the exact commit with `git rev-parse HEAD`, and build that recorded
   tree: for interface changes run `npm run build` in `ds-bot/` (`src/client` → `client.js`). Recording with
   build output from another commit is false attribution.
2. Start DSH Web from that tree with the test bench: `dev/bench.sh <name> <web-port> <mock-port> reset` (the
   bench needs a deepseek-harness checkout: `../deepseek-harness` or `DSH_HARNESS`, version in the README). The
   bench links the plugin to the current checkout: host code changes take effect after a restart, `src/client`
   changes after `npm run build` and a page reload. All data lands in the gitignored `.dsh-test-<name>/`, and
   `reset` first clears the Bot team and Sessions. Run only one service per port. Use a fresh, isolated browser
   context or profile as well; when the browser workflow cannot create an isolated environment, clear that
   origin's cookies and site storage before navigating, so leftover client state does not taint the evidence.
3. The bench runs the mock model (`dev/mock-llm.mjs`) by default. To record real model turns, configure a real
   provider in that bench's own data directory (through its web settings page). Never point the bench or any
   test at `~/.dsh`, at the desktop app's data or at a DSH the user is running (hard rule 5 of the repository).
   To demonstrate the desktop app window (`app/ui` or Electron behavior), start it in `app/` with a throwaway
   data directory instead: `DS_BOT_HOME=<throwaway-dir> npm start` (see `app/README.md`).
4. One storyboard is one evidence run: every published frame comes from the same service, the same set of state
   roots, the same workspace / Session and the same model scenario run. When capture automation fails, discard
   its frames and run again from fresh state roots; never splice frames from different runs.
5. Stop the services you started when you finish recording or switch pull requests:
   `dev/bench.sh <name> <web-port> <mock-port> stop` (the bench stops the process group by pid file). Do not use
   a broad `pkill -f`: it can match and kill the shell that started it, including your own.

## Recording

Follow the setup, interaction and cleanup instructions of the browser-control workflow that is available now.
When it exposes `recordVideo`, turn on video on the same controlled context to capture more intermediate frames;
otherwise use [screenshot capture](#screenshot-capture) in that workflow. Whether video is available does not
decide which browser-control workflow to use. The user's existing browser state counts as an explicit isolation
exception.

Only when browser control is not available, fall back to Playwright in an isolated headless browser, and say in
the capture notes that you used the fallback. This repository declares no Playwright dependency: resolve it from
a Playwright install already in the environment (for example the agent's own CLI / MCP). Do not add a
dependency to the repository for recording, and do not open the user's browser.

Before recording, confirm the origin, the build output or dev server, the transport and the mode switches. When
the production default opens a native interface that automation cannot drive, choose the official
browser-operable production backend through the normal app configuration, and disclose that substitution.

Put scripts, raw video, timing notes, QA frames and the GIF under the repository's gitignored `.playwright-mcp/`
directory. Create the run directory first.

### Capture video

Make `viewport` and `recordVideo.size` match explicitly: otherwise Playwright scales the video into 800×800 and
the interface text blurs.

Configure video through the chosen browser-control workflow. For the standalone Playwright fallback:

```js
import { chromium } from 'playwright'  // resolved from the environment; this repository does not carry the dependency
const browser = await chromium.launch()
const size = { width: 1440, height: 900 }
const context = await browser.newContext({
  viewport: size,
  recordVideo: { dir: join(runDir, 'videos'), size },
})
try {
  const page = await context.newPage()
  const video = page.video()
  // Navigate and operate the real app here.
  await context.close()
  await video.saveAs(join(runDir, 'demo.webm'))
} finally {
  await context.close()
  await browser.close()
}
```

Import `join` from `node:path`; write the new `runDir` as an absolute path in the recording script. Keep the
page's video handle before closing the page; `await context.close()` first, then `video.saveAs()` or encode.
Closing only the browser does not guarantee the video is written to disk. Each page has its own video: choose
the demonstrated page explicitly, and do not chain unrelated pages or runs. A failed run is only for diagnosis.

Pick a short story with three to six meaningful states. Before each action, wait for a unique semantic locator;
use `exact: true` for accessible-name equality, and use exact text for the final assertion that cannot falsely
match the echoed prompt. Fixed waits are only for a reading pause after a state is confirmed, never to establish
readiness. Keep animations and scrolling during recording.

When demonstrating a tool call, a refusal or a recovery, expand its details or trace so the video shows the
tool's identity, the status or stable error code, and the downstream result. When a transient running state
matters, trigger it with one slow foreground action and watch its specific DOM marker; continuous video captures
the intermediate frames. Give the model a short closing sentinel to anchor completion. A real-API run can stop
once the demonstrated state is visible; it does not have to run to the end.

Do not capture keys, personal data, unrelated tabs or notifications. Browser video contains only page content,
not the browser chrome; avoid rendering URLs with credentials in the app. Review the whole chosen range,
including the intermediate states. Keep one viewport throughout.

## Encode the GIF

Needs `python3`, `ffmpeg` and `ffprobe`. When media binaries are missing, report the dependency honestly; do not
install software without permission. Export `GIF_SKILL_DIR` on its own line; an inline assignment in the same
command does not affect argument expansion.

```sh
export GIF_SKILL_DIR=<repo>/.agents/skills/record-browser-gif
python3 "$GIF_SKILL_DIR/scripts/encode_gif.py" \
  /absolute/path/to/demo.webm \
  /absolute/path/to/demo.gif \
  --start 2 --end 32 --speed 2 --final-hold 3 \
  --fps 10 --max-width 1200 --colors 128
```

`--start` and `--end` select one continuous source range in seconds. By default the encoder keeps the whole
video at 1× speed and adds a two-second final hold. `--speed` changes the playback speed; disclose it and the
chosen range next to the GIF, so the demo does not suggest measured response latency. Use times observed in the
video; do not guess wall-clock offsets. Keep the full cause and effect of the demonstrated behavior. The final
hold repeats the last frame. `--fps` is the encoding frame rate; raising it cannot recover motion that the
source video did not capture. Keep the raw WebM for QA; do not splice different runs, and do not synthesize
missing states.

The encoder probes the WebM container duration, trims and changes speed before the palette conversion, and
checks the encoded duration, animation, width and byte size. It rejects empty or out-of-range ranges, selections
with fewer than two output frames, switches that do not fit the mode, and unexpected overwrites. When the output
is too large, lower `--max-width` first, then `--colors` or `--fps`; keep the text readable. Use `--force` only
after you have confirmed the output path is right.

### Screenshot capture

When continuous video is not available, or the user wants a storyboard, follow the available browser-control
workflow and use the browser's screenshot API to capture three to six verified states from one isolated run.
Save the returned image bytes directly into the same run directory: `00-initial.png`, `01-typed.png`, … with
consistent dimensions and cropping. For a transient state, poll its DOM marker and take the screenshot within
the same browser script call.

```sh
python3 "$GIF_SKILL_DIR/scripts/encode_gif.py" \
  /absolute/path/to/frames /absolute/path/to/demo.gif \
  --durations 1.5,1.5,1.5,3.5 --fps 10 --max-width 1200 --colors 128
```

One duration applies to every screenshot; otherwise give each frame a positive duration, and let the settled
state stay longest. A directory input rejects fewer than two frames, mismatched dimensions or a wrong number of
durations. The video timing switches apply only to video files; `--durations` and `--pattern` apply only to
screenshot directories.

## Check the output

1. Read the encoder's JSON summary and confirm the output path, the source range and speed (or the screenshot
   count), the encoded frame count, the dimensions, the duration and the byte size.
2. Look at the encoded GIF itself, not only the source frames. Confirm the transitions are clear and readable,
   the last state stays long enough, and there is no sensitive content. When the viewer renders only the first
   frame, extract representative frames from the GIF with `ffmpeg` and check them; screenshots from before
   encoding do not prove the encoded order, palette or final hold.
3. Run `git status --short` and confirm raw video, QA frames and outputs land only under ignored paths.
4. Return the GIF's absolute path, render it if the client supports local media, and say whether the recording
   used the real API, a fixture or another transport. If the task does not include attaching it to the pull
   request, stop here.

Encoder upkeep: with the media dependencies installed, run
`python3 -m unittest discover -s "$GIF_SKILL_DIR/scripts" -p 'test_*.py' -v`. These local media tests are not
part of the repository's CI.

## Publish the GIF

Run this section only when the task includes attaching the GIF to the pull request.

Never commit the GIF to the pull request's own branch or to any branch that will be merged into a long-lived
branch: binary media in history slows down every future clone. Prefer `gh --attach`: it uploads the GIF to
GitHub and rewrites the reference in the body in the same command, so no branch has to carry the media.

### Attach with gh

`gh --attach` needs gh v2.99.0 or newer (`gh --version`), a repository on github.com (GitHub Enterprise Server is
not supported), write access to the repository, and a GIF of at most 10 MB. First confirm the checked output is
within the limit; if it is over, compress it as above before attaching.

Write the GIF into the body file as a normal local path reference, the same path you pass to `--attach`; `gh`
rewrites the reference in place to the uploaded URL, keeping its position and alt text:

```markdown
![<alt text>](<path/to/demo.gif>)
```

The demonstrated pull request is usually the publishing target. A tooling pull request can also embed an example
that is clearly labeled as coming from another pull request: name that source pull request, and compare its live
head in each check below. Never attribute the example to the tooling branch's head.

Right before attaching, read the demonstrated pull request's live head again (for a new pull request, the tip
of the pushed branch) and compare it with the commit recorded next to the GIF. If it moved, stop and record
again. Then attach:

```sh
gh pr create --body-file <body.md> --attach <path/to/demo.gif>     # new pull request
gh pr edit <pr> --body-file <body.md> --attach <path/to/demo.gif>  # existing pull request body
gh pr comment <pr> --body <text> --attach <path/to/demo.gif>       # attach to a comment only
```

`--attach` can repeat, but rejects the same file twice. A GIF that the body does not reference is appended at
the end; then the alt text on the switch (`--attach '<path>#<alt text>'`) applies; a rewritten reference keeps
the alt text from the body. After attaching: read the live head again and confirm it is still the recorded
commit; read the live body again and confirm the reference points to the uploaded URL; render the body with
GitHub's Markdown API and confirm the expected `<img>` appears; request the upload URL once and confirm `200`
and `image/gif`.

### Fall back to an assets branch

Use an assets branch only when `gh --attach` is not available: the GIF is still over 10 MB, gh is older than
v2.99.0, or the repository is not on github.com. The GIF goes on a dedicated orphan assets branch (no parent
commit, media only). One assets branch serves a whole series of pull requests (name it `<series>-assets`; list
the existing ones with `git ls-remote --heads origin '*assets*'`).

In both flows, verify before pushing: the assets branch holds only media, and the checksum of the GIF to attach
matches the locally checked output.

When an assets branch already exists, work in a shallow, single-branch temporary checkout, so publishing cannot
touch your working tree:

```sh
git clone --branch <assets-branch> --single-branch --depth 1 <repo-url> /tmp/assets-checkout
cp /absolute/path/to/demo.gif /tmp/assets-checkout/<name>.gif
cd /tmp/assets-checkout
git add <name>.gif
git commit -m "assets: <what it shows> gif (#<pr>)"
git push origin <assets-branch>
```

For a new series, make a shallow temporary checkout (`git clone --depth 1 <repo-url> /tmp/assets-checkout`),
create the orphan branch with `git switch --orphan <assets-branch>`, then add, commit and push the same way.

After pushing, confirm the remote path, byte size, checksum, `200` response and `image/gif` type with an
authenticated GitHub API or raw request. An anonymous `404` does not disprove an asset in a private repository;
verify with an authenticated request. This proves the review path for repository members, not public
reachability.

Right before editing the pull request body, read the demonstrated pull request's live head again and compare it
with the commit recorded next to the GIF; if it moved, stop and record again. After editing, read the live head
again and confirm it is still that commit. Also render the body with GitHub's Markdown API and confirm the
expected `<img>` appears.

Embed the GIF in the pull request body with the raw blob URL. The `?raw=true` suffix is required: a plain blob
URL renders GitHub's file page, not the image:

```markdown
![<alt text>](https://github.com/<owner>/<repo>/blob/<assets-branch>/<name>.gif?raw=true)
```

Never delete or rewrite the assets branch, and never force-push: the bodies of merged pull requests reference
its URLs forever. Only add new commits.
