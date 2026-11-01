import * as vscode from "vscode";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import { parser as createSaxParser } from "sax";

const diagnosticCollectionName = "anyaxml";
const maximumSynchronizedFileSize = 50 * 1024 * 1024;

interface XmlTablePreview {
  columns: string[];
  rows: Array<Record<string, string>>;
  sourcePath: string;
  totalRows: number;
}

interface XmlTableCandidate {
  path: string;
  rows: Array<Record<string, unknown>>;
  columns: number;
  depth: number;
}

interface XmlPreviewNode {
  name: string;
  attributes: Record<string, string>;
  text: string[];
  children: Map<string, XmlPreviewNode[]>;
}

interface XmlTablePage {
  type: "page";
  columns: string[];
  rows: Array<Record<string, string>>;
  sourcePath: string;
  page: number;
  pageSize: number;
  totalRows: number;
  requestId: number;
}

interface XmlPathStat {
  count: number;
  depth: number;
  childCount: number;
  attributeCount: number;
}

interface XmlStreamFrame {
  name: string;
  path: string;
  childCount: number;
  attributeCount: number;
}

interface XmlStreamEvents {
  open(tag: { name: string; attributes: Record<string, string> }): void;
  close(name: string): void;
  text(text: string): void;
}

interface ValidationState {
  version: number;
  diagnostic?: vscode.Diagnostic;
}

interface LargeFileValidationState {
  uri: vscode.Uri;
  isValid: boolean;
  line?: number;
  column?: number;
  message?: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection(diagnosticCollectionName);
  const validationTimers = new Map<string, NodeJS.Timeout>();
  const validationStates = new Map<string, ValidationState>();
  const pendingValidations = new Set<string>();
  let largeFileValidationState: LargeFileValidationState | undefined;
  let pendingLargeFileValidation: vscode.Uri | undefined;
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.name = "AnyaXML XML Validation";

  const updateStatusBar = (): void => {
    const document = vscode.window.activeTextEditor?.document;
    if (!isXmlDocument(document)) {
      const largeFile = pendingLargeFileValidation ? undefined : largeFileValidationState;
      if (pendingLargeFileValidation) {
        statusBar.show();
        statusBar.command = {
          command: "anyaxml.validateXml",
          title: "Validate XML",
          arguments: [pendingLargeFileValidation]
        };
        statusBar.text = `$(sync~spin) XML: Checking ${path.basename(pendingLargeFileValidation.fsPath)}`;
        statusBar.color = undefined;
        statusBar.tooltip = `Checking ${pendingLargeFileValidation.fsPath}…`;
        return;
      }
      if (!largeFile) {
        statusBar.hide();
        return;
      }

      statusBar.show();
      statusBar.command = {
        command: "anyaxml.validateXml",
        title: "Validate XML",
        arguments: [largeFile.uri]
      };
      const fileName = path.basename(largeFile.uri.fsPath);
      if (largeFile.isValid) {
        statusBar.text = `$(check) XML: Valid (${fileName})`;
        statusBar.color = new vscode.ThemeColor("testing.iconPassed");
        statusBar.tooltip = `${fileName} is well-formed. Click to validate again.`;
      } else {
        statusBar.text = `$(error) XML: Error (${fileName})`;
        statusBar.color = new vscode.ThemeColor("testing.iconFailed");
        statusBar.tooltip = `${fileName}, line ${largeFile.line}, column ${largeFile.column}: ${largeFile.message}\nClick to validate again.`;
      }
      return;
    }

    statusBar.show();
    statusBar.command = {
      command: "anyaxml.validateXml",
      title: "Validate XML",
      arguments: [document.uri]
    };
    const key = document.uri.toString();
    if (pendingValidations.has(key)) {
      statusBar.text = "$(sync~spin) XML: Checking";
      statusBar.color = undefined;
      statusBar.tooltip = "Checking XML syntax…";
      return;
    }

    const state = validationStates.get(key);
    if (!state) {
      statusBar.text = "$(question) XML: Not checked";
      statusBar.color = undefined;
      statusBar.tooltip = "Click to validate this XML document.";
      return;
    }

    if (state.version !== document.version) {
      statusBar.text = "$(warning) XML: Needs validation";
      statusBar.color = undefined;
      statusBar.tooltip = "This document has changed since its last validation. Click to validate it.";
      return;
    }

    if (!state.diagnostic) {
      statusBar.text = "$(check) XML: Valid";
      statusBar.color = new vscode.ThemeColor("testing.iconPassed");
      statusBar.tooltip = "XML is well-formed. Click to validate again.";
      return;
    }

    const line = state.diagnostic.range.start.line + 1;
    const column = state.diagnostic.range.start.character + 1;
    statusBar.text = `$(error) XML: syntax error at ${line}:${column}`;
    statusBar.color = new vscode.ThemeColor("testing.iconFailed");
    statusBar.tooltip = `Line ${line}, column ${column}: ${state.diagnostic.message}\nClick to validate again.`;
  };

