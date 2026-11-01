const assert = require('node:assert/strict');
const Module = require('node:module');
const { test } = require('node:test');

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

const { validateXml, getFilteredXmlTableRows } = extension;

test('supports case-insensitive exact-value filtering', () => {
  const preview = {
    columns: ['city'],
    rows: [{ city: 'Toronto' }, { city: 'Toronto West' }]
  };

  assert.equal(getFilteredXmlTableRows(preview, 'toro').length, 2);
  assert.deepEqual(getFilteredXmlTableRows(preview, 'toronto', true), [{ city: 'Toronto' }]);
  assert.deepEqual(getFilteredXmlTableRows(preview, '  TORONTO  ', true), [{ city: 'Toronto' }]);
});

test('validates well-formed XML and reports malformed XML locations', () => {
  assert.equal(validateXml('<root><item>value</item></root>'), true);

  const result = validateXml('<root>\n  <item>\n</root>');
  assert.notEqual(result, true);
  assert.equal(result.err.line, 3);
  assert.ok(result.err.col > 0);
  assert.match(result.err.msg, /closing|close|tag/i);
});
