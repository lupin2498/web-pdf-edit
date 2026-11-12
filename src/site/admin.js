// Admin page (/admin/): revenue and usage figures, orders, bank transfers
// that need attention, account lookup and manual credits. Talks to
// /api/admin/* with the ADMIN_TOKEN as a bearer token.

const KEY = 'pdfedit.adminToken';
const root = document.getElementById('admin');
const actions = document.querySelector('[data-admin-actions]');
let token = sessionStorage.getItem(KEY) || '';
let tab = 'orders';
let orderFilter = 'pending';
let notice = null;

const nf = new Intl.NumberFormat('vi-VN');
const money = (amount, currency) => (currency === 'USD' ? `$${(amount / 100).toFixed(2)}` : `${nf.format(amount)} ₫`);
const when = (ms) => (ms ? new Date(ms).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const STATUS = { pending: 'Chờ thanh toán', paid: 'Đã thanh toán', expired: 'Hết hạn', cancelled: 'Đã hủy', matched: 'Khớp đơn', unmatched: 'Không khớp', underpaid: 'Thiếu tiền', extra: 'Thừa (đơn đã trả)' };
const PROVIDER = { bank: 'Chuyển khoản', paypal: 'PayPal', test: 'Thử nghiệm', manual: 'Thủ công' };

function h(tag, props = null, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(`/api/admin/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw Object.assign(new Error((data && data.message) || `HTTP ${res.status}`), { status: res.status });
  return data;
}

// ---------------------------------------------------------------- login

function login(error = '') {
  actions.replaceChildren();
  const input = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'ADMIN_TOKEN' });
  const form = h(
    'form',
    { class: 'admin-login' },
    h('h1', null, 'Đăng nhập quản trị'),
    h('div', { class: 'field' }, h('label', null, 'Mã quản trị (ADMIN_TOKEN)'), input),
    error ? h('p', { class: 'error-text' }, error) : null,
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Đăng nhập'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    token = input.value.trim();
    if (!token) return;
    try {
      await api('stats');
      sessionStorage.setItem(KEY, token);
      render();
    } catch (err) {
      token = '';
      login(err.status === 404 ? 'Trang quản trị chưa được bật: đặt biến ADMIN_TOKEN rồi khởi động lại máy chủ.' : err.status === 429 ? 'Thử sai quá nhiều lần, vui lòng đợi.' : 'Mã quản trị không đúng.');
    }
  });
  root.replaceChildren(form);
  input.focus();
}

function logout() {
  sessionStorage.removeItem(KEY);
  token = '';
  login();
}

// ---------------------------------------------------------------- dashboard

function stat(label, value, sub = null, cls = '') {
  return h('div', { class: `stat ${cls}` }, h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label), sub ? h('div', { class: 'stat-sub' }, sub) : null);
}

function revenueText(r) {
  const parts = [];
  if (r.VND) parts.push(money(r.VND.amount, 'VND'));
  if (r.USD) parts.push(money(r.USD.amount, 'USD'));
  return parts.join(' · ') || '0 ₫';
}
const ordersCount = (r) => Object.values(r).reduce((a, x) => a + x.orders, 0);

async function render() {
  actions.replaceChildren(h('button', { class: 'btn btn-outline btn-sm', onclick: () => render() }, 'Làm mới'), h('button', { class: 'btn btn-outline btn-sm', onclick: logout }, 'Đăng xuất'));
  let data;
  try {
    data = await api('stats');
  } catch (e) {
    if (e.status === 401 || e.status === 404) return login(e.status === 404 ? 'Trang quản trị chưa được bật.' : 'Phiên đăng nhập đã hết.');
    root.replaceChildren(h('p', { class: 'notice err' }, `Lỗi: ${e.message}`));
    return;
  }
  const st = data.stats;
  const cfg = data.config;
  const warnings = [];
  if (!cfg.providers.length) warnings.push('Chưa cấu hình phương thức thanh toán nào (BANK_* hoặc PAYPAL_*).');
  if (cfg.providers.includes('test')) warnings.push('PAYMENTS_TEST_MODE đang bật: ai cũng có thể hoàn tất đơn mà không trả tiền. Tắt trước khi chạy thật.');
  if (cfg.providers.includes('bank') && !cfg.sepay) warnings.push('Chuyển khoản chưa có SePay: hãy xác nhận đơn thủ công ở bảng dưới khi nhận được tiền.');
  if (!cfg.siteUrl) warnings.push('Chưa đặt SITE_URL (cần cho sitemap, liên kết chuẩn và PayPal).');

  const view = h('div', null);
  if (notice) {
    view.appendChild(h('div', { class: `notice ${notice.ok ? 'ok' : 'err'}` }, notice.text));
    notice = null;
  }
  for (const w of warnings) view.appendChild(h('div', { class: 'notice err' }, w));
  view.appendChild(
    h(
      'div',
      { class: 'stat-grid' },
      stat('Doanh thu hôm nay', revenueText(st.revenue.day), `${ordersCount(st.revenue.day)} đơn`),
      stat('7 ngày', revenueText(st.revenue.week), `${ordersCount(st.revenue.week)} đơn`),
      stat('30 ngày', revenueText(st.revenue.month), `${ordersCount(st.revenue.month)} đơn`),
      stat('Tổng doanh thu', revenueText(st.revenue.all), `${st.orders.paid} đơn đã thanh toán`),
      stat('Đơn đang chờ', nf.format(st.orders.pending), 'chưa hết hạn', st.orders.pending ? 'attention' : ''),
      stat('Trang đã dùng (24 giờ)', nf.format(st.usage.day.pages), `${nf.format(st.usage.day.free)} miễn phí · ${nf.format(st.usage.day.paid)} trả phí`),
      stat('Trang đã dùng (30 ngày)', nf.format(st.usage.month.pages), `${nf.format(st.usage.month.operations)} lượt xuất tệp`),
      stat('Người dùng', nf.format(st.accounts.total), `${nf.format(st.accounts.active24h)} hoạt động 24 giờ · ${nf.format(st.accounts.withCredits)} có trang mua`),
      stat('Trang đã bán chưa dùng', nf.format(st.accounts.creditsOutstanding)),
      stat('Giao dịch cần xem', nf.format(st.payments.needAttention), 'không khớp / thiếu / thừa tiền', st.payments.needAttention ? 'attention' : ''),
    ),
  );
  const tabs = h('div', { class: 'admin-tabs' });
  for (const [id, label] of [
    ['orders', 'Đơn hàng'],
    ['payments', 'Giao dịch cần xem'],
    ['account', 'Tài khoản'],
  ]) {
    tabs.appendChild(h('button', { class: tab === id ? 'active' : '', onclick: () => ((tab = id), render()) }, label));
  }
  view.appendChild(tabs);
  const panel = h('div', { class: 'panel' });
  view.appendChild(panel);
  root.replaceChildren(view);
  if (tab === 'orders') await renderOrders(panel);
  else if (tab === 'payments') await renderPayments(panel);
  else renderAccount(panel);
}

async function renderOrders(panel) {
  const filter = h('select', { class: 'input', style: 'width:auto' });
  for (const [v, l] of [
    ['pending', 'Chờ thanh toán'],
    ['paid', 'Đã thanh toán'],
    ['', 'Tất cả'],
    ['expired', 'Hết hạn'],
    ['cancelled', 'Đã hủy'],
  ]) {
    const o = h('option', { value: v }, l);
    if (v === orderFilter) o.selected = true;
    filter.appendChild(o);
  }
  filter.addEventListener('change', () => {
    orderFilter = filter.value;
    render();
  });
  panel.appendChild(h('div', { class: 'panel-head' }, h('h2', null, 'Đơn hàng'), filter));
  const { orders } = await api(`orders${orderFilter ? `?status=${orderFilter}` : ''}`);
  if (!orders.length) return panel.appendChild(h('div', { class: 'empty' }, 'Không có đơn nào.'));
  const tbody = h('tbody');
  for (const o of orders) {
    const action =
      o.status === 'pending' || o.status === 'expired'
        ? h(
            'button',
            {
              class: 'btn btn-sm btn-outline',
              onclick: async () => {
                if (!confirm(`Xác nhận đã nhận ${money(o.amount, o.currency)} cho đơn ${o.code}? Người mua sẽ được cộng ${o.pages} trang.`)) return;
                try {
                  const r = await api('orders/confirm', { method: 'POST', body: { order: o.code } });
                  notice = { ok: true, text: r.status === 'already_paid' ? `Đơn ${o.code} đã được thanh toán trước đó.` : `Đã xác nhận đơn ${o.code}.` };
                } catch (e) {
                  notice = { ok: false, text: `Không xác nhận được: ${e.message}` };
                }
                render();
              },
            },
            'Xác nhận đã nhận tiền',
          )
        : null;
    tbody.appendChild(
      h(
        'tr',
        null,
        h('td', null, when(o.createdAt)),
        h('td', { class: 'mono' }, o.code),
        h('td', { class: 'mono' }, h('a', { href: '#', onclick: (e) => (e.preventDefault(), lookup(o.account)) }, o.account || '—')),
        h('td', null, `${nf.format(o.pages)} trang`),
        h('td', null, money(o.amount, o.currency)),
        h('td', null, PROVIDER[o.provider] || o.provider),
        h('td', null, h('span', { class: `tag ${o.status}` }, STATUS[o.status] || o.status)),
        h('td', null, o.paidAt ? when(o.paidAt) : ''),
        h('td', null, action),
      ),
    );
  }
  panel.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', null, h('tr', null, ['Thời gian', 'Mã đơn', 'Tài khoản', 'Gói', 'Số tiền', 'Phương thức', 'Trạng thái', 'Thanh toán lúc', ''].map((x) => h('th', null, x)))), tbody)));
}

async function renderPayments(panel) {
  panel.appendChild(h('div', { class: 'panel-head' }, h('h2', null, 'Giao dịch cần xem')));
  panel.appendChild(h('p', { class: 'muted' }, 'Tiền vào tài khoản nhưng không khớp đơn nào, chuyển thiếu, hoặc chuyển thêm cho đơn đã thanh toán. Kiểm tra nội dung chuyển khoản rồi cộng trang thủ công ở mục Tài khoản nếu cần.'));
  const { payments } = await api('payments?attention=1');
  if (!payments.length) return panel.appendChild(h('div', { class: 'empty' }, 'Không có giao dịch nào cần xử lý.'));
  const tbody = h('tbody');
  for (const p of payments) {
    tbody.appendChild(h('tr', null, h('td', null, when(p.createdAt)), h('td', null, money(p.amount, p.currency || 'VND')), h('td', null, h('span', { class: `tag ${p.status}` }, STATUS[p.status] || p.status)), h('td', { class: 'wrap' }, p.content || ''), h('td', { class: 'mono' }, p.id)));
  }
  panel.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', null, h('tr', null, ['Thời gian', 'Số tiền', 'Tình trạng', 'Nội dung', 'Mã giao dịch'].map((x) => h('th', null, x)))), tbody)));
}

let accountRef = '';
function lookup(ref) {
  accountRef = ref;
  tab = 'account';
  render();
}

function renderAccount(panel) {
  const input = h('input', { class: 'input', placeholder: 'Mã tài khoản hoặc mã khôi phục', value: accountRef });
  const form = h('form', { class: 'form-row-inline' }, h('div', { class: 'field' }, h('label', null, 'Tìm tài khoản'), input), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Tìm'));
  const result = h('div', { style: 'margin-top:18px' });
  panel.append(h('div', { class: 'panel-head' }, h('h2', null, 'Tài khoản')), form, result);
  const show = async () => {
    accountRef = input.value.trim();
    if (!accountRef) return;
    result.replaceChildren(h('span', { class: 'spinner' }));
    let acc;
    try {
      ({ account: acc } = await api(`account?ref=${encodeURIComponent(accountRef)}`));
    } catch (e) {
      result.replaceChildren(h('p', { class: 'notice err' }, e.status === 404 ? 'Không tìm thấy tài khoản.' : e.message));
      return;
    }
    const pages = h('input', { class: 'input', type: 'number', step: '1', placeholder: 'ví dụ 100 hoặc -20' });
    const note = h('input', { class: 'input', placeholder: 'Ghi chú (mã giao dịch, lý do...)' });
    const grant = h(
      'form',
      { class: 'form-row-inline' },
      h('div', { class: 'field' }, h('label', null, 'Cộng / trừ trang'), pages),
      h('div', { class: 'field', style: 'flex:2' }, h('label', null, 'Ghi chú'), note),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Áp dụng'),
    );
    grant.addEventListener('submit', async (e) => {
      e.preventDefault();
      const n = parseInt(pages.value, 10);
      if (!Number.isInteger(n) || n === 0) return;
      try {
        await api('grant', { method: 'POST', body: { account: acc.id, pages: n, note: note.value } });
        notice = { ok: true, text: `Đã ${n > 0 ? 'cộng' : 'trừ'} ${Math.abs(n)} trang cho ${acc.id}.` };
      } catch (err) {
        notice = { ok: false, text: err.message };
      }
      render();
    });
    const ledger = h('tbody');
    for (const l of acc.ledger) ledger.appendChild(h('tr', null, h('td', null, when(l.createdAt)), h('td', null, l.delta > 0 ? `+${l.delta}` : String(l.delta)), h('td', null, String(l.balance)), h('td', null, { purchase: 'Mua gói', usage: 'Sử dụng', admin: 'Quản trị' }[l.reason] || l.reason), h('td', { class: 'mono wrap' }, l.ref || '')));
    result.replaceChildren(
      h(
        'div',
        { class: 'grid-2' },
        h(
          'dl',
          { class: 'kv' },
          h('dt', null, 'Mã tài khoản'),
          h('dd', { class: 'mono' }, acc.id),
          h('dt', null, 'Mã khôi phục'),
          h('dd', { class: 'mono' }, acc.restoreCode),
          h('dt', null, 'Tạo lúc'),
          h('dd', null, when(acc.createdAt)),
          h('dt', null, 'Hoạt động gần nhất'),
          h('dd', null, when(acc.lastSeen)),
          h('dt', null, 'Trang miễn phí đã dùng'),
          h('dd', null, nf.format(acc.freeUsed)),
          h('dt', null, 'Trang đã mua còn lại'),
          h('dd', null, nf.format(acc.credits)),
          h('dt', null, 'Tổng trang đã xuất'),
          h('dd', null, nf.format(acc.pagesTotal)),
        ),
        h('div', null, grant),
      ),
      h('h3', { style: 'margin-top:22px' }, 'Lịch sử số dư'),
      acc.ledger.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', null, h('tr', null, ['Thời gian', 'Thay đổi', 'Số dư', 'Lý do', 'Tham chiếu'].map((x) => h('th', null, x)))), ledger)) : h('div', { class: 'empty' }, 'Chưa có thay đổi số dư.'),
    );
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    show();
  });
  if (accountRef) show();
}

if (token) render();
else login();
