const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const scriptPath = path.join(__dirname, '..', 'formatXML.ps1');
const pwsh = [process.env.ANYAXML_PWSH, '/opt/homebrew/bin/pwsh', '/usr/local/bin/pwsh', '/usr/bin/pwsh']
  .find((candidate) => candidate && existsSync(candidate))
  ?? (spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0 ? 'pwsh' : undefined);
const skip = pwsh ? false : 'PowerShell (pwsh) is not installed';

async function runFormatter(input, ...args) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anyaxml-formatter-'));
  try {
    const inputPath = path.join(directory, 'input.xml');
    const outputPath = path.join(directory, 'output.xml');
    await writeFile(inputPath, input);
    const result = spawnSync(pwsh, [
      '-NoProfile', '-NonInteractive', '-File', scriptPath,
      '-InputFile', inputPath, '-OutputFile', outputPath, ...args
    ], { encoding: 'utf8' });
    if (result.status !== 0) {
      return { status: result.status, stderr: result.stderr };
    }
    return { status: 0, output: await readFile(outputPath) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('minify removes only indentation and keeps every value exactly as written', { skip }, async () => {
  const input = [
    '<?xml version="1.0"?>',
    "<root a='single' b=\"x &gt; y\">",
    '  <item>x &amp; y</item>',
    '  <item><![CDATA[<raw>  keep ]]></item>',
    '  <!-- comment -->',
    '  <empty/>',
    '  <blank> </blank>',
    '  <multi',
    '     attr="1">value</multi>',
    '  <note>line1',
    'line2</note>',
    '  <ent>&#x00E9;</ent>',
    '</root>',
    ''
  ].join('\n');

  const result = await runFormatter(input, '-Minify');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.output.toString('utf8'),
    '<?xml version="1.0"?>'
      + "<root a='single' b=\"x &gt; y\"><item>x &amp; y</item><item><![CDATA[<raw>  keep ]]></item>"
      + '<!-- comment --><empty/><blank> </blank><multi attr="1">value</multi>'
      + '<note>line1\nline2</note><ent>&#x00E9;</ent></root>'
  );
});

test('minify keeps xml:space="preserve" content and mixed-content spacing', { skip }, async () => {
  const input = '<r>\n  <p>Hello <b>bold</b>\n  <i>it</i></p>\n  <pre xml:space="preserve">\n    <c/>\n  </pre>\n</r>';
  const result = await runFormatter(input, '-Minify');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.output.toString('utf8'),
    '<r><p>Hello <b>bold</b>\n  <i>it</i></p><pre xml:space="preserve">\n    <c/>\n  </pre></r>'
  );
});

test('minify preserves the original bytes of BOMs and non-UTF-8 encodings', { skip }, async () => {
  const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<r>\n  <n>Zoë 😀</n>\n</r>')]);
  const utf8Result = await runFormatter(utf8, '-Minify');
  assert.deepEqual(utf8Result.output, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<r><n>Zoë 😀</n></r>')]));

  const latin1 = Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?>\n<r>\n  <n>café</n>\n</r>', 'latin1');
  const latin1Result = await runFormatter(latin1, '-Minify');
  assert.deepEqual(latin1Result.output, Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><r><n>café</n></r>', 'latin1'));
});

test('minify refuses malformed XML', { skip }, async () => {
  const result = await runFormatter('<root><a></root>', '-Minify');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match the end tag/);
});

test('format indents with tabs by default and spaces on request, matching in streaming mode', { skip }, async () => {
  const input = '<r><a><b>1</b></a></r>';
  const tabs = await runFormatter(input);
  assert.equal(tabs.output.toString('utf8'), '<r>\n\t<a>\n\t\t<b>1</b>\n\t</a>\n</r>');

  const streaming = await runFormatter(input, '-Streaming');
  assert.deepEqual(streaming.output, tabs.output);

  const spaces = await runFormatter(input, '-Indent', '4');
  assert.equal(spaces.output.toString('utf8'), '<r>\n    <a>\n        <b>1</b>\n    </a>\n</r>');
});

test('format keeps the input BOM and does not add a missing XML declaration', { skip }, async () => {
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<?xml version="1.0"?><r><a/></r>')]);
  for (const mode of [[], ['-Streaming']]) {
    const bomResult = await runFormatter(withBom, ...mode);
    assert.deepEqual([...bomResult.output.subarray(0, 3)], [0xef, 0xbb, 0xbf]);

    const plain = await runFormatter('<r><a/></r>', ...mode);
    assert.equal(plain.output.toString('utf8'), '<r>\n\t<a />\n</r>');
  }
});
