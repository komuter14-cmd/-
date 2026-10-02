const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Настройки сайта
let siteSettings = {
  bookingPhone: '+998 906556550'
};

// Список гидов с фото авто
let guidesData = [
  { id: 1, city: 'Ташкент', name: 'Шерзод', phone: '+998 90 123 45 67', lang: 'Русский, Узбекский', car: 'Chevrolet Cobalt', carImg: 'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?w=400', price: 80, busyDates: ['2026-10-05'] },
  { id: 2, city: 'Ташкент', name: 'Алишер', phone: '+998 90 987 65 43', lang: 'Русский, English', car: 'BYD Song Plus', carImg: 'https://images.unsplash.com/photo-1563720223185-11003d516935?w=400', price: 120, busyDates: [] },
  { id: 3, city: 'Самарканд', name: 'Тимур', phone: '+998 93 111 22 33', lang: 'Русский, English, Узбекский', car: 'Chevrolet Malibu', carImg: 'https://images.unsplash.com/photo-1552519507-da3b142c6e3d?w=400', price: 100, busyDates: ['2026-10-02'] },
  { id: 4, city: 'Бухара', name: 'Анвар', phone: '+998 97 777 88 99', lang: 'Русский, Узбекский', car: 'Chevrolet Gentra', carImg: 'https://images.unsplash.com/photo-1541899481282-d53bffe3c35d?w=400', price: 70, busyDates: [] },
  { id: 5, city: 'Хива', name: 'Захир', phone: '+998 99 000 11 22', lang: 'Русский, English', car: 'Пеший', carImg: 'https://images.unsplash.com/photo-1517649763962-0c6232661a0b?w=400', price: 50, busyDates: [] }
];

app.get('/api/site-data', (req, res) => {
  res.json({ success: true, settings: siteSettings, guides: guidesData });
});

// Авторизация
app.post('/api/auth/login', (req, res) => {
  const { login, password, role } = req.body;

  if (role === 'founder') {
    if (login === 'osn' && password === '12331') {
      return res.json({ success: true, role: 'founder', name: 'Основатель' });
    }
    return res.status(401).json({ error: 'Неверный логин или пароль Основателя!' });
  }

  if (role === 'admin') {
    if (login === 'admin' && password === '41433') {
      return res.json({ success: true, role: 'admin', name: 'Администратор' });
    }
    return res.status(401).json({ error: 'Неверный логин или пароль Администратора!' });
  }

  res.status(400).json({ error: 'Неверная роль' });
});

// Изменение главного номера (Только Основатель)
app.post('/api/admin/update-phone', (req, res) => {
  const { role, phone } = req.body;
  if (role !== 'founder') {
    return res.status(403).json({ error: 'Только Основатель может изменять номер!' });
  }
  siteSettings.bookingPhone = phone;
  res.json({ success: true, message: 'Номер обновлён!' });
});

// Редактирование гида
app.post('/api/admin/update-guide', (req, res) => {
  const { id, name, phone, city, lang, car, carImg, price } = req.body;
  const guide = guidesData.find(g => g.id === id);
  if (guide) {
    guide.name = name;
    guide.phone = phone;
    guide.city = city;
    guide.lang = lang;
    guide.car = car;
    guide.carImg = carImg;
    guide.price = price;
    return res.json({ success: true });
  }
  res.status(404).json({ error: 'Гид не найден' });
});

// Добавление гида
app.post('/api/admin/add-guide', (req, res) => {
  const { name, phone, city, lang, car, carImg, price } = req.body;
  const newGuide = { 
    id: Date.now(), 
    city, 
    name, 
    phone, 
    lang: lang || 'Русский', 
    car: car || 'Chevrolet Cobalt',
    carImg: carImg || '',
    price: price || 80, 
    busyDates: [] 
  };
  guidesData.push(newGuide);
  res.json({ success: true, guide: newGuide });
});

// Удаление гида
app.post('/api/admin/delete-guide', (req, res) => {
  const { id } = req.body;
  guidesData = guidesData.filter(g => g.id !== id);
  res.json({ success: true });
});

app.listen(3000, () => {
  console.log('--- Сервер запущен на http://localhost:3000 ---');
});