#Requires -Version 3.0
param(
    [string]$InputFile = "",
    [string]$OutputFile = "",
    [switch]$Streaming = $false,
    [Alias("OneLine")]
    [switch]$Minify = $false,
    # Indentation used when formatting: "tab" (default) or a number of spaces.
    [string]$Indent = "tab"
)

$script:LexicalMinifierSource = @"
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace AnyaXml
{
    // Minifies XML lexically: every tag, value, CDATA section, comment, processing
    // instruction and declaration is copied exactly as written, and only whitespace
    // that sits between markup (indentation) is removed. The text is never parsed
    // into a tree and re-serialized, so values, quoting, entities and bytes stay
    // as they were in the source.
    public static class LexicalMinifier
    {
        public static void Minify(string inputPath, string outputPath)
        {
            byte[] head = new byte[4];
            int headLength;
            using (FileStream probe = File.OpenRead(inputPath))
            {
                headLength = ReadUpTo(probe, head);
            }

            int bomLength;
            Encoding encoding = DetectEncoding(head, headLength, out bomLength);

            using (FileStream input = new FileStream(inputPath, FileMode.Open, FileAccess.Read, FileShare.Read, 65536))
            using (FileStream output = new FileStream(outputPath, FileMode.Create, FileAccess.Write, FileShare.None, 65536))
            {
                if (bomLength > 0)
                {
                    byte[] bom = new byte[bomLength];
                    ReadUpTo(input, bom);
                    output.Write(bom, 0, bomLength);
                }

                using (StreamReader reader = new StreamReader(input, encoding, false, 65536))
                using (StreamWriter writer = new StreamWriter(output, encoding, 65536))
                {
                    new Scanner(reader, writer).Run();
                }
            }
        }

        static int ReadUpTo(Stream stream, byte[] buffer)
        {
            int total = 0;
            while (total < buffer.Length)
            {
                int read = stream.Read(buffer, total, buffer.Length - total);
                if (read <= 0) break;
                total += read;
            }
            return total;
        }

        static Encoding DetectEncoding(byte[] b, int n, out int bomLength)
        {
            bomLength = 0;
            if (n >= 4 && b[0] == 0xFF && b[1] == 0xFE && b[2] == 0 && b[3] == 0) { bomLength = 4; return new UTF32Encoding(false, false); }
            if (n >= 4 && b[0] == 0 && b[1] == 0 && b[2] == 0xFE && b[3] == 0xFF) { bomLength = 4; return new UTF32Encoding(true, false); }
            if (n >= 2 && b[0] == 0xFF && b[1] == 0xFE) { bomLength = 2; return new UnicodeEncoding(false, false); }
            if (n >= 2 && b[0] == 0xFE && b[1] == 0xFF) { bomLength = 2; return new UnicodeEncoding(true, false); }
            if (n >= 4 && b[0] == 0x3C && b[1] == 0 && b[2] == 0 && b[3] == 0) { return new UTF32Encoding(false, false); }
            if (n >= 4 && b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 0x3C) { return new UTF32Encoding(true, false); }
            if (n >= 2 && b[0] == 0x3C && b[1] == 0) { return new UnicodeEncoding(false, false); }
            if (n >= 2 && b[0] == 0 && b[1] == 0x3C) { return new UnicodeEncoding(true, false); }
            // UTF-8 and other ASCII-compatible encodings: ISO-8859-1 maps every byte to
            // exactly one char and back, so the original bytes (including a UTF-8 BOM)
            // pass through unchanged while markup characters are still recognized.
            return Encoding.GetEncoding(28591);
        }

        sealed class Scanner
        {
            static readonly Regex XmlSpaceAttribute = new Regex(
                @"\sxml:space\s*=\s*(?:""(preserve|default)""|'(preserve|default)')",
                RegexOptions.CultureInvariant);

            readonly TextReader reader;
            readonly TextWriter writer;
            readonly List<bool> preserveStack = new List<bool>();
            readonly List<bool> hasTextStack = new List<bool>();
            readonly StringBuilder pending = new StringBuilder();
            readonly StringBuilder tag = new StringBuilder();
            int peeked = -2;
            bool previousWasStartTag;

            public Scanner(TextReader reader, TextWriter writer)
            {
                this.reader = reader;
                this.writer = writer;
            }

            int Read()
            {
                if (peeked != -2) { int c = peeked; peeked = -2; return c; }
                return reader.Read();
            }

            int Peek()
            {
                if (peeked == -2) peeked = reader.Read();
                return peeked;
            }

            static bool IsWhitespace(int c)
            {
                return c == ' ' || c == '\t' || c == '\r' || c == '\n';
            }

            public void Run()
            {
                bool inText = false;
                while (true)
                {
                    int c = Read();
                    if (c < 0)
                    {
                        FlushPending(false);
                        break;
                    }

                    if (c != '<')
                    {
                        if (inText)
                        {
                            writer.Write((char)c);
                        }
                        else if (IsWhitespace(c))
                        {
                            pending.Append((char)c);
                        }
                        else
                        {
                            // Leading whitespace belongs to this text value: keep it.
                            if (pending.Length > 0) { writer.Write(pending.ToString()); pending.Length = 0; }
                            writer.Write((char)c);
                            inText = true;
                            MarkText();
                        }
                        continue;
                    }

                    inText = false;
                    int next = Peek();
                    if (next == '/')
                    {
                        Read();
                        FlushPending(true);
                        writer.Write("</");
                        CopyTag();
                        if (preserveStack.Count > 0)
                        {
                            preserveStack.RemoveAt(preserveStack.Count - 1);
                            hasTextStack.RemoveAt(hasTextStack.Count - 1);
                        }
                        previousWasStartTag = false;
                    }
                    else if (next == '?')
                    {
                        Read();
                        FlushPending(false);
                        writer.Write("<?");
                        CopyUntil("?>");
                        previousWasStartTag = false;
                    }
                    else if (next == '!')
                    {
                        Read();
                        int kind = Peek();
                        if (kind == '-')
                        {
                            FlushPending(false);
                            writer.Write("<!");
                            CopyUntil("-->");
                        }
                        else if (kind == '[')
                        {
                            FlushPending(false);
                            writer.Write("<!");
                            CopyUntil("]]>");
                            MarkText();
                        }
                        else
                        {
                            FlushPending(false);
                            writer.Write("<!");
                            CopyDeclaration();
                        }
                        previousWasStartTag = false;
                    }
                    else
                    {
                        FlushPending(false);
                        writer.Write('<');
                        bool isEmpty = CopyTag();
                        if (!isEmpty)
                        {
                            bool inherited = preserveStack.Count > 0 && preserveStack[preserveStack.Count - 1];
                            Match space = XmlSpaceAttribute.Match(tag.ToString());
                            bool preserve = space.Success
                                ? (space.Groups[1].Value + space.Groups[2].Value) == "preserve"
                                : inherited;
                            preserveStack.Add(preserve);
                            hasTextStack.Add(false);
                        }
                        previousWasStartTag = !isEmpty;
                    }
                }
            }

            void MarkText()
            {
                if (hasTextStack.Count > 0) hasTextStack[hasTextStack.Count - 1] = true;
                previousWasStartTag = false;
            }

            // Decides what to do with a whitespace-only run once the following token is known.
            void FlushPending(bool nextIsEndTag)
            {
                if (pending.Length == 0) return;
                int depth = preserveStack.Count;
                bool keep = false;
                if (depth > 0)
                {
                    keep = preserveStack[depth - 1]                 // xml:space="preserve"
                        || (previousWasStartTag && nextIsEndTag)    // the element's whole value, e.g. <a> </a>
                        || hasTextStack[depth - 1]                  // mixed content: spacing is part of the text
                        || !ContainsLineBreak(pending);             // inline spacing, not indentation
                }
                if (keep) writer.Write(pending.ToString());
                pending.Length = 0;
            }

            static bool ContainsLineBreak(StringBuilder value)
            {
                for (int i = 0; i < value.Length; i++)
                {
                    if (value[i] == '\r' || value[i] == '\n') return true;
                }
                return false;
            }

            // Copies a start or end tag through its closing '>'. Attribute values are
            // copied verbatim; a whitespace run between attributes that spans lines is
            // written as a single space so the tag stays on one line. Returns true for
            // an empty-element tag (<a/>).
            bool CopyTag()
            {
                tag.Length = 0;
                StringBuilder gap = new StringBuilder();
                int quote = 0;
                int lastSignificant = 0;
                while (true)
                {
                    int c = Read();
                    if (c < 0) break;
                    if (quote != 0)
                    {
                        tag.Append((char)c);
                        if (c == quote) quote = 0;
                        lastSignificant = c;
                        continue;
                    }
                    if (IsWhitespace(c))
                    {
                        gap.Append((char)c);
                        continue;
                    }
                    if (gap.Length > 0)
                    {
                        tag.Append(ContainsLineBreak(gap) ? " " : gap.ToString());
                        gap.Length = 0;
                    }
                    tag.Append((char)c);
                    if (c == '>') break;
                    if (c == '"' || c == '\'') quote = c;
                    lastSignificant = c;
                }
                writer.Write(tag.ToString());
                return lastSignificant == '/';
            }

            void CopyUntil(string terminator)
            {
                int length = terminator.Length;
                char[] window = new char[length];
                int seen = 0;
                while (true)
                {
                    int c = Read();
                    if (c < 0) return;
                    writer.Write((char)c);
                    Array.Copy(window, 1, window, 0, length - 1);
                    window[length - 1] = (char)c;
                    if (++seen >= length && new string(window) == terminator) return;
                }
            }

            // Copies <!DOCTYPE ...> (including an internal subset) verbatim.
            void CopyDeclaration()
            {
                int quote = 0;
                int bracketDepth = 0;
                char[] tail = new char[4];
                while (true)
                {
                    int c = Read();
                    if (c < 0) return;
                    writer.Write((char)c);
                    if (quote != 0)
                    {
                        if (c == quote) quote = 0;
                        continue;
                    }
                    Array.Copy(tail, 1, tail, 0, 3);
                    tail[3] = (char)c;
                    if (new string(tail) == "<!--") { CopyUntil("-->"); tail = new char[4]; continue; }
                    if (c == '"' || c == '\'') quote = c;
                    else if (c == '[') bracketDepth++;
                    else if (c == ']') bracketDepth--;
                    else if (c == '>' && bracketDepth <= 0) return;
                }
            }
        }
    }
}
"@

