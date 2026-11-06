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

test('keeps nested count attributes with their element fields in preview order', () => {
  const transaction = (sequence, detailsOfCharges, firstId, secondId) =>
    `<Transaction sequence="${sequence}"><MessageType>MT103</MessageType>`
      + `<DetailsOfCharges>${detailsOfCharges}</DetailsOfCharges><Beneficiaries count="2">`
      + `<Beneficiary><ID>${firstId}</ID></Beneficiary>`
      + `<Beneficiary><ID>${secondId}</ID></Beneficiary>`
      + '</Beneficiaries></Transaction>';
  const xml = '<Transactions>'
    + transaction('1', 'SHA', 'BEN00000001', 'TEST00000001B')
    + transaction('2', 'OUR', 'BEN00000002', 'TEST00000002B')
    + '</Transactions>';
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (_name, _jPath, _isLeafNode, isAttribute) => !isAttribute
  });
  const preview = buildXmlTablePreview(parser.parse(xml));

  assert.deepEqual(preview.columns, [
    '@sequence',
    'MessageType',
    'DetailsOfCharges',
    'Beneficiaries.@count',
    'Beneficiaries.Beneficiary[1].ID',
    'Beneficiaries.Beneficiary[2].ID'
  ]);
});

test('places a deeply nested count beside its group instead of before other nested fields', async () => {
  const xml = '<Reports><EFTReport type="SWIFT"><ReportReference>REF-1</ReportReference>'
    + '<TransactionInformation><Amount>12000.00</Amount></TransactionInformation>'
    + '<OrderingClient><Individual><LastName>Smith</LastName>'
    + '<Address><City>Toronto</City></Address><Identifiers count="2">'
    + '<Identifier><IDType>DriversLicense</IDType></Identifier>'
    + '<Identifier><IDType>Passport</IDType></Identifier>'
    + '</Identifiers></Individual><AccountNumber>9876543210</AccountNumber></OrderingClient>'
    + '</EFTReport></Reports>';
  const expected = [
    '@type',
    'ReportReference',
    'TransactionInformation.Amount',
    'OrderingClient.Individual.LastName',
    'OrderingClient.Individual.Address.City',
    'OrderingClient.Individual.Identifiers.@count',
    'OrderingClient.Individual.Identifiers.Identifier[1].IDType',
    'OrderingClient.Individual.Identifiers.Identifier[2].IDType',
    'OrderingClient.AccountNumber'
  ];
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (_name, _jPath, _isLeafNode, isAttribute) => !isAttribute
  });
  assert.deepEqual(buildXmlTablePreview(parser.parse(xml)).columns, expected);

  const directory = await mkdtemp(path.join(os.tmpdir(), 'anyaxml-nested-count-'));
  try {
    const filePath = path.join(directory, 'report.xml');
    await writeFile(filePath, xml);
    assert.deepEqual((await buildXmlTablePreviewFromFile(filePath)).columns, expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps extra repeated columns from later rows next to their group', () => {
  const xml = '<Reports>'
    + '<R><Ref>A</Ref><Client><Name>X</Name><Ids count="1"><Id><T>DL</T></Id></Ids><Acct>1</Acct></Client></R>'
    + '<R><Ref>B</Ref><Client><Name>Y</Name><Ids count="3"><Id><T>DL</T></Id><Id><T>PP</T></Id><Id><T>HC</T></Id></Ids><Acct>2</Acct></Client></R>'
    + '</Reports>';
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (_name, _jPath, _isLeafNode, isAttribute) => !isAttribute
  });
  assert.deepEqual(buildXmlTablePreview(parser.parse(xml)).columns, [
    'Ref',
    'Client.Name',
    'Client.Ids.@count',
    'Client.Ids.Id[1].T',
    'Client.Ids.Id[2].T',
    'Client.Ids.Id[3].T',
    'Client.Acct'
  ]);
});

