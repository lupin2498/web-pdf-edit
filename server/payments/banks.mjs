// Vietnamese banks reachable through NAPAS 247 (VietQR): short code and the
// 6-digit acquirer id (BIN) that goes into the QR payload.
export const BANKS = [
  { code: 'VCB', bin: '970436', name: 'Vietcombank' },
  { code: 'ICB', bin: '970415', name: 'VietinBank' },
  { code: 'BIDV', bin: '970418', name: 'BIDV' },
  { code: 'VBA', bin: '970405', name: 'Agribank' },
  { code: 'MB', bin: '970422', name: 'MB Bank' },
  { code: 'TCB', bin: '970407', name: 'Techcombank' },
  { code: 'ACB', bin: '970416', name: 'ACB' },
  { code: 'VPB', bin: '970432', name: 'VPBank' },
  { code: 'TPB', bin: '970423', name: 'TPBank' },
  { code: 'STB', bin: '970403', name: 'Sacombank' },
  { code: 'HDB', bin: '970437', name: 'HDBank' },
  { code: 'VIB', bin: '970441', name: 'VIB' },
  { code: 'SHB', bin: '970443', name: 'SHB' },
  { code: 'EIB', bin: '970431', name: 'Eximbank' },
  { code: 'MSB', bin: '970426', name: 'MSB' },
  { code: 'OCB', bin: '970448', name: 'OCB' },
  { code: 'SCB', bin: '970429', name: 'SCB' },
  { code: 'LPB', bin: '970449', name: 'LPBank' },
  { code: 'SEAB', bin: '970440', name: 'SeABank' },
  { code: 'NAB', bin: '970428', name: 'Nam A Bank' },
  { code: 'ABB', bin: '970425', name: 'ABBANK' },
  { code: 'BAB', bin: '970409', name: 'Bac A Bank' },
  { code: 'PVCB', bin: '970412', name: 'PVcomBank' },
  { code: 'NCB', bin: '970419', name: 'NCB' },
  { code: 'VAB', bin: '970427', name: 'VietABank' },
  { code: 'PGB', bin: '970430', name: 'PGBank' },
  { code: 'KLB', bin: '970452', name: 'Kienlongbank' },
  { code: 'BVB', bin: '970438', name: 'BaoViet Bank' },
  { code: 'VCCB', bin: '970454', name: 'BVBank (Viet Capital)' },
  { code: 'SGICB', bin: '970400', name: 'Saigonbank' },
  { code: 'VIETBANK', bin: '970433', name: 'VietBank' },
  { code: 'SHBVN', bin: '970424', name: 'Shinhan Bank' },
  { code: 'WVN', bin: '970457', name: 'Woori Bank' },
  { code: 'UOB', bin: '970458', name: 'UOB' },
  { code: 'CAKE', bin: '546034', name: 'CAKE by VPBank' },
  { code: 'UBANK', bin: '546035', name: 'Ubank by VPBank' },
  { code: 'TIMO', bin: '963388', name: 'Timo' },
];

const ALIASES = {
  VIETCOMBANK: 'VCB',
  VIETINBANK: 'ICB',
  CTG: 'ICB',
  AGRIBANK: 'VBA',
  MBBANK: 'MB',
  MBB: 'MB',
  TECHCOMBANK: 'TCB',
  VPBANK: 'VPB',
  TPBANK: 'TPB',
  SACOMBANK: 'STB',
  HDBANK: 'HDB',
  EXIMBANK: 'EIB',
  LPBANK: 'LPB',
  LIENVIETPOSTBANK: 'LPB',
  SEABANK: 'SEAB',
  NAMABANK: 'NAB',
  ABBANK: 'ABB',
  BACABANK: 'BAB',
  PVCOMBANK: 'PVCB',
  VIETABANK: 'VAB',
  PGBANK: 'PGB',
  KIENLONGBANK: 'KLB',
  BAOVIETBANK: 'BVB',
  BVBANK: 'VCCB',
  VIETCAPITALBANK: 'VCCB',
  SAIGONBANK: 'SGICB',
  SHINHAN: 'SHBVN',
  SHINHANBANK: 'SHBVN',
  WOORI: 'WVN',
};

/** Finds a bank by short code, common name or 6-digit BIN. */
export function findBank(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^\d{6}$/.test(raw)) return BANKS.find((b) => b.bin === raw) || { code: raw, bin: raw, name: `Ngân hàng ${raw}` };
  const key = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const code = ALIASES[key] || key;
  return BANKS.find((b) => b.code === code) || null;
}
