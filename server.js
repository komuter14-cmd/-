const express = require('express'), path = require('path'), fs = require('fs'), crypto = require('crypto');
const app = express(), PORT = process.env.PORT || 3000;
const FILE = path.join(__dirname, 'data.json');
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));

// ---- Хранилище: PostgreSQL если задан DATABASE_URL, иначе файл data.json ----
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL,
    ssl: /\.render\.com/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false });
}

// ---- Пароли: scrypt с солью ----
const hashPw = p => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(p, s, 32).toString('hex'); };
const checkPw = (p, h) => {
  const [s, k] = String(h).split(':'); if (!k) return false;
  const a = Buffer.from(k, 'hex'), b = crypto.scryptSync(p, s, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const rnd = () => crypto.randomBytes(9).toString('hex');
// Пароли хранятся хэшем (для входа) и в зашифрованном виде AES-256 (чтобы старший по рангу мог их видеть).
// Ключ берётся из SECRET_KEY, а если его нет — из DATABASE_URL (он секретный и постоянный).
const KEY = crypto.createHash('sha256').update(process.env.SECRET_KEY || process.env.DATABASE_URL || 'uz-local').digest();
const enc = p => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv), d = Buffer.concat([c.update(p, 'utf8'), c.final()]); return iv.toString('hex') + ':' + c.getAuthTag().toString('hex') + ':' + d.toString('hex'); };
const dec = s => { try { const [i, t, d] = s.split(':'), x = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(i, 'hex')); x.setAuthTag(Buffer.from(t, 'hex')); return Buffer.concat([x.update(Buffer.from(d, 'hex')), x.final()]).toString('utf8'); } catch { return null; } };
const mk = p => ({ hash: hashPw(p), pw: enc(p) });
const RANK = { owner: 3, admin: 2, guide: 1 };
const canSeePw = (m, u) => RANK[m.role] > RANK[u.role];

// ---- Настройки сайта (меняет только владелец) ----
const DEF = { siteName: 'Гиды Узбекистана', contact: '', notice: '', currency: '$',
  dayStart: '07:00', dayEnd: '23:00', minHours: 1, maxHours: 24, daysAhead: 90 };
const pad2 = n => String(n).padStart(2, '0');
const mins = t => { const [a, b] = String(t).split(':').map(Number); return a * 60 + (b || 0); };
const numIn = (v, d, a, b) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= a && n <= b ? n : d; };
const hhmm = (s, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || '')) ? s : d);
const cleanSettings = o => {
  const s = { siteName: str(o.siteName, 60) || DEF.siteName, contact: str(o.contact, 120),
    notice: str(o.notice, 400), currency: str(o.currency, 8) || DEF.currency,
    dayStart: hhmm(o.dayStart, DEF.dayStart), dayEnd: hhmm(o.dayEnd, DEF.dayEnd),
    minHours: numIn(o.minHours, DEF.minHours, 1, 24), maxHours: numIn(o.maxHours, DEF.maxHours, 1, 24),
    daysAhead: numIn(o.daysAhead, DEF.daysAhead, 0, 730) };
  if (s.maxHours < s.minHours) s.maxHours = s.minHours;
  return s;
};
// Сегодняшняя дата в Узбекистане (UTC+5) и «крайняя дата» для брони
const todayTZ = () => new Date(Date.now() + 5 * 36e5).toISOString().slice(0, 10);
const horizon = st => (st.daysAhead > 0 ? new Date(todayTZ() + 'T00:00:00+05:00').getTime() + st.daysAhead * 864e5 : Infinity);
const workHours = st => st.dayStart < st.dayEnd; // иначе работаем круглосуточно

const seed = () => ({
  users: [
    { login: 'owner', ...mk(process.env.OWNER_PASSWORD || '000'), role: 'owner', name: 'Основатель', langs: 'Все', price: 0, car: '' },
    { login: 'guide_timur', ...mk(rnd()), role: 'guide', name: 'Тимур (Ташкент)', langs: 'Русский, Узбекский, Английский', price: 50, car: 'Chevrolet Malibu 2 (01 A 123 AB)' },
    { login: 'guide_sardor', ...mk(rnd()), role: 'guide', name: 'Сардор (Самарканд)', langs: 'Русский, Узбекский', price: 40, car: 'Chevrolet Tracker (01 B 456 CD)' }
  ],
  bookings: [], sessions: [],
  chat: [{ author: 'Основатель', text: 'Чат персонала активен. Добро пожаловать!' }]
});