function Test-XmlWellFormed {
    param([string]$FilePath)

    $settings = New-Object System.Xml.XmlReaderSettings
    $settings.DtdProcessing = [System.Xml.DtdProcessing]::Ignore
    $settings.XmlResolver = $null
    $reader = $null
    try {
        $reader = [System.Xml.XmlReader]::Create($FilePath, $settings)
        while ($reader.Read()) { }
    }
    finally {
        if ($null -ne $reader) {
            $reader.Dispose()
        }
    }
}

function Invoke-XMLMinify {
    param(
        [string]$inputFilePath,
        [string]$outputFilePath
    )

    # Refuse malformed XML before writing anything, like formatting does.
    Test-XmlWellFormed -FilePath $inputFilePath
    if (-not ('AnyaXml.LexicalMinifier' -as [type])) {
        Add-Type -TypeDefinition $script:LexicalMinifierSource -Language CSharp
    }
    [AnyaXml.LexicalMinifier]::Minify($inputFilePath, $outputFilePath)
}

function Get-IndentChars {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -ieq "tab" -or $Value -ieq "tabs") {
        return "`t"
    }
    $spaces = 0
    if ([int]::TryParse($Value, [ref]$spaces) -and $spaces -ge 1 -and $spaces -le 8) {
        return " " * $spaces
    }
    throw "Unsupported indent '$Value'. Use 'tab' or a number of spaces from 1 to 8."
}

