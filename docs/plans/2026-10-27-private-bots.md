# Private Bots

- Date: 2026-10-27
- Related: Issue #597

## Why

Bots in a team work together by default: they can see each other's status, memory and
work. But some tasks are meant only for the user and one Bot. A private Bot gives a
one-way boundary: it can still read the team, but other Bots cannot read it, and the user
decides when it shares content with other Bots.

This boundary applies only between Bots. It is not an operating system sandbox, and it
does not hide content from the model provider.

## Decided behavior

### Switch

- Each Bot's settings page has a "Private" switch. Only the user can turn it on or off; a
  Bot cannot change its own or another Bot's private state through tools.
- A private Bot cannot be a Main Bot and cannot join group chats. A Bot that is already a
  Main Bot or a group member must first drop that role or leave the group chat.
- A private Bot cannot be duplicated, so its instructions and folder are not carried into
  a new public Bot.
- The interface has English and Chinese text; impossible states are disabled in settings.

### Separate folder

- A private Bot must have its own work folder.
- This folder must not contain, or be contained in, the team workspace, another Bot's work
  folder or a group folder. Path comparison resolves links; when the target file does not
  exist yet, the deepest existing parent directory is resolved.
- Other Bots, groups or the team workspace cannot be changed to a folder that overlaps a
  private Bot's folder.
- Non-overlapping folders are a hard requirement: DSH's search tools walk directories, and
  a plugin cannot reliably remove part of the files from search results.

### What other Bots cannot see

- `list_bots` shows other Bots only the private Bot's name, role and private state, not
  its instructions, current work, model or folder.
- Other Bots cannot send it `message_bot`, cannot act on it with `stop_bot` or
  `update_bot`, cannot change its capabilities with `attach_capability` or
  `detach_capability`, and cannot read or change its memory through `recall`, `remember`
  or `forget`.
- File tools, image reads, `glob`, `grep`, `working_directory`, the `cwd` of `subagent` /
  `subagent_fork` and Session queries check their target, and refuse when it hits the
  private Bot's folder, memory or Sessions. Another Bot searching across Sessions must give
  a checked, safe Session id or parent Session id; it cannot run an unfiltered global
  search.
- Session targets are traced along `parentSession`; the private Bot's subagent Sessions
  are closed in the same way.
- The team status file, the shared chat index, the memory change log and staging files are
  also closed to other Bots. While a private Bot or its kept archive exists, other Bots
  cannot run directory-walking searches in the data location and cannot read the shared
  data files there directly. Their own folders, the team workspace and team shared memory
  still work as usual.
- A private Bot's memory change log is kept in its own protected directory, and the
  before and after text of its entries is not written into the team shared log.
- A subagent inherits the identity of the top-level Bot; nesting several levels deep does
  not change the boundary.

### What a private Bot can do

- It reads public Bots and team shared content as before, including the memory of other
  public Bots.
- It can read its own folder, memory and Sessions, and anything else in the team that it
  is allowed to read.
- It needs the user's approval before it sends `message_bot` to another Bot, saves a
  shared capability that all Bots can read, or writes a file outside its own folder.
- The approval card shows the recipient and the full content to be shared. On reject,
  cancel or no answer, the action does not run.
- Reading and writing in its own folder needs no extra approval.

### After deletion

- Deleting a private Bot does not make the content it leaves behind public.
- Its former work folder, archived memory and Sessions stay protected by the same
  boundary between Bots; other Bots, groups or the team workspace cannot take over these
  locations.
- The team keeps the minimum archive record needed for this protection, and does not show
  deleted Bots in the Bot list.
- In Settings → Bots, the user can remove these protections one by one in the "Closed
  after deletion" list at the bottom. The list appears only when there are kept entries;
  each entry shows the Bot name and its work folder.
- Removing takes two clicks: the first click on "Remove protection" puts the entry into a
  confirm state that explains the result; a second click on the same entry within 4
  seconds takes effect. Clicking another entry moves the confirm state to that entry.
- Removing only removes the protection; it does not delete the folder, memory or Sessions.
  After removal, other Bots can read its folder, memory and conversations, and other Bots,
  groups or the team workspace can use the folder. A removed protection does not come back
  by itself.
- Removal is done by the user in settings; a Bot cannot remove a protection through tools,
  and a read-only window cannot remove one either.

## Not done

- No blocking of network access in `web_fetch`, `web_search`, the browser, MCP or the
  shell. Blocking only some network tools would give a false sense of safety.
- No change to model requests: the provider a private Bot uses still receives what is sent
  to the model.
- No change to DSH, and no claim of operating system or kernel level isolation.
- No private group chats or private Main Bots.

## Known limits

- DSH's file sandbox does not restrict reads. The path checks for file tools and directory
  searches are done in DS Bot's tool hooks; they are not a system security boundary.
- Shell commands can only be checked conservatively by the paths and Session ids that
  appear in them. Paths built at run time, walking up through relative paths, or walking a
  parent directory without naming the private path can still get past the check. A model
  that can run a shell can in the end read any file the current system account can read,
  and can write to shared folders directly without the approval for writes outside its
  folder.
- Network tools stay available, so a private Bot can still send content to outside
  services. Whether such tasks are allowed is still up to the user, through the Bot's
  permissions and tool settings.
- Path checks lean conservative: paths that contain a private Session id, and some paths
  that share a prefix with a protected location, may be refused as well.
- If a later change to the file system outside DS Bot makes directories overlap,
  directory-walking searches fail closed until the user separates the directories. This
  costs usability, but protected content must not be exposed to keep search working.

## Changes

- 2026-10-27: first version, Issue #597.
- 2026-10-27: protection continues by default after deletion; the user can remove it entry
  by entry in settings.
