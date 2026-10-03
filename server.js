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

const seed = () => ({
  users: [
    { login: 'owner', hash: hashPw(process.env.OWNER_PASSWORD || '000'), role: 'owner', name: 'Основатель', langs: 'Все', price: 0, carId: null },
    { login: 'guide_timur', hash: hashPw(rnd()), role: 'guide', name: 'Тимур (Ташкент)', langs: 'Русский, Узбекский, Английский', price: 50, carId: 1 },
    { login: 'guide_sardor', hash: hashPw(rnd()), role: 'guide', name: 'Сардор (Самарканд)', langs: 'Русский, Узбекский', price: 40, carId: 2 }
  ],
  cars: [
    { id: 1, name: 'Chevrolet Malibu 2 (01 A 123 AB)', price: 70 },
    { id: 2, name: 'Chevrolet Tracker (01 B 456 CD)', price: 50 },
    { id: 3, name: 'Chevrolet Tahoe (01 Z 777 ZZ)', price: 120 }
  ],
  bookings: [],
  chat: [{ author: 'Основатель', text: 'Чат персонала активен. Добро пожаловать!' }]
});

let S, q = Promise.resolve();
async function writeAll() {
  if (pool) await pool.query('insert into state(id,data) values(1,$1) on conflict(id) do update set data=$1', [S]);
  else fs.writeFileSync(FILE, JSON.stringify(S));
}
const persist = () => (q = q.then(writeAll).catch(e => console.error('save error', e)));
async function init() {
  if (pool) {
    await pool.query('create table if not exists state(id int primary key, data jsonb)');
    S = (await pool.query('select data from state where id=1')).rows[0]?.data;
  } else { try { S = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {} }
  if (!S) {
    S = seed(); await persist();
    console.log('Создан владелец: логин owner, пароль из OWNER_PASSWORD (по умолчанию 000). СМЕНИТЕ ПАРОЛЬ после входа!');
  }
  console.log(pool ? 'Хранилище: PostgreSQL' : 'Хранилище: файл data.json (на бесплатном Render может сбрасываться!)');
}

// ---- Авторизация и лимиты ----
const tokens = new Map(), hits = new Map();
const limited = (key, max, ms) => { const n = Date.now(), a = (hits.get(key) || []).filter(x => n - x < ms); a.push(n); hits.set(key, a); return a.length > max; };
const auth = req => {
  const t = tokens.get(req.get('x-token')); if (!t) return null;
  if (Date.now() - t.at > 432e5) { tokens.delete(req.get('x-token')); return null; }
  const u = S.users.find(x => x.login === t.login); if (!u) return null;
  t.at = Date.now(); return u;
};
const live = () => [...tokens.values()].filter(t => Date.now() - t.at < 9e5);

// ---- Помощники ----
const bad = (res, error) => res.status(400).json({ error });
const forbid = res => res.status(403).json({ error: 'Недостаточно прав' });
const str = (s, n) => String(s ?? '').trim().slice(0, n);
const span = (d, t, h) => { const s = new Date(`${d}T${t}:00+05:00`).getTime(); return { s, e: s + h * 36e5 }; };
const hit = (b, sp) => { const x = span(b.date, b.time, +b.hours); return x.s < sp.e && sp.s < x.e; };
const guides = () => S.users.filter(u => u.role === 'guide');
const busyCar = (id, sp) => S.bookings.some(b => b.targetCarId === id && hit(b, sp)) ||
  guides().some(g => g.carId === id && S.bookings.some(b => b.targetLogin === g.login && hit(b, sp)));
const busyGuide = (g, sp) => S.bookings.some(b => b.targetLogin === g.login && hit(b, sp)) ||
  (g.carId != null && S.bookings.some(b => b.targetCarId === g.carId && hit(b, sp)));
const pub = u => ({ login: u.login, role: u.role, name: u.name, langs: u.langs, price: u.price, carId: u.carId });
const isStaff = u => u.role === 'owner' || u.role === 'admin';
const canManage = (m, u) => m.role === 'owner' || u.login === m.login || (m.role === 'admin' && u.role === 'guide');
const canDelete = (m, u) => u.role !== 'owner' && u.login !== m.login && (m.role === 'owner' || (m.role === 'admin' && u.role === 'guide'));

// ---- API ----
app.get('/api/data', (req, res) => {
  const m = auth(req);
  const users = (m ? S.users.filter(u => !(m.role === 'admin' && u.role === 'owner')) : guides()).map(pub);
  const bookings = !m ? [] : m.role === 'guide' ? S.bookings.filter(b => b.targetLogin === m.login) : S.bookings;
  const online = m && m.role !== 'guide'
    ? [...new Set(live().map(t => t.login))].map(l => { const u = S.users.find(x => x.login === l); return u && { login: l, name: u.name }; }).filter(Boolean) : [];
  res.json({
    me: m && pub(m), users, cars: S.cars, bookings, online,
    profiles: S.users.map(u => ({ login: u.login, name: u.name, role: u.role })),
    slots: S.bookings.map(b => ({ date: b.date, time: b.time, hours: b.hours, targetLogin: b.targetLogin, targetCarId: b.targetCarId })),
    chat: m ? S.chat : []
  });
});

app.post('/api/login', (req, res) => {
  if (limited('l' + req.ip, 10, 6e5)) return res.status(429).json({ error: 'Слишком много попыток, подождите 10 минут' });
  const u = S.users.find(x => x.login === req.body?.login);
  if (!u || !checkPw(String(req.body.pass ?? ''), u.hash)) return res.status(401).json({ error: 'Неверный пароль!' });
  const t = crypto.randomBytes(24).toString('hex');
  tokens.set(t, { login: u.login, at: Date.now() });
  res.json({ token: t });
});

app.post('/api/logout', (req, res) => { tokens.delete(req.get('x-token')); res.json({ ok: 1 }); });

// Бронь доступна всем (гостям и персоналу)
app.post('/api/book', async (req, res) => {
  if (limited('b' + req.ip, 30, 36e5)) return res.status(429).json({ error: 'Слишком много запросов' });
  const b = req.body || {}, client = str(b.client, 80), hours = parseInt(b.hours), date = str(b.date, 10), time = str(b.time, 5);
  if (!/^\d{4}-\d\d-\d\d$/.test(date) || !/^\d\d:\d\d$/.test(time)) return bad(res, 'Неверная дата или время');
  if (!(hours >= 1 && hours <= 24)) return bad(res, 'Длительность: от 1 до 24 часов');
  if (client.replace(/\D/g, '').length < 9) return bad(res, 'Укажите имя и номер телефона (минимум 9 цифр)');
  const sp = span(date, time, hours);
  if (isNaN(sp.s)) return bad(res, 'Неверная дата или время');
  if (sp.s < Date.now()) return bad(res, 'Нельзя бронировать в прошлом');
  if (S.bookings.length > 5000) return bad(res, 'Слишком много броней');
  let rec;
  if (b.type === 'guide') {
    const g = guides().find(x => x.login === b.target);
    if (!g) return bad(res, 'Гид не найден');
    if (busyGuide(g, sp)) return bad(res, 'Это время уже занято — выберите другое');
    rec = { targetLogin: g.login, targetCarId: null };
  } else if (b.type === 'car') {
    const c = S.cars.find(x => x.id === +b.target);
    if (!c) return bad(res, 'Автомобиль не найден');
    if (busyCar(c.id, sp)) return bad(res, 'Это время уже занято — выберите другое');
    rec = { targetLogin: null, targetCarId: c.id };
  } else return bad(res, 'Неверный тип услуги');
  S.bookings.push({ id: Date.now() * 1000 + crypto.randomInt(1000), type: b.type, ...rec, client, date, time, hours });
  await persist(); res.json({ ok: 1 });
});

// Действия для вошедших
app.post('/api/act', async (req, res) => {
  const m = auth(req);
  if (!m) return res.status(401).json({ error: 'Войдите в систему' });
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
      case 'addGuide': {
        if (!st) return forbid(res);
        const name = str(b.name, 60); if (!name) return bad(res, 'Введите имя гида');
        const login = 'guide_' + Date.now().toString(36) + crypto.randomInt(10, 99), pass = crypto.randomBytes(4).toString('hex');
        S.users.push({ login, hash: hashPw(pass), role: 'guide', name, langs: str(b.langs, 100) || 'Русский',
          price: Math.max(0, parseInt(b.price) || 30), carId: null });
        await persist(); return res.json({ ok: 1, pass });
      }
      case 'addCar': {
        if (!st) return forbid(res);
        const name = str(b.name, 80); if (!name) return bad(res, 'Введите название автомобиля');
        S.cars.push({ id: Date.now(), name, price: Math.max(0, parseInt(b.price) || 40) }); break;
      }
      case 'deleteCar': {
        if (!st) return forbid(res);
        S.cars = S.cars.filter(c => c.id !== +b.id);
        S.users.forEach(u => { if (u.carId === +b.id) u.carId = null; });
        S.bookings = S.bookings.filter(k => k.targetCarId !== +b.id); break;
      }
      case 'editUser': {
        const u = S.users.find(x => x.login === b.login);
        if (!u || !st || !canManage(m, u)) return forbid(res);
        const name = str(b.name, 60), pass = String(b.pass ?? '').trim();
        if (!name) return bad(res, 'Имя не может быть пустым');
        if (pass && pass.length < 4) return bad(res, 'Пароль — минимум 4 символа');
        u.name = name; if (pass) u.hash = hashPw(pass);
        u.langs = str(b.langs, 100); u.price = Math.max(0, parseInt(b.price) || 0);
        u.carId = b.carId && S.cars.some(c => c.id === +b.carId) ? +b.carId : null;
        if (pass) for (const [t, v] of tokens) if (v.login === u.login && u !== m) tokens.delete(t);
        break;
      }
      case 'deleteUser': {
        const u = S.users.find(x => x.login === b.login);
        if (!u || !st || !canDelete(m, u)) return forbid(res);
        S.users = S.users.filter(x => x !== u);
        S.bookings = S.bookings.filter(k => k.targetLogin !== u.login);
        for (const [t, v] of tokens) if (v.login === u.login) tokens.delete(t);
        break;
      }
      default: return bad(res, 'Неизвестное действие');
    }
    await persist(); res.json({ ok: 1 });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// Отдаём только страницу сайта (код сервера и данные снаружи недоступны)
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

init().then(() => app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`)))
  .catch(e => { console.error(e); process.exit(1); });
