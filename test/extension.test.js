const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { XMLParser } = require('fast-xml-parser');

const originalLoad = Module._load;
let extension;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  extension = require('../out/extension');
} finally {
  Module._load = originalLoad;
}

const { buildXmlTablePreview, buildXmlTablePreviewFromFile, validateXml, getFilteredXmlTableRows } = extension;

test('supports case-insensitive exact-value filtering', () => {
  const preview = {
    columns: ['city'],
    rows: [{ city: 'Toronto' }, { city: 'Toronto West' }]
  };

  assert.equal(getFilteredXmlTableRows(preview, 'toro').length, 2);
  assert.deepEqual(getFilteredXmlTableRows(preview, 'toronto', true), [{ city: 'Toronto' }]);
  assert.deepEqual(getFilteredXmlTableRows(preview, '  TORONTO  ', true), [{ city: 'Toronto' }]);
});

test('flattens repeated beneficiaries into one-based columns for 10,245 transactions', async () => {
  const transactionCount = 10_245;
  const transactions = Array.from({ length: transactionCount }, (_, index) => {
    const ordinal = String(index + 1).padStart(8, '0');
    return `<Transaction sequence="${index + 1}"><MessageType>MT103</MessageType><Beneficiaries count="2"><Beneficiary><ID>BEN${ordinal}</ID><Name>TEST BENEFICIARY ${ordinal}</Name><Address>SAMPLE CITY US</Address></Beneficiary><Beneficiary><ID>TEST${ordinal}B</ID><Name>TEST BENEFICIARY ${ordinal}</Name><Address>SAMPLE CITY US</Address></Beneficiary></Beneficiaries></Transaction>`;
  }).join('');
  const xml = `<Transactions count="${transactionCount}">${transactions}</Transactions>`;
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (_name, _jPath, _isLeafNode, isAttribute) => !isAttribute
  });

  const preview = buildXmlTablePreview(parser.parse(xml));
  assert.equal(preview.sourcePath, 'Transactions.Transaction');
  assert.equal(preview.totalRows, transactionCount);
  assert.equal(preview.rows[0]['@sequence'], '1');
  assert.equal(preview.rows.at(-1)['@sequence'], String(transactionCount));
  assert.equal(preview.rows[0]['Beneficiaries.Beneficiary[1].ID'], 'BEN00000001');
  assert.equal(preview.rows[0]['Beneficiaries.Beneficiary[1].Name'], 'TEST BENEFICIARY 00000001');
  assert.equal(preview.rows[0]['Beneficiaries.Beneficiary[1].Address'], 'SAMPLE CITY US');
  assert.equal(preview.rows[0]['Beneficiaries.Beneficiary[2].ID'], 'TEST00000001B');
  assert.equal(preview.rows[0]['Beneficiaries.Beneficiary[2].Name'], 'TEST BENEFICIARY 00000001');
  assert.equal(preview.rows[0]['Beneficiaries.Beneficiary[2].Address'], 'SAMPLE CITY US');
  assert.ok(preview.columns.every((column) => !column.includes('Beneficiary[0]')));

  const singleBeneficiary = buildXmlTablePreview(parser.parse(
    '<Transactions><Transaction sequence="1"><Beneficiaries><Beneficiary><ID>BEN00000001</ID><Name>FIRST</Name><Address>SAMPLE CITY US</Address></Beneficiary></Beneficiaries></Transaction></Transactions>'
  ));
  assert.equal(singleBeneficiary.rows[0]['Beneficiaries.Beneficiary[1].ID'], 'BEN00000001');
  assert.equal(singleBeneficiary.rows[0]['Beneficiaries.Beneficiary[1].Name'], 'FIRST');
  assert.equal(singleBeneficiary.rows[0]['Beneficiaries.Beneficiary[1].Address'], 'SAMPLE CITY US');

  const directory = await mkdtemp(path.join(os.tmpdir(), 'anyaxml-'));
  const filePath = path.join(directory, 'transactions.xml');
  try {
    await writeFile(filePath, xml);
    const streamedPreview = await buildXmlTablePreviewFromFile(filePath);
    assert.equal(streamedPreview.sourcePath, preview.sourcePath);
    assert.equal(streamedPreview.totalRows, transactionCount);
    assert.deepEqual([...streamedPreview.columns].sort(), [...preview.columns].sort());
    assert.deepEqual(streamedPreview.rows[0], preview.rows[0]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('validates well-formed XML and reports malformed XML locations', () => {
  assert.equal(validateXml('<root><item>value</item></root>'), true);

  const result = validateXml('<root>\n  <item>\n</root>');
  assert.notEqual(result, true);
  assert.equal(result.err.line, 3);
  assert.ok(result.err.col > 0);
  assert.match(result.err.msg, /closing|close|tag/i);
});