  const validateNow = (document: vscode.TextDocument): void => {
    const key = document.uri.toString();
    const timer = validationTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      validationTimers.delete(key);
    }
    pendingValidations.delete(key);
    validateDocument(document, diagnostics, validationStates);
    updateStatusBar();
  };

  const scheduleValidation = (document: vscode.TextDocument): void => {
    if (!isXmlDocument(document)) {
      return;
    }

    const key = document.uri.toString();
    const existingTimer = validationTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    pendingValidations.add(key);
    updateStatusBar();
    validationTimers.set(
      key,
      setTimeout(() => {
        validationTimers.delete(key);
        pendingValidations.delete(key);
        validateDocument(document, diagnostics, validationStates);
        updateStatusBar();
      }, 500)
    );
  };

  context.subscriptions.push(diagnostics);
  context.subscriptions.push(statusBar);
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider("xml", {
      provideDocumentFormattingEdits: async (document) => {
        try {
          const version = document.version;
          const formatted = await formatXml(document.getText(), context);
          if (document.version !== version) {
            throw new Error("The XML document changed while formatting was running. Run Format Document again.");
          }
          return [replaceWholeDocument(document, formatted)];
        } catch (error) {
          void vscode.window.showErrorMessage(errorMessage(error));
          return [];
        }
      }
    })
  );

  const transformXmlCommand = async (resource: vscode.Uri | undefined, minify: boolean): Promise<void> => {
    if (resource?.scheme === "file") {
      try {
        const stat = await fs.stat(resource.fsPath);
        if (stat.size > maximumSynchronizedFileSize) {
          pendingLargeFileValidation = resource;
          largeFileValidationState = undefined;
          updateStatusBar();
          try {
            const validation = await validateLargeXmlFile(
              context.asAbsolutePath("validateXML.ps1"),
              resource
            );
            largeFileValidationState = validation;
            if (!validation.isValid) {
              void vscode.window.showErrorMessage(
                `Cannot convert ${path.basename(resource.fsPath)}: XML syntax error at line ${validation.line}, column ${validation.column}: ${validation.message}`
              );
              return;
            }

            const outputPath = await getTransformOutputPath(resource.fsPath, minify);
            await runPowerShell(context.asAbsolutePath("formatXML.ps1"), resource.fsPath, outputPath, minify);
            const action = minify ? "Minified copy" : "Formatted copy";
            void vscode.window.showInformationMessage(`${action} saved to ${outputPath}`);
          } finally {
            pendingLargeFileValidation = undefined;
            updateStatusBar();
          }
          return;
        }
      } catch (error) {
        void vscode.window.showErrorMessage(errorMessage(error));
        return;
      }
    }

    let document: vscode.TextDocument | undefined;
    try {
      document = await resolveXmlDocument(resource);
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error));
      return;
    }
    if (!document) {
      void vscode.window.showWarningMessage("Select or open an XML file before converting it.");
      return;
    }

    try {
      const editor = vscode.window.visibleTextEditors.find(
        (candidate) => candidate.document.uri.toString() === document!.uri.toString()
      ) ?? await vscode.window.showTextDocument(document);
      const version = document.version;
      const formatted = await formatXml(document.getText(), context, minify);
      if (document.version !== version) {
        throw new Error("The XML document changed while conversion was running. Run the command again.");
      }
      const applied = await editor.edit((edit) => edit.replace(fullDocumentRange(document!), formatted));
      if (!applied) {
        throw new Error("VS Code could not apply the formatted XML edits.");
      }
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error));
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("anyaxml.formatXml", (resource?: vscode.Uri) =>
      transformXmlCommand(resource, false)
    ),
    vscode.commands.registerCommand("anyaxml.oneLineXml", (resource?: vscode.Uri) =>
      transformXmlCommand(resource, true)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anyaxml.validateXml", validateCommand)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anyaxml.previewXmlAsTable", previewXmlAsTableCommand)
  );

  async function previewXmlAsTableCommand(resource?: vscode.Uri): Promise<void> {
    let largeFilePath: string | undefined;
    if (resource?.scheme === "file") {
      try {
        const stat = await fs.stat(resource.fsPath);
        if (stat.size > maximumSynchronizedFileSize) {
          largeFilePath = resource.fsPath;
        }
      } catch (error) {
        void vscode.window.showErrorMessage(errorMessage(error));
        return;
      }
    }

    let document: vscode.TextDocument | undefined;
    let preview: XmlTablePreview | undefined;
    let refreshRequestId = 0;
    let fileName = largeFilePath ? path.basename(largeFilePath) : "";
    if (!largeFilePath) {
      try {
        document = await resolveXmlDocument(resource);
      } catch (error) {
        void vscode.window.showErrorMessage(errorMessage(error));
        return;
      }
      if (!document) {
        void vscode.window.showWarningMessage("Select or open an XML file before previewing it as a table.");
        return;
      }
      fileName = path.basename(document.uri.fsPath) || "Untitled XML";
      const xml = document.getText();
      const validation = XMLValidator.validate(xml);
      if (validation !== true) {
        void vscode.window.showErrorMessage(
          `Cannot preview malformed XML. Syntax error at line ${validation.err.line}, column ${validation.err.col}: ${validation.err.msg}`
        );
        return;
      }

      try {
        const parser = new XMLParser({
          ignoreAttributes: false,
          attributeNamePrefix: "@",
          parseTagValue: false,
          parseAttributeValue: false,
          isArray: (_name, _jPath, _isLeafNode, isAttribute) => !isAttribute
        });
        preview = buildXmlTablePreview(parser.parse(xml));
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not create XML table preview: ${errorMessage(error)}`);
        return;
      }
    }

    const panel = vscode.window.createWebviewPanel(
      "anyaxml.tablePreview",
      `XML Table: ${fileName}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );
    panel.webview.html = renderXmlTablePreview(panel.webview, fileName);

    const sendPage = (filter: string, page: number, pageSize: number, requestId: number): void => {
      if (!preview) {
        return;
      }
      void panel.webview.postMessage(queryXmlTable(preview, filter, page, pageSize, requestId));
    };
    const messageSubscription = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isRecord(message)) {
        return;
      }
      if (message.type === "popout") {
        void vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow").then(undefined, (error: unknown) => {
          void vscode.window.showErrorMessage(`Could not pop out the XML preview: ${errorMessage(error)}`);
        });
        return;
      }
      if (message.type === "refresh") {
        const requestId = ++refreshRequestId;
        try {
          let refreshed: XmlTablePreview;
          if (largeFilePath) {
            refreshed = await buildXmlTablePreviewFromFile(largeFilePath);
          } else if (document) {
            const xml = document.getText();
            const validation = XMLValidator.validate(xml);
            if (validation !== true) {
              throw new Error(`XML syntax error at line ${validation.err.line}, column ${validation.err.col}: ${validation.err.msg}`);
            }
            const parser = new XMLParser({
              ignoreAttributes: false,
              attributeNamePrefix: "@",
              parseTagValue: false,
              parseAttributeValue: false,
              isArray: (_name, _jPath, _isLeafNode, isAttribute) => !isAttribute
            });
            refreshed = buildXmlTablePreview(parser.parse(xml));
          } else {
            throw new Error("The XML source is no longer available.");
          }
          if (requestId !== refreshRequestId) {
            return;
          }
          preview = refreshed;
          panel.webview.html = renderXmlTablePreview(panel.webview, fileName);
        } catch (error) {
          if (requestId === refreshRequestId) {
            void panel.webview.postMessage({ type: "refreshError", message: errorMessage(error) });
          }
        }
        return;
      }
      if (message.type === "ready") {
        if (preview) {
          sendPage("", 0, 50, 0);
        }
        return;
      }
      if (message.type === "query") {
        sendPage(
          typeof message.filter === "string" ? message.filter : "",
          typeof message.page === "number" ? message.page : 0,
          typeof message.pageSize === "number" ? message.pageSize : 50,
          typeof message.requestId === "number" ? message.requestId : 0
        );
      }
    });
    panel.onDidDispose(() => messageSubscription.dispose());

    if (largeFilePath) {
      const initialRequestId = refreshRequestId;
      try {
        const initialPreview = await buildXmlTablePreviewFromFile(largeFilePath);
        if (initialRequestId !== refreshRequestId) {
          return;
        }
        preview = initialPreview;
        sendPage("", 0, 50, 0);
      } catch (error) {
        if (initialRequestId === refreshRequestId) {
          panel.webview.html = renderXmlTablePreviewError(panel.webview, fileName, errorMessage(error));
        }
      }
    }
  }

  async function validateCommand(resource?: vscode.Uri): Promise<void> {
    if (resource?.scheme === "file") {
      try {
        const stat = await fs.stat(resource.fsPath);
        if (stat.size > maximumSynchronizedFileSize) {
          pendingLargeFileValidation = resource;
          largeFileValidationState = undefined;
          updateStatusBar();
          try {
            largeFileValidationState = await validateLargeXmlFile(
              context.asAbsolutePath("validateXML.ps1"),
              resource
            );
          } finally {
            pendingLargeFileValidation = undefined;
            updateStatusBar();
          }

          if (largeFileValidationState.isValid) {
            void vscode.window.showInformationMessage(`${path.basename(resource.fsPath)} is well-formed.`);
          } else {
            void vscode.window.showWarningMessage(
              `${path.basename(resource.fsPath)} has an XML syntax error at line ${largeFileValidationState.line}, column ${largeFileValidationState.column}: ${largeFileValidationState.message}`
            );
          }
          return;
        }
      } catch (error) {
        pendingLargeFileValidation = undefined;
        updateStatusBar();
        void vscode.window.showErrorMessage(errorMessage(error));
        return;
      }
    }

    let document: vscode.TextDocument | undefined;
    try {
      document = await resolveXmlDocument(resource);
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error));
      return;
    }
    if (!document) {
      void vscode.window.showWarningMessage("Select or open an XML file before validating.");
      return;
    }

    validateNow(document);
    const state = validationStates.get(document.uri.toString());
    if (!state?.diagnostic) {
      void vscode.window.showInformationMessage("XML is well-formed.");
    } else {
      void vscode.window.showWarningMessage("XML validation found a syntax error. See the Problems panel and status bar for its location.");
    }
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (vscode.workspace.getConfiguration("anyaxml").get<boolean>("validateOnChange", false)) {
        scheduleValidation(event.document);
      } else {
        updateStatusBar();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (vscode.workspace.getConfiguration("anyaxml").get<boolean>("validateOnSave", true)) {
        scheduleValidation(document);
      } else {
        updateStatusBar();
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const key = document.uri.toString();
      const timer = validationTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        validationTimers.delete(key);
      }
      diagnostics.delete(document.uri);
      validationStates.delete(key);
      pendingValidations.delete(key);
      updateStatusBar();
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      const document = editor?.document;
      if (isXmlDocument(document) && !validationStates.has(document.uri.toString())) {
        scheduleValidation(document);
      } else {
        updateStatusBar();
      }
    })
  );

  context.subscriptions.push({
    dispose: () => {
      for (const timer of validationTimers.values()) {
        clearTimeout(timer);
      }
      validationTimers.clear();
    }
  });

  const activeDocument = vscode.window.activeTextEditor?.document;
  if (isXmlDocument(activeDocument) && !validationStates.has(activeDocument.uri.toString())) {
    scheduleValidation(activeDocument);
  } else {
    updateStatusBar();
  }
}

