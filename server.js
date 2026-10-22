const express = require('express'), Database = require('better-sqlite3'), bcrypt = require('bcryptjs'), crypto = require('crypto');
const CAP = +process.env.DAILY_CAP || 80, MAXL = 5, COOL = 180000; // лимит XP в день, уровней в задании, кулдаун после провала (мс)
const db = new Database(process.env.DB || 'eco.db');
db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,login TEXT UNIQUE COLLATE NOCASE,hash TEXT,xp INT DEFAULT 0,streak INT DEFAULT 0,best INT DEFAULT 0,last TEXT,perfect INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS sess(sid TEXT PRIMARY KEY,uid INT);
CREATE TABLE IF NOT EXISTS prog(uid INT,les TEXT,lv INT DEFAULT 0,PRIMARY KEY(uid,les));
CREATE TABLE IF NOT EXISTS daily(uid INT,day TEXT,xp INT DEFAULT 0,PRIMARY KEY(uid,day));
CREATE TABLE IF NOT EXISTS ach(uid INT,k TEXT,at TEXT,PRIMARY KEY(uid,k));`);

// ---------- КОНТЕНТ: добавляй задания здесь ----------
const C = (q, o, a, e) => ({ k: 'c', q, o, a, e });            // выбор ответа (тест, правда/ложь, лишнее, сценарий)
const S = (q, bins, items) => ({ k: 's', q, bins, items });    // сортировка: items=[[текст,номер_контейнера]]
const M = (q, pairs) => ({ k: 'm', q, pairs });                // соедини пары
const K = (q, limit, g) => ({ k: 'k', q, limit, g });          // калькулятор: g=[[название,[[вариант,кг CO2]]]]
const TF = ['Правда', 'Ложь'];
const LES = {};
[
  ['m1', 'm', 'Что такое экология', [
    C('Экология — это наука о…', ['взаимосвязях живых организмов и среды', 'только о загрязнении', 'только о животных', 'космосе'], 0),
    C('Правда или ложь: без естественного парникового эффекта Земля была бы очень холодной.', TF, 0),
    C('Найди лишнее: что НЕ возобновляемый ресурс?', ['Ветер', 'Солнце', 'Нефть', 'Вода рек'], 2),
    M('Соедини организм и его роль', [['Растения', 'Производят кислород'], ['Грибы', 'Разлагают остатки'], ['Пчёлы', 'Опыляют цветы']])]],
  ['m2', 'm', 'Мусор и переработка', [
    S('Разложи мусор по контейнерам', ['Пластик', 'Стекло', 'Бумага', 'Органика'], [['Бутылка ПЭТ', 0], ['Банка из-под варенья', 1], ['Газета', 2], ['Кожура банана', 3]]),
    M('Срок разложения', [['Бумага', '2–5 месяцев'], ['Пластиковая бутылка', '≈450 лет'], ['Стеклянная бутылка', '1000+ лет'], ['Кожура банана', '2–4 недели']]),
    C('Найди лишнее: что НЕЛЬЗЯ сдать в макулатуру?', ['Картонная коробка', 'Газета', 'Использованная салфетка', 'Тетрадь'], 2),
    C('Правда или ложь: батарейки можно выбрасывать в обычный бак.', TF, 1)]],
  ['m3', 'm', 'Климат и энергия', [
    C('Какой газ сильнее всего усиливает парниковый эффект из-за деятельности человека?', ['Углекислый газ (CO₂)', 'Гелий', 'Азот', 'Аргон'], 0),
    C('Правда или ложь: леса поглощают углекислый газ.', TF, 0),
    M('Источник энергии', [['Солнечная панель', 'Свет'], ['Ветряк', 'Воздушные потоки'], ['Плотина ГЭС', 'Падающая вода']]),
    C('Правда или ложь: от сжигания угля в атмосферу не попадает CO₂.', TF, 1)]],
  ['m4', 'm', 'Эко-привычки', [
    K('Калькулятор следа: уложись в 5 кг CO₂ за день', 5, [['Дорога в школу', [['Пешком', 0], ['Автобус', 1], ['Машина', 3]]], ['Обед', [['Овощной', 1], ['Мясной', 3.5], ['Фастфуд', 4]]], ['Вечером', [['Свет выключаю', 0.5], ['Всё включено', 2]]]]),
    C('Сценарий: в столовой ты не доел булочку. Что сделаешь?', ['Выброшу', 'Съем позже или отдам другу', 'Оставлю на парте'], 1, ['Станет пищевым отходом', 'Меньше отходов!', 'Мусор и лишняя работа для уборщиков']),
    C('Что лучше для планеты?', ['Разовая бутылка', 'Многоразовая бутылка', 'Пакет на каждую покупку'], 1),
    C('Правда или ложь: пластиковый пакет быстро разлагается.', TF, 1)]],
  ['w1', 'w', 'Береги воду', [
    C('Сколько пресной воды от всей воды на Земле?', ['≈3%', '≈30%', '≈60%', '≈90%'], 0),
    C('Что экономнее?', ['Душ 5 минут', 'Полная ванна'], 0),
    S('Что можно слить в канализацию?', ['Можно', 'Нельзя'], [['Мыльная вода', 0], ['Старое масло', 1], ['Лекарства', 1], ['Вода после мытья овощей', 0]]),
    C('Правда или ложь: капающий кран за сутки теряет десятки литров.', TF, 0)]],
  ['t1', 't', 'Ноль отходов', [
    C('Правило 5R начинается с…', ['Отказаться (Refuse)', 'Сжечь', 'Закопать', 'Купить'], 0),
    S('Что куда?', ['Компост', 'Переработка'], [['Кофейная гуща', 0], ['Алюминиевая банка', 1], ['Яичная скорлупа', 0], ['Картонная упаковка', 1]]),
    C('Найди лишнее: что НЕ многоразовое?', ['Тканевая сумка', 'Стеклянная банка', 'Одноразовая соломинка', 'Контейнер для еды'], 2),
    C('Правда или ложь: сортировка мусора уменьшает объём свалок.', TF, 0)]],
  ['e1', 'e', 'Экономь энергию', [
    C('Какая лампа экономичнее?', ['Накаливания', 'Светодиодная (LED)'], 1),
    C('Приборы в режиме ожидания (standby)…', ['потребляют энергию', 'не потребляют ничего'], 0),
    C('Сценарий: в комнате жарко. Что экологичнее?', ['Проветрить и задвинуть шторы', 'Кондиционер на максимум', 'Открыть холодильник'], 0, ['Мало энергии, хороший эффект', 'Много электричества', 'Холодильник тратит ещё больше']),
    C('Правда или ложь: зарядка в розетке без телефона ничего не потребляет.', TF, 1)]],
  ['b1', 'b', 'Живая природа', [
    C('Биоразнообразие — это…', ['разнообразие жизни на Земле', 'число городов', 'виды транспорта', 'только лес'], 0),
    C('Какое животное занесено в Красную книгу?', ['Снежный барс', 'Домашняя кошка', 'Голубь', 'Крыса'], 0),
    M('Животное и среда', [['Снежный барс', 'Горы'], ['Верблюд', 'Пустыня'], ['Окунь', 'Река']]),
    C('Правда или ложь: исчезновение пчёл угрожает урожаям.', TF, 0)]],
].forEach(([id, b, t, p]) => LES[id] = { id, b, t, p });
const MAIN = ['m1', 'm2', 'm3', 'm4'];
const open = (l, L) => l.b == 'm' ? (MAIN.indexOf(l.id) == 0 || L[MAIN[MAIN.indexOf(l.id) - 1]] >= 1) : L.m1 >= 1;

// ---------- ДОСТИЖЕНИЯ ----------
const ACH = [['first', '🌱', 'Первый росток', 'Пройди первый уровень', s => s.done >= 1]];
[[100, '💧', 'Капля знаний'], [500, '🌊', 'Река знаний'], [1000, '🌍', 'Океан знаний']].forEach(([n, e, t]) => ACH.push(['xp' + n, e, t, `Набери ${n} XP`, s => s.xp >= n]));
[[3, '✨'], [7, '🔥'], [14, '⚡'], [30, '☀️']].forEach(([n, e]) => ACH.push(['st' + n, e, `Серия ${n} дней`, `Занимайся ${n} дней подряд`, s => s.best >= n]));
ACH.push(['perf', '💎', 'Безупречный', '25 уровней без единой ошибки', s => s.perfect >= 25]);
Object.values(LES).forEach(l => ACH.push(['mas_' + l.id, '⭐', 'Мастер: ' + l.t, 'Пройди все 5 уровней задания', s => s.lv[l.id] >= MAXL]));
ACH.push(['hero', '🏆', 'Эко-герой', 'Пройди все 5 уровней всей основной ветки', s => MAIN.every(i => s.lv[i] >= MAXL)]);
ACH.push(['legend', '👑', 'Легенда планеты', 'Все уровни всех веток + серия 30 дней + 1000 XP', s => s.done >= Object.keys(LES).length * MAXL && s.best >= 30 && s.xp >= 1000]);
const apub = a => ({ k: a[0], e: a[1], t: a[2], d: a[3] });

// ---------- ВСПОМОГАТЕЛЬНОЕ ----------
const shuf = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1);[a[i], a[j]] = [a[j], a[i]]; } return a; };
const day = (off = 0) => new Date(Date.now() - off * 864e5).toISOString().slice(0, 10);
const todayXp = uid => (db.prepare('SELECT xp FROM daily WHERE uid=? AND day=?').get(uid, day()) || { xp: 0 }).xp;
const levels = uid => { const o = {}; for (const k in LES) o[k] = 0; for (const r of db.prepare('SELECT les,lv FROM prog WHERE uid=?').all(uid)) o[r.les] = r.lv; return o; };
const stats = uid => { const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid), lv = levels(uid); return { ...u, lv, done: Object.values(lv).reduce((a, b) => a + b, 0) }; };
function checkAch(uid) {
  const s = stats(uid), have = new Set(db.prepare('SELECT k FROM ach WHERE uid=?').all(uid).map(r => r.k)), n = [];
  for (const a of ACH) if (!have.has(a[0]) && a[4](s)) { db.prepare('INSERT INTO ach VALUES(?,?,?)').run(uid, a[0], day()); n.push(apub(a)); }
  return n;
}
// Готовим вопрос: на клиент уходит БЕЗ ответов, проверка только на сервере, порядок каждый раз случайный
function prep(q) {
  if (q.k == 'c') { const ix = shuf(q.o.map((_, i) => i)); return { pub: { k: 'c', q: q.q, o: ix.map(i => q.o[i]) }, chk: a => ({ ok: ix[a] === q.a, e: q.e && ix[a] !== undefined ? q.e[ix[a]] : undefined }) }; }
  if (q.k == 's') { const it = shuf(q.items); return { slow: 1, pub: { k: 's', q: q.q, bins: q.bins, items: it.map(x => x[0]) }, chk: a => ({ ok: Array.isArray(a) && it.every((x, i) => a[i] === x[1]) }) }; }
  if (q.k == 'm') { const l = shuf(q.pairs), r = shuf(q.pairs.map(p => p[1])); return { slow: 1, pub: { k: 'm', q: q.q, l: l.map(p => p[0]), r }, chk: a => ({ ok: Array.isArray(a) && l.every((p, i) => r[a[i]] === p[1]) }) }; }
  return { slow: 1, pub: { k: 'k', q: q.q, limit: q.limit, g: q.g }, chk: a => ({ ok: Array.isArray(a) && a.length == q.g.length && q.g.reduce((s, g, i) => s + (g[1][a[i]] ? g[1][a[i]][1] : 99), 0) <= q.limit }) };
}
const runs = new Map(), cool = new Map();
const cur = (r, d = 0) => { const q = r.qs[r.i]; r.lim = Math.max(12, 45 - 6 * r.lvl) * (q.slow ? 2 : 1); r.qt = Date.now() + d; return { i: r.i, q: q.pub, lim: r.lim }; };

// ---------- СЕРВЕР ----------
const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));
const mk = (res, uid) => { const sid = crypto.randomBytes(24).toString('hex'); db.prepare('INSERT INTO sess VALUES(?,?)').run(sid, uid); res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`); };
const sidOf = req => ((req.headers.cookie || '').split('; ').find(c => c.startsWith('sid=')) || '').slice(4);
const auth = (req, res, next) => { req.u = db.prepare('SELECT u.* FROM users u JOIN sess s ON s.uid=u.id WHERE s.sid=?').get(sidOf(req)); req.u ? next() : res.status(401).json({ err: 'Войди в аккаунт' }); };