let S, q = Promise.resolve();
async function writeAll() {
  if (pool) await pool.query('insert into state(id,data) values(1,$1) on conflict(id) do update set data=$1', [S]);
  else fs.writeFileSync(FILE, JSON.stringify(S));
}
const persist = () => (q = q.then(writeAll).catch(e => console.error('save error', e)));
const tokens = new Map();
const syncTokens = () => { S.sessions = [...tokens].map(([t, v]) => ({ t, ...v })); return persist(); };

async function init() {
  if (pool) {
    await pool.query('create table if not exists state(id int primary key, data jsonb)');
    S = (await pool.query('select data from state where id=1')).rows[0]?.data;
  } else { try { S = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {} }
  if (!S) { S = seed(); await persist(); console.log('Создан владелец: логин owner, пароль из OWNER_PASSWORD (по умолчанию 000). Смените пароль после входа!'); }
  if (S.cars) { // миграция: машина теперь привязана к гиду текстом
    S.users.forEach(u => { if (u.car === undefined) u.car = (S.cars.find(c => c.id === u.carId) || {}).name || ''; delete u.carId; });
    delete S.cars; S.bookings = S.bookings.filter(b => b.targetLogin); await persist();
  }
  (S.sessions || []).forEach(x => tokens.set(x.t, { login: x.login, at: x.at }));
  if (!S.settings) { S.settings = { ...DEF }; await persist(); } // миграция: настройки появились позже остальных данных
  console.log(pool ? 'Хранилище: PostgreSQL' : 'Хранилище: файл data.json (на бесплатном Render может сбрасываться!)');
}

// ---- Авторизация и лимиты ----
const hits = new Map();
const limited = (key, max, ms) => { const n = Date.now(), a = (hits.get(key) || []).filter(x => n - x < ms); a.push(n); hits.set(key, a); return a.length > max; };
const auth = req => {
  const k = req.get('x-token'), t = tokens.get(k); if (!t) return null;
  if (Date.now() - t.at > 6048e5) { tokens.delete(k); return null; }
  const u = S.users.find(x => x.login === t.login); if (!u) return null;
  t.at = Date.now(); return u;
};
const live = () => [...tokens.values()].filter(t => Date.now() - t.at < 9e5);

// ---- Помощники ----
// Коды ошибок: клиент переводит их на выбранный язык, текст остаётся русским как запасной.
const ECODE = {
  'Неверная дата или время': 'bad_date', 'Длительность: от 1 до 24 часов': 'hours',
  'Укажите имя и номер телефона (минимум 9 цифр)': 'client', 'Нельзя бронировать в прошлом': 'past',
  'Слишком много броней': 'many_bookings', 'Гид не найден': 'no_guide',
  'Это время уже занято — выберите другое': 'busy',
  'Слишком много попыток, подождите 10 минут': 'rate_login', 'Слишком много запросов': 'rate_book',
  'Неверный пароль!': 'wrong_pass', 'Недостаточно прав': 'forbid', 'Войдите в систему': 'no_auth',
  'Пустое сообщение': 'empty_msg', 'Бронь не найдена': 'no_booking', 'Неизвестное действие': 'unknown_op',
  'Введите имя гида': 'name_guide', 'Имя не может быть пустым': 'name_empty',
  'Пароль — минимум 4 символа': 'pass_min', 'Ошибка сервера': 'server',
  'Это время вне рабочих часов': 'closed_hours', 'Этот логин уже занят': 'login_busy'
};
const bad = (res, error, code) => res.status(400).json({ error, code: code || ECODE[error] || 'server' });
const forbid = res => res.status(403).json({ error: 'Недостаточно прав', code: 'forbid' });
const str = (s, n) => String(s ?? '').trim().slice(0, n);
const span = (d, t, h) => { const s = new Date(`${d}T${t}:00+05:00`).getTime(); return { s, e: s + h * 36e5 }; };
const hit = (b, sp) => { const x = span(b.date, b.time, +b.hours); return x.s < sp.e && sp.s < x.e; };
const guides = () => S.users.filter(u => u.role === 'guide');
const busyGuide = (g, sp) => S.bookings.some(b => b.targetLogin === g.login && hit(b, sp));
const pub = u => ({ login: u.login, role: u.role, name: u.name, langs: u.langs, price: u.price, car: u.car || '' });
const isStaff = u => u.role === 'owner' || u.role === 'admin';
const canManage = (m, u) => m.role === 'owner' || u.login === m.login || (m.role === 'admin' && u.role === 'guide');
const canDelete = (m, u) => u.role !== 'owner' && u.login !== m.login && (m.role === 'owner' || (m.role === 'admin' && u.role === 'guide'));

// ---- API ----
// Кого видит текущий: гость и гид — только гидов и себя; админ — всех, кроме владельца; владелец — всех.
const visible = m => m ? S.users.filter(u => u.role === 'guide' || u.login === m.login ||
    (m.role !== 'guide' && !(m.role === 'admin' && u.role === 'owner'))) : guides();
app.get('/api/data', (req, res) => {
  const m = auth(req);
  const users = visible(m)
    .map(u => ({ ...pub(u), pass: m && canSeePw(m, u) ? (u.pw ? dec(u.pw) : null) : undefined }));
  const bookings = !m ? [] : m.role === 'guide' ? S.bookings.filter(b => b.targetLogin === m.login) : S.bookings;
  const online = m && m.role !== 'guide'
    ? [...new Set(live().map(t => t.login))].map(l => { const u = S.users.find(x => x.login === l); return u && { login: l, name: u.name }; }).filter(Boolean) : [];
  res.json({
    me: m && pub(m), users, bookings, online, db: !!pool,
    settings: S.settings,
    profiles: S.users.map(u => ({ login: u.login, name: u.name, role: u.role })),
    slots: S.bookings.map(b => ({ date: b.date, time: b.time, hours: b.hours, targetLogin: b.targetLogin })),
    chat: m ? S.chat : []
  });
});

app.post('/api/login', async (req, res) => {
  if (limited('l' + req.ip, 10, 6e5)) return res.status(429).json({ error: 'Слишком много попыток, подождите 10 минут', code: 'rate_login' });
  const u = S.users.find(x => x.login === req.body?.login);
  if (!u || !checkPw(String(req.body.pass ?? ''), u.hash)) return res.status(401).json({ error: 'Неверный пароль!', code: 'wrong_pass' });
  for (const [k, v] of tokens) if (Date.now() - v.at > 6048e5) tokens.delete(k);
  const t = crypto.randomBytes(24).toString('hex');
  tokens.set(t, { login: u.login, at: Date.now() });
  await syncTokens(); res.json({ token: t });
});
app.post('/api/logout', async (req, res) => { tokens.delete(req.get('x-token')); await syncTokens(); res.json({ ok: 1 }); });

// Бронь доступна всем (гостям и персоналу)
app.post('/api/book', async (req, res) => {
  if (limited('b' + req.ip, 30, 36e5)) return res.status(429).json({ error: 'Слишком много запросов', code: 'rate_book' });
  const b = req.body || {}, client = str(b.client, 80), hours = parseInt(b.hours), date = str(b.date, 10), time = str(b.time, 5);
  const st = S.settings;
  if (!/^\d{4}-\d\d-\d\d$/.test(date) || !/^\d\d:\d\d$/.test(time)) return bad(res, 'Неверная дата или время');
  if (!(hours >= st.minHours && hours <= st.maxHours)) return bad(res, `Длительность: от ${st.minHours} до ${st.maxHours} часов`, 'hours');
  if (client.replace(/\D/g, '').length < 9) return bad(res, 'Укажите имя и номер телефона (минимум 9 цифр)');
  const sp = span(date, time, hours);
  if (isNaN(sp.s)) return bad(res, 'Неверная дата или время');
  if (sp.s < Date.now()) return bad(res, 'Нельзя бронировать в прошлом');
  if (sp.s > horizon(st)) return bad(res, `Бронирование доступно не более чем за ${st.daysAhead} дней вперёд`, 'too_far');
  if (workHours(st) && (mins(time) < mins(st.dayStart) || mins(time) + hours * 60 > mins(st.dayEnd)))
    return bad(res, 'Это время вне рабочих часов', 'closed_hours');
  if (S.bookings.length > 5000) return bad(res, 'Слишком много броней');
  const g = guides().find(x => x.login === b.target);
  if (!g) return bad(res, 'Гид не найден');
  if (busyGuide(g, sp)) return bad(res, 'Это время уже занято — выберите другое');
  S.bookings.push({ id: Date.now() * 1000 + crypto.randomInt(1000), targetLogin: g.login, client, date, time, hours });
  await persist(); res.json({ ok: 1 });
});

// Действия для вошедших
app.post('/api/act', async (req, res) => {
  const m = auth(req);
  if (!m) return res.status(401).json({ error: 'Войдите в систему', code: 'no_auth' });
  const b = req.body || {}, st = isStaff(m);
  try {
    switch (b.op) {
      case 'removeBooking': {
        const x = S.bookings.find(k => k.id === b.id);
        if (!x || (m.role === 'guide' && x.targetLogin !== m.login)) return bad(res, 'Бронь не найдена');
        S.bookings = S.bookings.filter(k => k !== x); break;
      }
      case 'chat': {
        const text = str(b.text, 500); if (!text) return bad(res, 'Пустое сообщение');
        S.chat.push({ author: m.name, text }); S.chat = S.chat.slice(-100); break;
      }
      case 'addGuide': case 'addUser': { // создание сотрудника: админ может только гида, владелец — кого угодно
        if (!st) return forbid(res);
        const role = b.op === 'addGuide' ? 'guide' : (b.role === 'admin' ? 'admin' : 'guide');
        if (role === 'admin' && m.role !== 'owner') return forbid(res);
        const name = str(b.name, 60); if (!name) return bad(res, 'Введите имя гида');
        const pass = role === 'admin' && String(b.pass || '').trim() ? String(b.pass).trim() : crypto.randomBytes(4).toString('hex');
        if (pass.length < 4) return bad(res, 'Пароль — минимум 4 символа');
        let login = role === 'admin'
          ? 'adm_' + (str(b.login, 20).toLowerCase().replace(/[^a-z0-9_]/g, '') || Date.now().toString(36))
          : 'guide_' + Date.now().toString(36) + crypto.randomInt(10, 99);
        if (S.users.some(x => x.login === login)) return bad(res, 'Этот логин уже занят');
        const u = { login, ...mk(pass), role, name, langs: role === 'guide' ? (str(b.langs, 100) || 'Русский') : '',
          price: role === 'guide' ? Math.max(0, parseInt(b.price) || 30) : 0, car: role === 'guide' ? str(b.car, 80) : '' };
        S.users.push(u);
        await persist(); return res.json({ ok: 1, pass, login, role });
      }
      case 'saveSettings': {
        if (m.role !== 'owner') return forbid(res);
        S.settings = cleanSettings(b.settings || b);
        await persist(); break;
      }
      case 'editUser': {
        const u = S.users.find(x => x.login === b.login);
        if (!u || !st || !canManage(m, u)) return forbid(res);
        const name = str(b.name, 60), pass = String(b.pass ?? '').trim();
        if (!name) return bad(res, 'Имя не может быть пустым');
        if (pass && pass.length < 4) return bad(res, 'Пароль — минимум 4 символа');
        u.name = name; if (pass) Object.assign(u, mk(pass));
        if (u.role === 'guide') { u.langs = str(b.langs, 100); u.price = Math.max(0, parseInt(b.price) || 0); u.car = str(b.car, 80); }
        if (pass) { for (const [t, v] of tokens) if (v.login === u.login && u !== m) tokens.delete(t); await syncTokens(); }
        break;
      }
      case 'deleteUser': {
        const u = S.users.find(x => x.login === b.login);
        if (!u || !st || !canDelete(m, u)) return forbid(res);
        S.users = S.users.filter(x => x !== u);
        S.bookings = S.bookings.filter(k => k.targetLogin !== u.login);
        for (const [t, v] of tokens) if (v.login === u.login) tokens.delete(t);
        await syncTokens(); break;
      }
      default: return bad(res, 'Неизвестное действие');
    }
    await persist(); res.json({ ok: 1 });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка сервера', code: 'server' }); }
});

// Отдаём только страницу сайта (код сервера и данные снаружи недоступны)
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

init().then(() => app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`)))
  .catch(e => { console.error(e); process.exit(1); });