export function deactivate(): void {
  // VS Code disposes subscriptions registered during activation.
}

export function validateXml(xml: string): ReturnType<typeof XMLValidator.validate> {
  return XMLValidator.validate(xml);
}

async function formatXml(
  xml: string,
  context: vscode.ExtensionContext,
  minify = false
): Promise<string> {
  const validation = validateXml(xml);
  if (validation !== true) {
    throw new Error(
      `Cannot format malformed XML. Syntax error at line ${validation.err.line}, column ${validation.err.col}: ${validation.err.msg}`
    );
  }

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "anyaxml-"));
  const inputPath = path.join(temporaryDirectory, "input.xml");
  const outputPath = path.join(temporaryDirectory, minify ? "minified.xml" : "formatted.xml");
  const scriptPath = context.asAbsolutePath("formatXML.ps1");

  try {
    await fs.writeFile(inputPath, xml, "utf8");
    await runPowerShell(scriptPath, inputPath, outputPath, minify);
    return (await fs.readFile(outputPath, "utf8")).replace(/^\uFEFF/, "");
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function runPowerShell(
  scriptPath: string,
  inputPath: string,
  outputPath: string,
  minify = false
): Promise<void> {
  const executable = getPowerShellExecutable();
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-InputFile",
    inputPath,
    "-OutputFile",
    outputPath
  ];
  if (minify) {
    args.push("-Minify");
  }

  return new Promise((resolve, reject) => {
    let stderr = "";
    const child = spawn(executable, args, getPowerShellSpawnOptions());

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => reject(powerShellError(error)));
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `PowerShell formatter exited with code ${code ?? "unknown"}.`));
      }
    });
  });
}
function validateLargeXmlFile(scriptPath: string, uri: vscode.Uri): Promise<LargeFileValidationState> {
  const executable = getPowerShellExecutable();
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-InputFile",
    uri.fsPath
  ];

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(executable, args, getPowerShellSpawnOptions());

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => reject(powerShellError(error)));
    child.once("close", (code) => {
      if (code === 0 && stdout.includes("ANYXML_VALID")) {
        resolve({ uri, isValid: true });
        return;
      }

      const match = stdout.match(/ANYXML_ERROR\t(\d+)\t(\d+)\t([^\r\n]*)/);
      if (code === 2 && match) {
        resolve({
          uri,
          isValid: false,
          line: Number(match[1]),
          column: Number(match[2]),
          message: match[3]
        });
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `PowerShell validator exited with code ${code ?? "unknown"}.`));
    });
  });
}