function Test-FileHasXmlDeclaration {
    param([string]$FilePath)

    $settings = New-Object System.Xml.XmlReaderSettings
    $settings.DtdProcessing = [System.Xml.DtdProcessing]::Ignore
    $settings.XmlResolver = $null
    $reader = $null
    try {
        $reader = [System.Xml.XmlReader]::Create($FilePath, $settings)
        return $reader.Read() -and $reader.NodeType -eq [System.Xml.XmlNodeType]::XmlDeclaration
    }
    finally {
        if ($null -ne $reader) {
            $reader.Dispose()
        }
    }
}

function Test-FileHasUtf8Bom {
    param([string]$FilePath)

    $stream = [System.IO.File]::OpenRead($FilePath)
    try {
        $bytes = New-Object byte[] 3
        $read = $stream.Read($bytes, 0, 3)
        return $read -eq 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    }
    finally {
        $stream.Dispose()
    }
}

function Format-XMLContent {
    param(
        [string]$inputFilePath,
        [string]$indentChars,
        [System.Text.Encoding]$outputEncoding
    )

    $xml = New-Object System.Xml.XmlDocument
    # Loading the file directly lets the XML parser honor its BOM or declared
    # encoding instead of decoding bytes with PowerShell's default text encoding.
    $xml.Load($inputFilePath)

    $settings = New-Object System.Xml.XmlWriterSettings
    $settings.Indent = $true
    $settings.IndentChars = $indentChars
    $settings.NewLineChars = "`n"
    $settings.Encoding = $outputEncoding
    $settings.OmitXmlDeclaration = -not (Test-FileHasXmlDeclaration -FilePath $inputFilePath)

    $tempFile = [System.IO.Path]::GetTempFileName()
    $writer = $null
    try {
        $writer = [System.Xml.XmlWriter]::Create($tempFile, $settings)
        $xml.WriteContentTo($writer)
        $writer.Flush()
        $writer.Close()
        $writer = $null

        return [System.IO.File]::ReadAllText($tempFile, $outputEncoding)
    }
    finally {
        if ($null -ne $writer) {
            $writer.Dispose()
        }
        if (Test-Path -LiteralPath $tempFile) {
            Remove-Item -LiteralPath $tempFile -Force
        }
    }
}

