import * as vscode from "vscode";
import { XMLValidator } from "fast-xml-parser";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const diagnosticCollectionName = "anyxml";
const maximumSynchronizedFileSize = 50 * 1024 * 1024;

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
          command: "anyxml.validateXml",
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
        command: "anyxml.validateXml",
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
      command: "anyxml.validateXml",
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
    vscode.commands.registerCommand("anyxml.formatXml", (resource?: vscode.Uri) =>
      transformXmlCommand(resource, false)
    ),
    vscode.commands.registerCommand("anyxml.oneLineXml", (resource?: vscode.Uri) =>
      transformXmlCommand(resource, true)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("anyxml.validateXml", async (resource?: vscode.Uri) => {
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
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (vscode.workspace.getConfiguration("anyxml").get<boolean>("validateOnChange", false)) {
        scheduleValidation(event.document);
      } else {
        updateStatusBar();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (vscode.workspace.getConfiguration("anyxml").get<boolean>("validateOnSave", true)) {
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

async function formatXml(
  xml: string,
  context: vscode.ExtensionContext,
  minify = false
): Promise<string> {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(
      `Cannot format malformed XML. Syntax error at line ${validation.err.line}, column ${validation.err.col}: ${validation.err.msg}`
    );
  }

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "anyxml-"));
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
    .getConfiguration("anyxml")
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
  return new Error(`Could not start PowerShell (${executable}). Install PowerShell or set anyxml.powershellExecutable. ${detail}`);
}

function validateDocument(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection,
  validationStates: Map<string, ValidationState>
): void {
  if (!isXmlDocument(document)) {
    return;
  }

  const result = XMLValidator.validate(document.getText());
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