function getPowerShellExecutable(): string {
  const configuredExecutable = vscode.workspace
    .getConfiguration("anyaxml")
    .get<string>("powershellExecutable", "")
    .trim();
  return configuredExecutable || (process.platform === "win32" ? "powershell.exe" : "pwsh");
}

function getPowerShellSpawnOptions(): { windowsHide: true; env: NodeJS.ProcessEnv } {
  const env = { ...process.env };
  if (process.platform === "darwin") {
    env.COMPlus_UseProfileOptimization ??= "0";
  }
  return { windowsHide: true, env };
}

function powerShellError(error: unknown): Error {
  const executable = getPowerShellExecutable();
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`Could not start PowerShell (${executable}). Install PowerShell or set anyaxml.powershellExecutable. ${detail}`);
}

function validateDocument(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection,
  validationStates: Map<string, ValidationState>
): void {
  if (!isXmlDocument(document)) {
    return;
  }

  const result = validateXml(document.getText());
  const key = document.uri.toString();
  if (result === true) {
    diagnostics.delete(document.uri);
    validationStates.set(key, { version: document.version });
    return;
  }

  const line = Math.max(0, result.err.line - 1);
  const character = Math.max(0, result.err.col - 1);
  const position = new vscode.Position(line, character);
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(position, position),
    result.err.msg,
    vscode.DiagnosticSeverity.Error
  );
  diagnostic.source = "AnyaXML";
  diagnostic.code = result.err.code;
  diagnostics.set(document.uri, [diagnostic]);
  validationStates.set(key, { version: document.version, diagnostic });
}

async function resolveXmlDocument(resource?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  const document = resource
    ? await vscode.workspace.openTextDocument(resource)
    : vscode.window.activeTextEditor?.document;
  return isXmlDocument(document) ? document : undefined;
}

async function getTransformOutputPath(inputPath: string, minify: boolean): Promise<string> {
  const extension = path.extname(inputPath) || ".xml";
  const inputStem = path.basename(inputPath, path.extname(inputPath));
  const stem = inputStem.replace(/_(?:formatted|minified|oneline)(?:_\d+)?$/i, "");
  const directory = path.dirname(inputPath);

  for (let suffix = 0; suffix < 1000; suffix++) {
    const markerBase = minify ? "_minified" : "_formatted";
    const marker = suffix === 0 ? markerBase : `${markerBase}_${suffix}`;
    const candidate = path.join(directory, `${stem}${marker}${extension}`);
    try {
      await fs.access(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return candidate;
      }
      throw error;
    }
  }

  throw new Error("Could not choose a name for the output file.");
}