function Format-XMLContentStreaming {
    param(
        [string]$inputFilePath,
        [string]$outputFilePath,
        [string]$indentChars,
        [System.Text.Encoding]$outputEncoding
    )

    $readerSettings = New-Object System.Xml.XmlReaderSettings
    $readerSettings.ConformanceLevel = "Document"
    $readerSettings.IgnoreWhitespace = $true

    $writerSettings = New-Object System.Xml.XmlWriterSettings
    $writerSettings.ConformanceLevel = [System.Xml.ConformanceLevel]::Document
    $writerSettings.Indent = $true
    $writerSettings.IndentChars = $indentChars
    $writerSettings.NewLineChars = "`n"
    $writerSettings.Encoding = $outputEncoding
    $writerSettings.OmitXmlDeclaration = -not (Test-FileHasXmlDeclaration -FilePath $inputFilePath)

    $reader = $null
    $writer = $null
    try {
        $reader = [System.Xml.XmlReader]::Create($inputFilePath, $readerSettings)
        $writer = [System.Xml.XmlWriter]::Create($outputFilePath, $writerSettings)

        if ($reader.Read()) {
            do {
                # WriteNode advances the reader to the next sibling, so do not call Read() again here.
                $writer.WriteNode($reader, $false)
            } while (-not $reader.EOF)
        }
    }
    finally {
        if ($null -ne $reader) {
            $reader.Dispose()
        }
        if ($null -ne $writer) {
            $writer.Dispose()
        }
    }
}

# Main logic
if ([string]::IsNullOrWhiteSpace($InputFile)) {
    Write-Host "XML Formatter" -ForegroundColor Cyan
    Write-Host "=============" -ForegroundColor Cyan
    Write-Host ""
    $InputFile = Read-Host "Enter path to XML file"
}

