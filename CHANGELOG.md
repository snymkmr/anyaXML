# Changelog

## 0.2.7

- Minify removes indentation-only whitespace between markup so the output stays on one line and is smaller for pretty-printed XML. Mixed-content spaces remain unchanged, comment and processing-instruction line breaks are flattened, and the streaming path uses the same behavior.
- Prefer a singleton record inside a collection element over its nested repeated group when choosing XML preview rows, in both regular and streaming previews.
- Find PowerShell in common install paths when the extension host does not inherit it on `PATH`.

## 0.2.6

- Keep count attributes on nested elements with their fields in XML table previews.

## 0.2.5

- Add progress notifications for large-file validation, formatting, and table previews; previews and refreshes report percentage progress.
- Prefer repeated parent elements for table rows and improve column ordering in XML previews.

## 0.2.4

- Leave singleton XML elements unindexed in table previews while keeping nested repeated-element columns aligned across rows.

## 0.2.2

- Replace the XML preview's text pagination controls with accessible arrow buttons.

## 0.2.1

- Add a Privacy section linking to the project privacy policy.
- Add pagination, filtering, and a pop-out action to XML table previews. Large files are read directly from disk.

## 0.2.0

- Rename commands and settings to use the Anya namespace. Update any saved command references and setting keys to the new IDs.
