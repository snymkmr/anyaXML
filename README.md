# AnyaXML

Format and check XML documents in Visual Studio Code.

## Requirements

- **PowerShell** is required to format or minify XML documents of any size, and to validate files over 50 MiB. The extension looks for `pwsh` on macOS and Linux, or `powershell.exe` on Windows. If it is installed somewhere else, set `anyaxml.powershellExecutable` to its executable path in VS Code Settings.

## Use AnyaXML

For regular XML files, either right-click in the editor or right-click the file in Explorer. Choose:

- **AnyaXML: Format XML Document** to format the document. Large file conversions use streaming mode.
- **AnyaXML: Minify XML Document** to write text and whitespace nodes on one line while preserving parsed element values. Source line breaks are written as character references (for example, `&#xA;`) so they remain part of the XML content. Without a DTD or schema, XML does not reliably distinguish meaningful whitespace from formatting whitespace. For a regular open document, this replaces its contents; use Undo to reverse it.
- **AnyaXML: Validate XML** to check that the document is well-formed. The first syntax error appears in the Problems panel.
- **AnyaXML: Preview XML as Table** to open a side-by-side table preview. AnyaXML detects a repeated element group for rows, flattens nested fields into columns, and includes attributes. Nested repeated record groups are expanded into one-based indexed columns (for example, `Column[1].Tag` and `Column[2].Tag`); elements that occur once stay unindexed. If a group repeats in any row, its indexed columns stay aligned across all rows. Use the filter and page controls to browse the rows. Use the exact-filter icon beside **Export** to switch between substring and exact-value matching. The green **Export** button saves all rows matching the current filter as a real Excel workbook (`.xlsx`), not only the visible page. Values are stored as text so Excel keeps identifiers, dates, and formula-like strings as shown. The workbook contains the flattened preview table; the XML source is unchanged. Files over 50 MiB are read directly from disk, so they do not need to be synchronized with the editor.

### Large files

- VS Code cannot synchronize files over 50 MiB with extensions, so keep these files closed in the editor.
- Right-click the file in Explorer to run a command directly from disk:
  - **AnyaXML: Format XML Document** saves a separate `*_formatted.xml` copy.
  - **AnyaXML: Minify XML Document** saves a separate `*_minified.xml` copy.
  - **AnyaXML: Validate XML** checks the file and reports the first syntax error.
- If the source name already ends in `_formatted` or `_minified`, AnyaXML reuses that base name instead of appending another marker. It also recognizes the older one-line suffix on files made with a previous version. If the destination already exists, AnyaXML adds a number. Formatting and minifying leave the original unchanged.

Validation shows a green or red result in the status bar and a message with the error location. VS Code cannot show editor diagnostics or live validation for these files because they cannot be opened in the editor.

You can also run these commands from the Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux). **Format Document** also uses AnyaXML for XML files.

## Validation status

The status bar shows green when the active XML file is valid and red when it has a syntax error. Hover over the status to see the error location and message; click it to validate again. Validation runs after edits (debounced by 500 ms) and when you save.

To check another file, click the status bar or run **AnyaXML: Validate XML** from the Command Palette or a context menu.

Validation checks XML syntax and well-formedness. It does not validate an XML Schema (XSD).

## Privacy

See the [Privacy Policy](https://sanyam.dev/privacy) for privacy information about my projects.