function isXmlDocument(document: vscode.TextDocument | undefined): document is vscode.TextDocument {
  if (!document) {
    return false;
  }

  const extension = path.extname(document.uri.fsPath).toLowerCase();
  return document.languageId === "xml" || [".xml", ".xsd", ".xsl", ".xslt"].includes(extension);
}

function replaceWholeDocument(document: vscode.TextDocument, text: string): vscode.TextEdit {
  return vscode.TextEdit.replace(fullDocumentRange(document), text);
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildXmlTablePreview(parsedXml: unknown): XmlTablePreview {
  const objectCandidates: XmlTableCandidate[] = [];
  const scalarCandidates: Array<{ path: string; values: unknown[]; depth: number }> = [];

  const visit = (value: unknown, currentPath: string, depth: number): void => {
    if (Array.isArray(value)) {
      if (value.length > 0 && value.every(isRecord)) {
        const rows = value as Array<Record<string, unknown>>;
        const columns = new Set<string>();
        for (const row of rows) {
          for (const column of Object.keys(flattenXmlRecord(row))) {
            columns.add(column);
          }
        }
        objectCandidates.push({ path: currentPath, rows, columns: columns.size, depth });
      } else if (value.length > 1 && value.every((item) => !isRecord(item) && !Array.isArray(item))) {
        scalarCandidates.push({ path: currentPath, values: value, depth });
      }

      for (const item of value) {
        visit(item, currentPath, depth);
      }
      return;
    }

    if (!isRecord(value)) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, currentPath ? `${currentPath}.${key}` : key, depth + 1);
    }
  };

  visit(parsedXml, "", 0);

  if (objectCandidates.length > 0) {
    objectCandidates.sort((left, right) =>
      Number(right.rows.length > 1) - Number(left.rows.length > 1) ||
      right.columns - left.columns ||
      right.rows.length - left.rows.length ||
      right.depth - left.depth
    );
    const selected = objectCandidates[0];
    const rows = selected.rows.map((row) => flattenXmlRecord(row));
    return {
      columns: collectColumns(rows),
      rows,
      sourcePath: selected.path,
      totalRows: rows.length
    };
  }

  if (scalarCandidates.length > 0) {
    scalarCandidates.sort((left, right) => right.values.length - left.values.length || right.depth - left.depth);
    const selected = scalarCandidates[0];
    const rows = selected.values.map((value) => ({ Value: formatXmlValue(value) }));
    return {
      columns: ["Value"],
      rows,
      sourcePath: selected.path,
      totalRows: rows.length
    };
  }

  const rootName = isRecord(parsedXml) ? Object.keys(parsedXml)[0] : undefined;
  const rootValue = rootName ? (parsedXml as Record<string, unknown>)[rootName] : parsedXml;
  const rootNode = Array.isArray(rootValue) ? rootValue[0] : rootValue;
  const row = isRecord(rootNode) ? flattenXmlRecord(rootNode) : { Value: formatXmlValue(rootNode) };
  const rows = [row];
  return {
    columns: collectColumns(rows),
    rows,
    sourcePath: rootName ?? "XML",
    totalRows: rows.length
  };
}

async function buildXmlTablePreviewFromFile(filePath: string): Promise<XmlTablePreview> {
  const statistics = new Map<string, XmlPathStat>();
  const scanStack: XmlStreamFrame[] = [];

  await streamXmlFile(filePath, {
    open: (tag) => {
      if (scanStack.length > 0) {
        scanStack[scanStack.length - 1].childCount += 1;
      }
      const pathParts = scanStack.map((frame) => frame.name);
      pathParts.push(tag.name);
      const elementPath = pathParts.join(".");
      const stat = statistics.get(elementPath) ?? {
        count: 0,
        depth: pathParts.length,
        childCount: 0,
        attributeCount: 0
      };
      stat.count += 1;
      stat.attributeCount += Object.keys(tag.attributes).length;
      statistics.set(elementPath, stat);
      scanStack.push({
        name: tag.name,
        path: elementPath,
        childCount: 0,
        attributeCount: Object.keys(tag.attributes).length
      });
    },
    close: () => {
      const frame = scanStack.pop();
      if (!frame) {
        return;
      }
      const stat = statistics.get(frame.path);
      if (stat) {
        stat.childCount += frame.childCount;
      }
    },
    text: () => undefined
  });

  const targetPath = selectXmlTablePath(statistics);
  const rows = await collectXmlTableRows(filePath, targetPath);
  const columns = collectColumns(rows);
  return { columns, rows, sourcePath: targetPath, totalRows: rows.length };
}

function selectXmlTablePath(statistics: Map<string, XmlPathStat>): string {
  const candidates = [...statistics.entries()];
  const repeatedRecords = candidates
    .filter(([, stat]) => stat.count > 1 && stat.childCount + stat.attributeCount > 0)
    .sort((left, right) => {
      const leftStat = left[1];
      const rightStat = right[1];
      const leftShape = (leftStat.childCount + leftStat.attributeCount) / leftStat.count;
      const rightShape = (rightStat.childCount + rightStat.attributeCount) / rightStat.count;
      return rightShape - leftShape || rightStat.count - leftStat.count || leftStat.depth - rightStat.depth;
    });
  if (repeatedRecords.length > 0) {
    return repeatedRecords[0][0];
  }

  const repeatedValues = candidates
    .filter(([, stat]) => stat.count > 1)
    .sort((left, right) => right[1].count - left[1].count || right[1].depth - left[1].depth);
  if (repeatedValues.length > 0) {
    return repeatedValues[0][0];
  }

  const singleRecord = candidates
    .filter(([, stat]) => stat.childCount + stat.attributeCount > 0)
    .sort((left, right) =>
      (right[1].childCount + right[1].attributeCount) - (left[1].childCount + left[1].attributeCount) ||
      right[1].depth - left[1].depth
    );
  return singleRecord[0]?.[0] ?? candidates[0]?.[0] ?? "XML";
}