try {
    if (-not (Test-Path -LiteralPath $InputFile -PathType Leaf)) {
        throw "File not found: $InputFile"
    }

    $inputPath = [System.IO.Path]::GetFullPath($InputFile)
    if ([string]::IsNullOrWhiteSpace($OutputFile)) {
        $inputDirectory = [System.IO.Path]::GetDirectoryName($inputPath)
        $inputExtension = [System.IO.Path]::GetExtension($inputPath)
        if ([string]::IsNullOrWhiteSpace($inputExtension)) {
            $inputExtension = ".xml"
        }
        $inputStem = [System.IO.Path]::GetFileNameWithoutExtension($inputPath)
        $baseStem = [System.Text.RegularExpressions.Regex]::Replace(
            $inputStem,
            '_(formatted|minified|oneline)(?:_\d+)?$',
            '',
            [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
        )
        $marker = if ($Minify) { "_minified" } else { "_formatted" }
        $outputStem = $baseStem + $marker
        $OutputFile = [System.IO.Path]::Combine($inputDirectory, $outputStem + $inputExtension)
        $number = 0
        while ([string]::Equals($inputPath, [System.IO.Path]::GetFullPath($OutputFile), [System.StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $OutputFile)) {
            $number++
            $OutputFile = [System.IO.Path]::Combine($inputDirectory, "${outputStem}_${number}${inputExtension}")
        }
    }
    $outputPath = [System.IO.Path]::GetFullPath($OutputFile)
    if ([string]::Equals($inputPath, $outputPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "The output file must be different from the input file. The original was not changed."
    }

    $outputDirectory = [System.IO.Path]::GetDirectoryName($outputPath)
    if (-not [System.IO.Directory]::Exists($outputDirectory)) {
        throw "Output directory does not exist: $outputDirectory"
    }
    $temporaryOutputPath = [System.IO.Path]::Combine(
        $outputDirectory,
        "." + [System.IO.Path]::GetFileName($outputPath) + "." + [System.Guid]::NewGuid().ToString("N") + ".tmp"
    )

    $fileSize = (Get-Item -LiteralPath $inputPath).Length / 1MB
    Write-Host "File size: $([Math]::Round($fileSize, 2)) MB" -ForegroundColor Cyan

    # Auto-select streaming for large files
    if ($fileSize -gt 50) {
        Write-Host "Large file detected. Using streaming mode for better performance..." -ForegroundColor Yellow
        $Streaming = $true
    }

    if ($Minify) {
        Write-Host "Minifying XML..." -ForegroundColor Yellow
        Invoke-XMLMinify -inputFilePath $inputPath -outputFilePath $temporaryOutputPath
    } else {
        $indentChars = Get-IndentChars -Value $Indent
        # Keep the input's BOM choice so normal and streaming output match.
        $outputEncoding = New-Object System.Text.UTF8Encoding((Test-FileHasUtf8Bom -FilePath $inputPath))
        if ($Streaming) {
            Write-Host "Reading and formatting XML (streaming mode)..." -ForegroundColor Yellow
            Format-XMLContentStreaming -inputFilePath $inputPath -outputFilePath $temporaryOutputPath -indentChars $indentChars -outputEncoding $outputEncoding
        } else {
            Write-Host "Reading XML file..." -ForegroundColor Yellow
            Write-Host "Formatting XML..." -ForegroundColor Yellow
            $formattedXml = Format-XMLContent -inputFilePath $inputPath -indentChars $indentChars -outputEncoding $outputEncoding
            [System.IO.File]::WriteAllText($temporaryOutputPath, $formattedXml, $outputEncoding)
        }
    }

    Move-Item -LiteralPath $temporaryOutputPath -Destination $outputPath -Force
    $resultName = if ($Minify) { "Minified XML" } else { "Formatted XML" }
    Write-Host "Done! $resultName saved to: $outputPath" -ForegroundColor Green
    exit 0
}
catch {
    if ($temporaryOutputPath -and (Test-Path -LiteralPath $temporaryOutputPath)) {
        Remove-Item -LiteralPath $temporaryOutputPath -Force -ErrorAction SilentlyContinue
    }
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
