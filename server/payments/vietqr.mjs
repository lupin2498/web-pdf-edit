// VietQR (NAPAS 247) payload: the EMVCo merchant-presented QR string that
// every Vietnamese banking app reads as "transfer <amount> to <account> with
// <content>". The string is rendered as a QR code by the client.

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) as required by EMVCo. */
export function crc16(text) {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i++) {
    crc ^= text.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function field(id, value) {
  const v = String(value);
  if (v.length > 99) throw new Error(`VietQR field ${id} is too long`);
  return `${id}${String(v.length).padStart(2, '0')}${v}`;
}

/**
 * @param {object} o
 * @param {string} o.bin      6-digit bank id (acquirer BIN)
 * @param {string} o.account  receiving account number
 * @param {number} [o.amount] amount in VND (whole number); omitted = payer types it
 * @param {string} [o.content] transfer description (ASCII letters, digits, spaces)
 */
export function vietQrPayload({ bin, account, amount = 0, content = '' }) {
  if (!/^\d{6}$/.test(String(bin))) throw new Error('VietQR: bin must have 6 digits');
  if (!/^[A-Za-z0-9]{1,19}$/.test(String(account))) throw new Error('VietQR: invalid account number');
  const amt = Math.round(Number(amount) || 0);
  const text = String(content || '').replace(/[^A-Za-z0-9 .\-]/g, '').slice(0, 50);
  const beneficiary = field('00', bin) + field('01', account);
  const merchant = field('00', 'A000000727') + field('01', beneficiary) + field('02', 'QRIBFTTA');
  let payload =
    field('00', '01') +
    // 12 = dynamic (amount fixed by the payee), 11 = static.
    field('01', amt > 0 ? '12' : '11') +
    field('38', merchant) +
    field('53', '704');
  if (amt > 0) payload += field('54', String(amt));
  payload += field('58', 'VN');
  if (text) payload += field('62', field('08', text));
  payload += '6304';
  return payload + crc16(payload);
}

/** Parses a top-level EMV TLV string into { id: value } (used by tests). */
export function parseTlv(text) {
  const out = {};
  let i = 0;
  while (i + 4 <= text.length) {
    const id = text.slice(i, i + 2);
    const len = parseInt(text.slice(i + 2, i + 4), 10);
    if (!Number.isFinite(len)) break;
    out[id] = text.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}