async function collectXmlTableRows(filePath: string, targetPath: string): Promise<Array<Record<string, string>>> {
  const pathStack: string[] = [];
  const captureStack: XmlPreviewNode[] = [];
  const rows: Array<Record<string, string>> = [];

  await streamXmlFile(filePath, {
    open: (tag) => {
      pathStack.push(tag.name);
      const node = createXmlPreviewNode(tag.name, tag.attributes);
      if (captureStack.length > 0) {
        const parent = captureStack[captureStack.length - 1];
        const siblings = parent.children.get(tag.name) ?? [];
        siblings.push(node);
        parent.children.set(tag.name, siblings);
        captureStack.push(node);
      } else if (pathStack.join(".") === targetPath) {
        captureStack.push(node);
      }
    },
    close: () => {
      pathStack.pop();
      if (captureStack.length === 0) {
        return;
      }
      const node = captureStack.pop()!;
      if (captureStack.length === 0) {
        rows.push(flattenXmlPreviewNode(node));
      }
    },
    text: (text) => {
      const currentNode = captureStack[captureStack.length - 1];
      if (currentNode) {
        currentNode.text.push(text);
      }
    }
  });

  return rows;
}

function createXmlPreviewNode(name: string, attributes: Record<string, string>): XmlPreviewNode {
  return { name, attributes, text: [], children: new Map<string, XmlPreviewNode[]>() };
}

function flattenXmlPreviewNode(node: XmlPreviewNode): Record<string, string> {
  const flattened = Object.create(null) as Record<string, string>;
  const flatten = (current: XmlPreviewNode, prefix: string): void => {
    for (const [name, value] of Object.entries(current.attributes)) {
      flattened[prefix ? `${prefix}.@${name}` : `@${name}`] = value;
    }

    const text = current.text.join("").trim();
    if (text) {
      const isLeaf = current.children.size === 0 && Object.keys(current.attributes).length === 0;
      flattened[prefix ? `${prefix}.#text` : isLeaf ? "Value" : "#text"] = text;
    }

    for (const [childName, children] of current.children) {
      const columnPath = prefix ? `${prefix}.${childName}` : childName;
      const simpleValues = children.every((child) =>
        child.children.size === 0 && Object.keys(child.attributes).length === 0
      );
      if (simpleValues) {
        flattened[columnPath] = children.map((child) => child.text.join("").trim()).join(", ");
      } else if (children.length === 1) {
        flatten(children[0], columnPath);
      } else {
        flattened[columnPath] = JSON.stringify(children.map(flattenXmlPreviewNode));
      }
    }
  };

  flatten(node, "");
  return flattened;
}

async function streamXmlFile(filePath: string, events: XmlStreamEvents): Promise<void> {
  const input = createReadStream(filePath);
  const xmlParser = createSaxParser(true, { trim: false });
  let parseError: Error | undefined;
  let decoder: TextDecoder | undefined;
  xmlParser.onopentag = (tag) => events.open(tag);
  xmlParser.onclosetag = (name) => events.close(name);
  xmlParser.ontext = (text) => events.text(text);
  xmlParser.oncdata = (text) => events.text(text);
  xmlParser.onerror = (error) => {
    parseError ??= error;
  };

  try {
    for await (const chunk of input) {
      if (parseError) {
        throw parseError;
      }
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      decoder ??= createXmlTextDecoder(bytes);
      const text = decoder.decode(bytes, { stream: true });
      if (text) {
        xmlParser.write(text);
      }
      if (parseError) {
        throw parseError;
      }
    }
    const remainingText = decoder?.decode();
    if (remainingText) {
      xmlParser.write(remainingText);
    }
    xmlParser.close();
    if (parseError) {
      throw parseError;
    }
  } finally {
    input.destroy();
  }
}

function createXmlTextDecoder(initialBytes: Buffer): TextDecoder {
  let encoding = "utf-8";
  if (initialBytes.length >= 2 && initialBytes[0] === 0xff && initialBytes[1] === 0xfe) {
    encoding = "utf-16le";
  } else if (initialBytes.length >= 2 && initialBytes[0] === 0xfe && initialBytes[1] === 0xff) {
    encoding = "utf-16be";
  } else if (initialBytes.length >= 4 && initialBytes[0] === 0x00 && initialBytes[1] === 0x3c) {
    encoding = "utf-16be";
  } else if (initialBytes.length >= 4 && initialBytes[0] === 0x3c && initialBytes[1] === 0x00) {
    encoding = "utf-16le";
  } else {
    const declaration = initialBytes.subarray(0, 512).toString("latin1").match(/<\?xml[^>]*encoding\s*=\s*["']([^"']+)/i);
    if (declaration?.[1]) {
      encoding = declaration[1];
    }
  }
  return new TextDecoder(encoding);
}

function flattenXmlRecord(record: Record<string, unknown>): Record<string, string> {
  const flattened = Object.create(null) as Record<string, string>;
  const addValue = (value: unknown, columnPath: string): void => {
    if (Array.isArray(value)) {
      if (value.length === 1 && isRecord(value[0])) {
        addValue(value[0], columnPath);
      } else if (value.length > 0 && value.every(isRecord)) {
        flattened[columnPath] = JSON.stringify(value.map((item) => flattenXmlRecord(item as Record<string, unknown>)));
      } else {
        flattened[columnPath] = value.map(formatXmlValue).join(", ");
      }
      return;
    }

    if (isRecord(value)) {
      const entries = Object.entries(value);
      if (entries.length === 0) {
        flattened[columnPath] = "";
        return;
      }
      for (const [key, child] of entries) {
        addValue(child, columnPath ? `${columnPath}.${key}` : key);
      }
      return;
    }

    flattened[columnPath || "Value"] = formatXmlValue(value);
  };

  for (const [key, value] of Object.entries(record)) {
    addValue(value, key);
  }
  return flattened;
}

function collectColumns(rows: Array<Record<string, string>>): string[] {
  const columns = new Set<string>();
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      columns.add(column);
    }
  }
  return [...columns];
}

function formatXmlValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function queryXmlTable(
  preview: XmlTablePreview,
  filter: string,
  requestedPage: number,
  requestedPageSize: number,
  requestId: number
): XmlTablePage {
  const pageSize = [25, 50, 100, 200].includes(requestedPageSize) ? requestedPageSize : 50;
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const filteredRows = normalizedFilter
    ? preview.rows.filter((row) => preview.columns.some((column) =>
      (row[column] ?? "").toLocaleLowerCase().includes(normalizedFilter)
    ))
    : preview.rows;
  const pageCount = Math.ceil(filteredRows.length / pageSize);
  const page = Math.min(Math.max(0, Math.floor(requestedPage)), Math.max(0, pageCount - 1));
  return {
    type: "page",
    columns: preview.columns,
    rows: filteredRows.slice(page * pageSize, (page + 1) * pageSize),
    sourcePath: preview.sourcePath,
    page,
    pageSize,
    totalRows: filteredRows.length,
    requestId
  };
}

function renderXmlTablePreview(webview: vscode.Webview, fileName: string): string {
  const nonce = randomBytes(16).toString("base64");
  const contentSecurityPolicy = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(fileName)} table preview</title>
  <style>
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); padding: 0 18px 18px; }
    h1 { font-size: 18px; font-weight: 600; margin: 18px 0 12px; }
    .title-bar { display: flex; align-items: center; gap: 12px; }
    .title-bar h1 { overflow-wrap: anywhere; }
    .title-actions { display: flex; align-items: center; gap: 4px; margin-left: auto; flex: 0 0 auto; }
    .icon-button { display: inline-grid; place-items: center; width: 30px; height: 30px; padding: 5px; color: var(--vscode-icon-foreground, var(--vscode-foreground)); background: transparent; border: 1px solid transparent; border-radius: 4px; cursor: pointer; }
    .icon-button:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .icon-button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .controls { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
    .pagination { justify-content: flex-end; margin-top: 10px; }
    .pagination button { display: inline-grid; place-items: center; width: 30px; height: 30px; padding: 5px; color: var(--vscode-icon-foreground, var(--vscode-foreground)); background: transparent; border: 1px solid transparent; border-radius: 4px; }
    .pagination button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .pagination button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    input, select, button { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; font: inherit; padding: 5px 8px; }
    input { flex: 1; min-width: 120px; }
    button { cursor: pointer; }
    button:disabled { cursor: default; opacity: .5; }
    .meta { display: flex; justify-content: space-between; color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 10px; }
    .table-wrap { max-height: calc(100vh - 150px); overflow: auto; border: 1px solid var(--vscode-panel-border); }
    table { border-collapse: collapse; min-width: 100%; white-space: pre-wrap; }
    th, td { border-bottom: 1px solid var(--vscode-panel-border); border-right: 1px solid var(--vscode-panel-border); padding: 7px 10px; text-align: left; vertical-align: top; }
    thead th { background: var(--vscode-editorStickyScroll-background, var(--vscode-sideBar-background)); position: sticky; top: 0; z-index: 1; }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    .row-number { color: var(--vscode-descriptionForeground); font-weight: 400; text-align: right; width: 1%; white-space: nowrap; }
    #status { color: var(--vscode-descriptionForeground); padding: 12px; }
  </style>
</head>
<body>
  <div class="title-bar"><h1>${escapeHtml(fileName)}</h1><div class="title-actions"><button id="refresh-preview" class="icon-button" type="button" title="Refresh preview" aria-label="Refresh preview"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-4L3 10"/><path d="M3 4v6h6"/><path d="M4 13a8 8 0 0 0 14.9 4L21 14"/><path d="M21 20v-6h-6"/></svg></button><button id="pop-out" class="icon-button" type="button" title="Pop out preview" aria-label="Pop out preview"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/></svg></button></div></div>
  <div class="controls">
    <input id="filter" type="search" placeholder="Filter rows…" aria-label="Filter rows" disabled>
    <label for="page-size">Rows per page</label>
    <select id="page-size" aria-label="Rows per page" disabled><option>25</option><option selected>50</option><option>100</option><option>200</option></select>
  </div>
  <div class="meta"><span id="element">Element: XML</span><span id="page-info">Loading XML data…</span></div>
  <div class="table-wrap"><table><thead id="table-head"></thead><tbody id="table-body"></tbody></table><div id="status">Loading XML data…</div></div>
  <div class="controls pagination" aria-label="Table pagination">
    <button id="previous" type="button" title="Previous page" aria-label="Previous page" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 18l-6-6 6-6"/></svg></button>
    <button id="next" type="button" title="Next page" aria-label="Next page" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 18l6-6-6-6"/></svg></button>
  </div>
  <script nonce="${nonce}">
    (() => {
      const api = acquireVsCodeApi();
      const filter = document.getElementById('filter');
      const pageSize = document.getElementById('page-size');
      const previous = document.getElementById('previous');
      const next = document.getElementById('next');
      const head = document.getElementById('table-head');
      const body = document.getElementById('table-body');
      const status = document.getElementById('status');
      const pageInfo = document.getElementById('page-info');
      const element = document.getElementById('element');
      const popOut = document.getElementById('pop-out');
      let page = 0;
      let requestId = 0;
      let filterTimer;
      const request = () => {
        requestId += 1;
        status.textContent = 'Loading…';
        api.postMessage({ type: 'query', filter: filter.value, page, pageSize: Number(pageSize.value), requestId });
      };
      const makeCell = (tagName, value, className) => {
        const cell = document.createElement(tagName);
        if (className) cell.className = className;
        cell.textContent = value;
        return cell;
      };
      window.addEventListener('message', (event) => {
        const result = event.data;
        if (result?.type === 'refreshError') {
          status.textContent = 'Refresh failed: ' + result.message;
          return;
        }
        if (!result || result.type !== 'page' || result.requestId !== requestId) return;
        head.replaceChildren();
        body.replaceChildren();
        const header = document.createElement('tr');
        header.appendChild(makeCell('th', '#', 'row-number'));
        for (const column of result.columns) header.appendChild(makeCell('th', column));
        head.appendChild(header);
        for (let index = 0; index < result.rows.length; index += 1) {
          const row = result.rows[index];
          const tr = document.createElement('tr');
          tr.appendChild(makeCell('th', String(result.page * result.pageSize + index + 1), 'row-number'));
          for (const column of result.columns) tr.appendChild(makeCell('td', row[column] || ''));
          body.appendChild(tr);
        }
        const pages = Math.ceil(result.totalRows / result.pageSize);
        page = result.page;
        pageInfo.textContent = result.totalRows === 0
          ? '0 rows'
          : 'Page ' + (page + 1) + ' of ' + pages + ' · ' + result.totalRows.toLocaleString() + ' rows';
        element.textContent = 'Element: ' + (result.sourcePath || 'XML');
        status.textContent = result.totalRows === 0 ? 'No matching rows.' : '';
        previous.disabled = page <= 0;
        next.disabled = page + 1 >= pages;
        filter.disabled = false;
        pageSize.disabled = false;
      });
      filter.addEventListener('input', () => {
        page = 0;
        clearTimeout(filterTimer);
        filterTimer = setTimeout(request, 250);
      });
      pageSize.addEventListener('change', () => { page = 0; request(); });
      document.getElementById('refresh-preview').addEventListener('click', () => api.postMessage({ type: 'refresh' }));
      popOut.addEventListener('click', () => api.postMessage({ type: 'popout' }));
      previous.addEventListener('click', () => { if (page > 0) { page -= 1; request(); } });
      next.addEventListener('click', () => { page += 1; request(); });
      api.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
}

function renderXmlTablePreviewError(webview: vscode.Webview, fileName: string, message: string): string {
  const nonce = randomBytes(16).toString("base64");
  const contentSecurityPolicy = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(fileName)} table preview</title><style>*{box-sizing:border-box}body{color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);padding:16px}.title-bar{display:flex;align-items:center;gap:12px}.title-bar h1{font-size:18px;margin:0;overflow-wrap:anywhere}.title-actions{display:flex;gap:4px;margin-left:auto}.icon-button{display:inline-grid;place-items:center;width:30px;height:30px;padding:5px;color:var(--vscode-icon-foreground,var(--vscode-foreground));background:transparent;border:1px solid transparent;border-radius:4px;cursor:pointer}.icon-button:hover{background:var(--vscode-toolbar-hoverBackground,var(--vscode-list-hoverBackground))}.icon-button svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}p{color:var(--vscode-errorForeground);white-space:pre-wrap}</style></head><body><div class="title-bar"><h1>${escapeHtml(fileName)}</h1><div class="title-actions"><button id="refresh-preview" class="icon-button" type="button" title="Refresh preview" aria-label="Refresh preview"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-4L3 10"/><path d="M3 4v6h6"/><path d="M4 13a8 8 0 0 0 14.9 4L21 14"/><path d="M21 20v-6h-6"/></svg></button><button id="pop-out" class="icon-button" type="button" title="Pop out preview" aria-label="Pop out preview"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/></svg></button></div></div><p id="error-message">Could not preview this XML file: ${escapeHtml(message)}</p><script nonce="${nonce}">(() => { const api = acquireVsCodeApi(); document.getElementById('refresh-preview').addEventListener('click', () => api.postMessage({ type: 'refresh' })); document.getElementById('pop-out').addEventListener('click', () => api.postMessage({ type: 'popout' })); window.addEventListener('message', event => { if (event.data?.type === 'refreshError') document.getElementById('error-message').textContent = 'Could not refresh XML preview: ' + event.data.message; }); })();</script></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return character;
    }
  });
}
