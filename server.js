const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;

// Раздаём все статические файлы из текущей директории
app.use(express.static(__dirname));

// При заходе на главную страницу отдаём index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
