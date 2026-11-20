# Sidebar sections

- Date: 2026-11-04
- Related: Issue #836

## Why

When a team has more Bots and group chats, spread over different work or business lines,
a single flat list of every conversation keeps jumping up and down with background
activity, and it is hard to look at the work grouped together. The sidebar needs a light
layer of work sections, without the problem of classic "folders" that hide the state of
the work inside once they are collapsed.

## Decided behavior

- **What goes where, and order**:
  - The first Main Bot (`mainBotIds[0]`) is always the large card at the top of the
    sidebar (`.bt-tile`) and never goes into a section; when a Bot becomes the first Main
    Bot, its `sectionId` is cleared.
  - All other ordinary Bots, secondary Main Bots, group chats and DSH Agents can go into a
    section (`entry.sectionId`).
  - Entries with no `sectionId` (or one that points to a section that does not exist) are
    listed flat below the Main Bot card and above all sections.
  - The unsectioned area and the inside of each section are sorted by pinned first
    (`pinned`), then by latest activity time (`at`), newest first.
  - Sections follow the order of `state.sections`; the user can move a section up or down.
- **Expand and collapse (option A)**:
  - In the wide sidebar, a section header is `30px` high. On the left it shows an arrow
    that rotates with a spring as the section opens and closes, an optional `6px` color
    dot, the section name and the number of visible entries. When expanded, the rows
    inside keep their full width, and a thin guide line appears on the left while the
    pointer is over the section.
  - When a section collapses, its body closes with `SPRING_SHAPE`. On the right of the
    header slides in a cluster of `18px` small 3D characters of at most 3 distinct Bots
    in the section (more shows `+N`), and the right side shows the combined state of the
    section (waiting for your answer or approval `?` > working green dot > unread dot).
  - A collapsed section shows no rows at all; the Session open in the main view also
    collapses with its section. Expanding brings back all rows of the section (#1458).
- **88px avatar rail**:
  - An expanded section in the rail is set apart from what is above it by a short pill
    line (with the section color and a name hint; clicking it collapses the section), and
    its entries are laid out as `44px` avatars.
  - A collapsed section in the rail becomes one `56×56` rounded block with a small
    character cluster (reusing the `RoomAvatar` masked cluster and status badge); clicking
    it expands the section.
- **Entry points and tools**:
  - The sidebar top bar has a "New section" button. After creating one, focus moves to an
    inline input in the header to rename it; double-clicking any section header renames it
    inline.
  - Hovering a section header shows `+` and `···`:
    - Clicking `+` opens the "Add to {name}" menu. At the top it can create a new Bot or a
      new group chat directly in this section; below it lists the team's existing Bots and
      group chats, and clicking one adds it to or removes it from the section.
    - Clicking `···` or right-clicking the header offers: rename, create a new Bot in the
      section, set the section color (none / blue / orange / green / purple / pink), move
      the section up or down, or "Ungroup section".
  - Ungrouping removes only the section itself and clears the `sectionId` of its entries,
    so they go back to the unsectioned area at the top. No Bot or group chat is deleted.
  - Right-clicking any Bot, group chat or DSH Agent row other than the main card lets the
    user pick an existing section to move into, remove the row from its section, or choose
    "Move to new section…". In the wide sidebar, rows can also be dragged onto a target
    section or the unsectioned area at the top.
  - When a Bot is duplicated (`duplicate-bot`), the new copy inherits the original Bot's
    `sectionId`.
  - The Main Bot's `create_bot`, `update_bot`, `create_group` and `update_group` tools take
    an optional `section` argument (matches an existing section by name or creates a new
    one; an empty string removes the entry from its section). The output of `list_bots`
    includes the section name.
- **Storage**:
  - Sections are saved in `state.json` as `sections: [{ id, name, collapsed?, color? }]`,
    and entries keep their own `sectionId` field. Loading `state.json` clears orphan
    `sectionId` values that point to sections that do not exist.

## Not done

- No nested subsections.
- Ungrouping a section does not delete the Bots or group chats in it.
