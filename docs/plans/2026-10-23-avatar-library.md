# Avatar library: reusable custom avatars and bulk import

- Date: 2026-10-23
- Related: #484 (keep reusable custom avatars, support bulk import with partial success)
- Code: `ds-bot/src/host/avatar-library.js` (storage and import), `ds-bot/src/host/avatar.js` (image checks), `ds-bot/src/host/channel.js` (interface), `ds-bot/src/client/avatar-library.js` (interface), `ds-bot/src/client/bot-settings.js`, `ds-bot/src/client/create-bot.js`

Avatar upload has existed for a long time, but a photo only belonged to one Bot: another Bot needed another upload, and removing the Bot lost the photo. #484 asks for a reusable avatar library: a photo is imported once and can then be used for several Bots, and in a bulk import one bad image does not affect the others.

## Why

Photos are the user's own material, and the same photo is often used for several Bots in the team. Right now it is stored in the Bot's `avatar.image` (a base64 data URL), so:

- another Bot needs another upload;
- removing the Bot loses the photo;
- a bulk import has nowhere to go.

Storing a data URL in a Bot's own `avatar.image` is an existing convention, and the tools (`create_bot` / `update_bot`) have always accepted an image path or a data URL. None of this changes: the library is a layer added alongside, and it does not change how Bots store avatars.

## Decided behavior

### Where it lives

- The avatar library is in the Bot data folder: `<DSH_HOME>/bot/avatars/`.
  - `index.json`: the index; each entry is `{ id, name, mime, bytes, createdAt }`.
  - `files/<id>.<ext>`: the image itself.
- `id` is the sha256 of the image content, so the same image is stored once and has one entry in the index. Importing the same image again adds no entry.
- The index and images are written whole (a temporary file first, then a rename), so a half-written file is never read.
- The library is in the Bot data folder, not in the team state (`state.json`), so removing a Bot, changing its look or renaming it does not affect the library; it is still there after a host change or a restart.

### Import

- Several images can be imported at once. Each one is checked on its own: good ones stay, bad ones are reported one by one (which file and why), and they do not affect the others.
- The browser crops each image to a 160×160 square and converts it to webp (exactly as the current upload does, `avatarImage`); the host checks the image content, type and size limit again.
- The browser sends 20 images per batch. When the host refuses a batch (network error, read-only window and so on), every image in that batch counts as failed with the reason, **the later batches are still sent**, and the failed batch is not sent again.
- The same image again counts as a duplicate and adds no entry; the copy in the library is left as it is.
- The library holds at most 500 images.
- Imports that arrive at the same time on the same host are queued (the index changes one at a time), so they do not overwrite each other; the temporary file names of the index and images are all different.

### Browsing the library

- The interface returns at most 48 images at a time, and the window asks for them by page ("Show more photos" appears when the library has more). Newest first.

### Using it

- The Bot's look editor gets a "Library" tab, and the new Bot form gets a "Library" button: inside is a grid of thumbnails, and picking one makes it this Bot's photo. When the library has many images, they are shown by page.
- The picked photo is stored as this Bot's own `avatar.image` (still a data URL), so:
  - old avatars still show, and tools that pass a path or a data URL still work;
  - deleting a photo from the library does not affect Bots that already use it; their own copy stays.
- When a library photo is picked while creating a Bot, the photo is still there after the Bot is created.

### Who can change it

- Only the user can change the library: the interface is on the user's `/api/bot` channel, there is no tool for Bots, and Bots cannot reach the library.
- While another DSH has the same data open, this window can view the library but not change it (refused like other writes).
- Library photos are only images; path, type and size go through the existing avatar checks, and an image path passed by a Bot tool still cannot point into DSH's data directory.

## Not done

- No change to how Bots store avatars: `avatar.image` stays a data URL, no new field such as an "avatar reference" is added, and the structure of `state.json` does not change.
- No tool for Bots to "import into the avatar library".
- No cropping on the host: the host has no image library, so cropping stays in the browser, and the host only checks and stores.
- No image editing, naming rules, sorting or search.

## Known limits

- Library images are stored only on this machine and are not synced with the team to other machines.
- One copy per image: the same photo with different crop settings (currently fixed at 160×160) counts as the same image.

## Changes

- 2026-10-23: added the avatar library and bulk import, #484.
