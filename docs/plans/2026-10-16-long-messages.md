# Long messages

- Date: 2026-10-16
- Related: #206; PR #258 (state.json stores only the start), PR #259 (very long messages become files), PR #261 (fold long messages in the chat); #256 (a paste in the input box becomes a card)

## Why

Messages between Bots and group records used to be stored whole in `state.json`, and `state.json` is rewritten in full on every save: one `message_bot` of 5 million characters grew it to 6.5 MB, and after that even changing a color rewrote that much. A message also went whole into the recipient's context, and a group line went whole into every member's prompt. A PTC program can hand a whole file to `message_bot`, so the length is not bounded by the model's output limit.

Trade-offs:

- Hot files hold only bounded data. The full text stays where it is already stored (the Session it was delivered to), or goes into a file written once.
- Content too long for the model to read at once becomes a file, which the model reads with file tools when needed; messages are not truncated.
- Use DSH's own attachment store (`ctx.attachments`), and do not write files into the user's work folder.

## Decided behavior

### state.json

- A message between Bots stores the first 2,000 characters, the total length, and where the full text is: the Session it was delivered to, or an attachment.
- A group record line stores the first 2,000 characters and the total length. The full text is in the group's ledger ([Message ledger](2026-11-10-message-ledger.md)); members read at most 20,000 characters.
- It is written without indentation.
- Old data is shortened the same way when loaded; the full text of group records goes into the group's ledger first, and only the DSH that is writing the data writes it.

### Messages a Bot sends

- `message_bot` and `post_to_group` refuse empty messages and messages that are only whitespace.
- A message up to 20,000 characters stays in the message as usual.
- A message over 20,000 characters is stored as is as a DSH attachment (content-addressed, so the same content is stored once). The message keeps only one sentence of explanation, the first 1,000 characters and a file block; when DSH sends it to the model, the file block becomes a read-only path. The explanation asks the Bot to read the full text before acting; when a line is longer than 2,000 characters, the explanation adds that these lines should be read with shell commands.
- When DSH cannot store files, a very long message is not sent; the tool tells the sending Bot to write it into the work folder and send the path.
- A long post in a group: the file travels with the line, and every member that sees the line gets the file block with its prompt (the same as files the user sends in #241).

### Members reading group records

- In the prompt each line has at most 20,000 characters; the rest is written as `… (cut; N characters in all)`.
- `read_group_chat` gives each line at most 2,000 characters and gives the seq of cut lines; passing `seq` reads the whole line (at most 20,000 characters).

### Interface

- A message over 1,500 characters or 25 lines is folded: the first 10 lines (at most 600 characters, cut at a line end; a code block cut open in Markdown gets its closing fence), and below that "Show all · N characters"; once expanded, "Show less" folds it again. This applies to the user's own messages, group messages and the message history dialog.
- A Bot's reply to the user in its own chat is folded only above 20,000 characters: the user is there to read it, so it folds only when rendering it whole would slow down the chat.
- A message that is still streaming is not folded.
- A message of which only the start is stored (a message between Bots over 2,000 characters, a group post turned into a file) is always folded. "Show all" reads it back from the Session it was delivered to or from the attachment, and shows at most 200,000 characters; when it cannot read all of it, it says so.
- For a message turned into a file, the opening sentence written for the model is not shown.
- Copy and download use the whole message; after the full text is read back, they use that.
- A paste of more than 1,500 characters into the input box (the same threshold as message folding above) does not show the whole text but a card "Pasted text · N characters". The card's "Put back" puts the text back in the input box (where it can be edited further or undone), and "×" drops the paste. Meanwhile the text is sent with the message as a DSH attachment, so pressing send right away also carries the full text. The input box in the new conversation dialog works the same way, and the text is sent with the message as is (the dialog makes no attachment).

### Tested

- DSH 0.2.0-rc.2 + mock model: a Bot reads attachment paths under all three permission presets, `read-only`, `workspace-write` and `danger-full-access`, without an approval prompt.

## Not done

- Message content is not truncated or rewritten. Attachments are stored as is, including very long lines.
- For a very long message the user sends in a group, members read the first 20,000 characters.
- Replies within a Bot's turn (the model's own output) are not turned into files.

## Known limits

- DSH does not delete attachments (a current limit that DSH documents); this is recorded in the DSH concessions ledger. Only Bot messages over 20,000 characters make attachments, and the same content is stored once.
- DSH's `read` tool shows at most 2,000 characters per line and cannot page within a line, so only the explanation can tell the model to read with the shell.
- DSH's generic file card cannot be opened, so DS Bot reads the attachment itself for "Show all".

## Changes

- 2026-11-10: the full text of group records is stored in the group's ledger and no longer written to `group-lines/` (#1316).
- 2026-11-10: a long paste in the input box folds into a card (#256): the card belongs to DS Bot, the text is sent with the message as a DSH attachment, and the file card DSH draws itself is hidden.