app.post('/api/register', (req, res) => {
  const login = String(req.body.login || ''), pw = String(req.body.password || '');
  if (!/^[\p{L}\d_]{3,20}$/u.test(login) || pw.length < 6) return res.status(400).json({ err: 'Логин: 3–20 символов (буквы, цифры, _). Пароль: от 6 символов' });
  try { const id = db.prepare('INSERT INTO users(login,hash) VALUES(?,?)').run(login, bcrypt.hashSync(pw, 10)).lastInsertRowid; mk(res, id); res.json({ ok: 1 }); }
  catch { res.status(400).json({ err: 'Такой логин уже занят' }); }
});
app.post('/api/login', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE login=?').get(String(req.body.login || ''));
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.hash)) return res.status(401).json({ err: 'Неверный логин или пароль' });
  mk(res, u.id); res.json({ ok: 1 });
});
app.post('/api/logout', (req, res) => { db.prepare('DELETE FROM sess WHERE sid=?').run(sidOf(req)); res.json({ ok: 1 }); });

app.get('/api/state', auth, (req, res) => {
  const u = req.u, lv = levels(u.id), got = new Map(db.prepare('SELECT k,at FROM ach WHERE uid=?').all(u.id).map(r => [r.k, r.at]));
  res.json({
    me: { login: u.login, xp: u.xp, streak: u.streak, best: u.best, today: todayXp(u.id), cap: CAP },
    lessons: Object.values(LES).map(l => ({ id: l.id, b: l.b, t: l.t, lv: lv[l.id], open: open(l, lv), cool: Math.max(0, Math.ceil(((cool.get(u.id + l.id) || 0) - Date.now()) / 1000)) })),
    ach: ACH.map(a => ({ ...apub(a), got: got.get(a[0]) || null })), max: MAXL
  });
});

