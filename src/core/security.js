// Password checks for encrypted PDFs (distinguishes owner and user passwords).
import { PDFDocument, PDFDict, PDFArray, PDFName, PDFNumber, PDFString, PDFHexString, PDFBool } from '@cantoo/pdf-lib';
import { CipherTransformFactory, PDF17, PDF20, encodeRevision6Password } from '../../node_modules/@cantoo/pdf-lib/es/core/crypto.js';

// Standard padding string from the PDF specification (Algorithm 2).
const PASSWORD_PADDING = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c,
  0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function bytesOf(obj) {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.asBytes();
  return new Uint8Array(0);
}

function latin1(str) {
  const out = new Uint8Array(Math.min(32, str.length));
  for (let i = 0; i < out.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function utf8Trunc(str) {
  const b = new TextEncoder().encode(str);
  return b.length > 127 ? b.subarray(0, 127) : b;
}

export async function readEncryption(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const ctx = doc.context;
  const encRef = ctx.trailerInfo.Encrypt;
  const enc = encRef ? ctx.lookup(encRef) : null;
  if (!(enc instanceof PDFDict)) return null;
  const num = (k, d = 0) => {
    const v = ctx.lookup(enc.get(PDFName.of(k)));
    return v instanceof PDFNumber ? v.asNumber() : d;
  };
  const idArr = ctx.lookup(ctx.trailerInfo.ID);
  let fileId = new Uint8Array(0);
  if (idArr instanceof PDFArray && idArr.size() > 0) fileId = bytesOf(ctx.lookup(idArr.get(0)));
  const em = ctx.lookup(enc.get(PDFName.of('EncryptMetadata')));
  return {
    R: num('R', 2),
    V: num('V', 0),
    P: num('P', 0),
    Length: num('Length', 40),
    O: bytesOf(ctx.lookup(enc.get(PDFName.of('O')))),
    U: bytesOf(ctx.lookup(enc.get(PDFName.of('U')))),
    encryptMetadata: em instanceof PDFBool ? em.asBoolean() : true,
    fileId,
  };
}

// Returns 'owner', 'user' or null.
export async function checkPassword(bytes, password) {
  const e = await readEncryption(bytes);
  if (!e) return 'owner';
  const pw = password || '';
  if (e.R >= 5) {
    const algo = e.R === 6 ? new PDF20() : new PDF17();
    const pwBytes = e.R === 6 ? encodeRevision6Password(pw) : utf8Trunc(pw);
    const ownerValidationSalt = e.O.subarray(32, 40);
    const uBytes = e.U.subarray(0, 48);
    if (algo.checkOwnerPassword(pwBytes, ownerValidationSalt, uBytes, e.O.subarray(0, 32))) return 'owner';
    if (algo.checkUserPassword(pwBytes, e.U.subarray(32, 40), e.U.subarray(0, 32))) return 'user';
    return null;
  }
  const factory = Object.create(CipherTransformFactory.prototype);
  factory.defaultPasswordBytes = PASSWORD_PADDING;
  const keyLength = e.V === 1 ? 40 : e.Length || 40;
  const pwBytes = latin1(pw);
  const decoded = factory.decodeUserPassword(pwBytes, e.O, e.R, keyLength);
  if (factory.prepareKeyData(e.fileId, decoded, e.O, e.U, e.P, e.R, keyLength, e.encryptMetadata)) return 'owner';
  if (factory.prepareKeyData(e.fileId, pwBytes, e.O, e.U, e.P, e.R, keyLength, e.encryptMetadata)) return 'user';
  return null;
}