test('previews a singleton report as the row when it contains repeated identifiers', () => {
  const xml = '<FINTRACBatchReport>'
    + '<BatchHeader><BatchId>BATCH-1</BatchId></BatchHeader>'
    + '<Reports><EFTReport><ReportReference>REF-1</ReportReference>'
    + '<TransactionInformation><Amount>12000.00</Amount><CurrencyCode>CAD</CurrencyCode></TransactionInformation>'
    + '<OrderingClient><Individual><LastName>Smith</LastName><Identifiers count="2">'
    + '<Identifier><IDType>DriversLicense</IDType><IDNumber>S1234</IDNumber></Identifier>'
    + '<Identifier><IDType>Passport</IDType><IDNumber>ZE998</IDNumber></Identifier>'
    + '</Identifiers></Individual><AccountNumber>9876543210</AccountNumber></OrderingClient>'
    + '<BeneficiaryClient><AccountNumber>1122334455</AccountNumber></BeneficiaryClient>'
    + '</EFTReport></Reports><BatchTrailer><TotalReportCount>1</TotalReportCount></BatchTrailer>'
    + '</FINTRACBatchReport>';
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (_name, _jPath, _isLeafNode, isAttribute) => !isAttribute
  });

  const preview = buildXmlTablePreview(parser.parse(xml));

  assert.equal(preview.sourcePath, 'FINTRACBatchReport.Reports.EFTReport');
  assert.equal(preview.totalRows, 1);
  assert.equal(preview.rows[0].ReportReference, 'REF-1');
  assert.equal(preview.rows[0]['TransactionInformation.Amount'], '12000.00');
  assert.equal(preview.rows[0]['OrderingClient.Individual.LastName'], 'Smith');
  assert.equal(preview.rows[0]['OrderingClient.Individual.Identifiers.@count'], '2');
  assert.equal(preview.rows[0]['OrderingClient.Individual.Identifiers.Identifier[1].IDNumber'], 'S1234');
  assert.equal(preview.rows[0]['OrderingClient.Individual.Identifiers.Identifier[2].IDNumber'], 'ZE998');
  assert.equal(preview.rows[0]['BeneficiaryClient.AccountNumber'], '1122334455');
  assert.ok(!preview.columns.includes('BatchHeader.BatchId'));
  assert.ok(!preview.columns.includes('BatchTrailer.TotalReportCount'));
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
  assert.equal(singleBeneficiary.rows[0]['Beneficiaries.Beneficiary.ID'], 'BEN00000001');
  assert.equal(singleBeneficiary.rows[0]['Beneficiaries.Beneficiary.Name'], 'FIRST');
  assert.equal(singleBeneficiary.rows[0]['Beneficiaries.Beneficiary.Address'], 'SAMPLE CITY US');
  assert.ok(singleBeneficiary.columns.every((column) => !column.includes('Beneficiary[1]')));

  const directory = await mkdtemp(path.join(os.tmpdir(), 'anyaxml-'));
  const filePath = path.join(directory, 'transactions.xml');
  try {
    await writeFile(filePath, xml);
    const progress = [];
    const streamedPreview = await buildXmlTablePreviewFromFile(filePath, percentage => progress.push(percentage));
    assert.equal(streamedPreview.sourcePath, preview.sourcePath);
    assert.equal(streamedPreview.totalRows, transactionCount);
    assert.deepEqual([...streamedPreview.columns].sort(), [...preview.columns].sort());
    assert.deepEqual(streamedPreview.rows[0], preview.rows[0]);
    assert.equal(progress.at(-1), 100);
    assert.ok(progress.every((percentage, index) => index === 0 || percentage >= progress[index - 1]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('indexes only repeated nested elements and keeps columns aligned across rows', async () => {
  const xml = '<Transactions>'
    + '<Transaction sequence="1"><State><Code>OPEN</Code></State><Beneficiaries><Beneficiary><ID>BEN-A</ID></Beneficiary><Beneficiary><ID>BEN-B</ID></Beneficiary></Beneficiaries></Transaction>'
    + '<Transaction sequence="2"><State><Code>CLOSED</Code></State><Beneficiaries><Beneficiary><ID>BEN-C</ID></Beneficiary></Beneficiaries></Transaction>'
    + '</Transactions>';
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (_name, _jPath, _isLeafNode, isAttribute) => !isAttribute
  });
  const preview = buildXmlTablePreview(parser.parse(xml));

  assert.equal(preview.rows[0]['State.Code'], 'OPEN');
  assert.equal(preview.rows[0]['State[1].Code'], undefined);
  assert.equal(preview.rows[0]['Beneficiaries.Beneficiary[1].ID'], 'BEN-A');
  assert.equal(preview.rows[0]['Beneficiaries.Beneficiary[2].ID'], 'BEN-B');
  assert.equal(preview.rows[1]['Beneficiaries.Beneficiary[1].ID'], 'BEN-C');
  assert.equal(preview.rows[1]['Beneficiaries.Beneficiary[2].ID'], undefined);
  assert.ok(preview.columns.includes('Beneficiaries.Beneficiary[2].ID'));
  assert.ok(!preview.columns.includes('Beneficiaries.Beneficiary.ID'));

  const directory = await mkdtemp(path.join(os.tmpdir(), 'anyaxml-singleton-index-'));
  const filePath = path.join(directory, 'transactions.xml');
  try {
    await writeFile(filePath, xml);
    const streamedPreview = await buildXmlTablePreviewFromFile(filePath);
    assert.deepEqual([...streamedPreview.columns].sort(), [...preview.columns].sort());
    assert.deepEqual(streamedPreview.rows, preview.rows);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not add occurrence numbers to singleton transaction information tags', async () => {
  const xml = '<raw_header>'
    + '<cibc_reference_number><reference_number>OCT6188450056044_1</reference_number><transactional_information><tran_info_date>2026-07-03</tran_info_date><tran_info_time>15:35:55</tran_info_time></transactional_information></cibc_reference_number>'
    + '<cibc_reference_number><reference_number>OCT6188450056044_2</reference_number><transactional_information><tran_info_date>2026-07-07</tran_info_date><tran_info_time>16:35:55</tran_info_time></transactional_information></cibc_reference_number>'
    + '</raw_header>';
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (_name, _jPath, _isLeafNode, isAttribute) => !isAttribute
  });
  const preview = buildXmlTablePreview(parser.parse(xml));

  assert.equal(preview.rows[0]['transactional_information.tran_info_date'], '2026-07-03');
  assert.equal(preview.rows[0]['transactional_information[1].tran_info_date'], undefined);
  assert.ok(preview.columns.every((column) => !column.startsWith('transactional_information[1]')));

  const directory = await mkdtemp(path.join(os.tmpdir(), 'anyaxml-singleton-transaction-info-'));
  const filePath = path.join(directory, 'transactions.xml');
  try {
    await writeFile(filePath, xml);
    const streamedPreview = await buildXmlTablePreviewFromFile(filePath);
    assert.deepEqual([...streamedPreview.columns].sort(), [...preview.columns].sort());
    assert.deepEqual(streamedPreview.rows, preview.rows);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('prefers repeated parent rows over wider nested groups and orders preview columns', async () => {
  const group = (name, value) => `<Group><Name>${name}</Name><A>${value}A</A><B>${value}B</B><C>${value}C</C><D>${value}D</D><E>${value}E</E><F>${value}F</F><G>${value}G</G><H>${value}H</H><Detail><Inner>${value}</Inner></Detail></Group>`;
  const xml = '<Root>'
    + `<Record id="R1" count="2"><Code>P1</Code><Label>parent one</Label><Details><Note>first note</Note></Details><Groups>${group('child one', '1')}${group('child two', '2')}</Groups></Record>`
    + `<Record id="R2" count="2"><Code>P2</Code><Label>parent two</Label><Details><Note>second note</Note></Details><Groups>${group('child three', '3')}${group('child four', '4')}</Groups></Record>`
    + '</Root>';
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (_name, _jPath, _isLeafNode, isAttribute) => !isAttribute
  });
  const preview = buildXmlTablePreview(parser.parse(xml));

  assert.equal(preview.sourcePath, 'Root.Record');
  assert.equal(preview.totalRows, 2);
  assert.equal(preview.rows[0]['@id'], 'R1');
  assert.equal(preview.rows[1]['@id'], 'R2');
  assert.equal(preview.rows[0]['Groups.Group[1].Name'], 'child one');
  assert.equal(preview.rows[1]['Groups.Group[2].Name'], 'child four');
  assert.deepEqual(preview.columns.slice(0, 4), ['@id', '@count', 'Code', 'Label']);
  assert.ok(preview.columns.slice(4).every((column) => column.includes('.')));

  const directory = await mkdtemp(path.join(os.tmpdir(), 'anyaxml-parent-rows-'));
  const filePath = path.join(directory, 'records.xml');
  try {
    await writeFile(filePath, xml);
    const streamedPreview = await buildXmlTablePreviewFromFile(filePath);
    assert.equal(streamedPreview.sourcePath, 'Root.Record');
    assert.equal(streamedPreview.totalRows, 2);
    assert.deepEqual(streamedPreview.columns, preview.columns);
    assert.deepEqual(streamedPreview.rows, preview.rows);
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
