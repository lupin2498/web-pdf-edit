import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { checkPassword } from '../../src/core/security.js';

const PW = {
  'AES-256': ['người dùng', 'chủ sở hữu'],
  'AES-128': ['user-pw', 'owner-pw'],
  'RC4-128': ['user-pw', 'owner-pw'],
};

async function makeEncrypted(algorithm) {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  page.drawText('x', { font: await doc.embedFont(StandardFonts.Helvetica) });
  doc.encrypt({ userPassword: PW[algorithm][0], ownerPassword: PW[algorithm][1], algorithm, allowWeakCryptography: true, permissions: { modifying: false } });
  return doc.save();
}

for (const algorithm of ['AES-256', 'AES-128', 'RC4-128']) {
  test(`distinguishes owner and user passwords (${algorithm})`, async () => {
    const bytes = await makeEncrypted(algorithm);
    assert.equal(await checkPassword(bytes, PW[algorithm][1]), 'owner');
    assert.equal(await checkPassword(bytes, PW[algorithm][0]), 'user');
    assert.equal(await checkPassword(bytes, 'sai'), null);
  });
}

test('unencrypted documents report owner access', async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  assert.equal(await checkPassword(await doc.save(), ''), 'owner');
});
