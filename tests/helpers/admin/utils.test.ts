import assert from 'node:assert/strict';
import test from 'node:test';

import { fromCents, maskBRL, parseDateTimeLocal, toCents } from '../../../public/admin/js/utils.js';

test('maskBRL formats Brazilian currency values', () => {
  assert.equal(maskBRL(''), '');
  assert.equal(maskBRL('0'), fromCents(0));
  assert.equal(maskBRL('1234'), fromCents(1234));
});

test('toCents and fromCents convert consistently', () => {
  assert.equal(toCents('R$ 1.234,56'), 123456);
  assert.equal(toCents('12,34'), 1234);
  assert.equal(fromCents(0), maskBRL('0'));
  assert.equal(fromCents(9876), 'R$\u00a098,76');
});

test('parseDateTimeLocal returns local dates or null', () => {
  const parsed = parseDateTimeLocal('2025-01-02T03:04');
  assert.ok(parsed instanceof Date);
  assert.equal(parsed?.getFullYear(), 2025);
  assert.equal(parsed?.getMonth(), 0);
  assert.equal(parsed?.getDate(), 2);
  assert.equal(parsed?.getHours(), 3);
  assert.equal(parsed?.getMinutes(), 4);
  assert.equal(parseDateTimeLocal(''), null);
  assert.equal(parseDateTimeLocal('invalid'), null);
});