app.post('/api/start', auth, (req, res) => {
  const u = req.u, l = LES[req.body.lesson], err = (c, m) => res.status(c).json({ err: m });
  if (!l) return err(400, 'Нет такого задания');
  const L = levels(u.id);
  if (!open(l, L)) return err(403, 'Задание пока закрыто');
  if (L[l.id] >= MAXL) return err(400, 'Задание пройдено на максимум');
  const w = (cool.get(u.id + l.id) || 0) - Date.now();
  if (w > 0) return err(429, `Подожди ещё ${Math.ceil(w / 1000)} сек.`);
  if (todayXp(u.id) >= CAP) return err(429, 'Дневной лимит XP набран. Возвращайся завтра!');
  const old = runs.get(u.id); if (old) cool.set(u.id + old.les, Date.now() + COOL); // новая попытка при незавершённой = сброс прежней
  const r = { les: l.id, lvl: L[l.id] + 1, qs: shuf(l.p).map(prep), i: 0, bad: 0 };
  runs.set(u.id, r); res.json({ n: r.qs.length, ...cur(r) });
});

app.post('/api/answer', auth, (req, res) => {
  const u = req.u, r = runs.get(u.id);
  if (!r) return res.json({ over: 1 });
  const late = Date.now() - r.qt > r.lim * 1000 + 3000;
  const c = late ? { ok: false } : r.qs[r.i].chk(req.body.a);
  r.i++; if (!c.ok) r.bad++;
  const n = r.qs.length, fail = r.bad > (r.lvl < 3 ? 1 : 0), wait = c.e ? 3500 : 1600, out = { right: c.ok, e: c.e, wait, late };
  if (fail || r.i >= n) {
    runs.delete(u.id);
    if (fail) { cool.set(u.id + r.les, Date.now() + COOL); return res.json({ ...out, end: 1, pass: 0 }); }
    const perfect = r.bad == 0, xp = 10 * r.lvl + (perfect ? 5 : 0), d = day(), x = db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
    db.prepare('INSERT INTO prog VALUES(?,?,?) ON CONFLICT(uid,les) DO UPDATE SET lv=excluded.lv').run(u.id, r.les, r.lvl);
    db.prepare('INSERT INTO daily VALUES(?,?,?) ON CONFLICT(uid,day) DO UPDATE SET xp=xp+excluded.xp').run(u.id, d, xp);
    const st = x.last == d ? x.streak : x.last == day(1) ? x.streak + 1 : 1;
    db.prepare('UPDATE users SET xp=xp+?,streak=?,best=MAX(best,?),last=?,perfect=perfect+? WHERE id=?').run(xp, st, st, d, perfect ? 1 : 0, u.id);
    return res.json({ ...out, end: 1, pass: 1, xp, streak: st, perfect, newAch: checkAch(u.id) });
  }
  res.json({ ...out, ...cur(r, wait) });
});

app.post('/api/abort', auth, (req, res) => { // уход со страницы = попытка сброшена + кулдаун
  const r = runs.get(req.u.id); if (r) { cool.set(req.u.id + r.les, Date.now() + COOL); runs.delete(req.u.id); }
  res.json({ ok: 1 });
});

app.listen(process.env.PORT || 3000, () => console.log('ЭкоКвест: http://localhost:' + (process.env.PORT || 3000)));
