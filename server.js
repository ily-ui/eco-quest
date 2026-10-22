const express = require('express'), { Pool } = require('pg'), bcrypt = require('bcryptjs'), crypto = require('crypto');
const CAP = +process.env.DAILY_CAP || 80, MAXL = 5, COOL = 180000; // лимит XP в день, уровней в задании, кулдаун после провала (мс)
if (!process.env.DATABASE_URL) { console.error('Не задана переменная DATABASE_URL (строка подключения к PostgreSQL)'); process.exit(1); }
const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false } });
const q = (t, p) => pool.query(t, p).then(r => r.rows), q1 = (t, p) => q(t, p).then(r => r[0]);
const init = () => pool.query(`CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,login TEXT NOT NULL,hash TEXT NOT NULL,xp INT DEFAULT 0,streak INT DEFAULT 0,best INT DEFAULT 0,last TEXT,perfect INT DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS users_login ON users(LOWER(login));
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
const shuf = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1);[a[i], a[j]] = [a[j], a[i]]; } return a; };
const day = (off = 0) => new Date(Date.now() - off * 864e5).toISOString().slice(0, 10);
const todayXp = async uid => ((await q1('SELECT xp FROM daily WHERE uid=$1 AND day=$2', [uid, day()])) || { xp: 0 }).xp;
const levels = async uid => { const o = {}; for (const k in LES) o[k] = 0; for (const r of await q('SELECT les,lv FROM prog WHERE uid=$1', [uid])) o[r.les] = r.lv; return o; };
const stats = async uid => { const u = await q1('SELECT * FROM users WHERE id=$1', [uid]), lv = await levels(uid); return { ...u, lv, done: Object.values(lv).reduce((a, b) => a + b, 0) }; };
async function checkAch(uid) {
  const s = await stats(uid), have = new Set((await q('SELECT k FROM ach WHERE uid=$1', [uid])).map(r => r.k)), n = [];
  for (const a of ACH) if (!have.has(a[0]) && a[4](s)) { await q('INSERT INTO ach VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [uid, a[0], day()]); n.push(apub(a)); }
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
const ah = f => (req, res, next) => f(req, res, next).catch(e => { console.error(e); res.status(500).json({ err: 'Ошибка сервера, попробуй ещё раз' }); });
const mk = async (res, uid) => { const sid = crypto.randomBytes(24).toString('hex'); await q('INSERT INTO sess VALUES($1,$2)', [sid, uid]); res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`); };
const sidOf = req => ((req.headers.cookie || '').split('; ').find(c => c.startsWith('sid=')) || '').slice(4);
const auth = ah(async (req, res, next) => { req.u = await q1('SELECT u.* FROM users u JOIN sess s ON s.uid=u.id WHERE s.sid=$1', [sidOf(req)]); req.u ? next() : res.status(401).json({ err: 'Войди в аккаунт' }); });

app.post('/api/register', ah(async (req, res) => {
  const login = String(req.body.login || ''), pw = String(req.body.password || '');
  if (!/^[\p{L}\d_]{3,20}$/u.test(login) || pw.length < 6) return res.status(400).json({ err: 'Логин: 3–20 символов (буквы, цифры, _). Пароль: от 6 символов' });
  try { const u = await q1('INSERT INTO users(login,hash) VALUES($1,$2) RETURNING id', [login, bcrypt.hashSync(pw, 10)]); await mk(res, u.id); res.json({ ok: 1 }); }
  catch (e) { if (e.code == '23505') return res.status(400).json({ err: 'Такой логин уже занят' }); throw e; }
}));
app.post('/api/login', ah(async (req, res) => {
  const u = await q1('SELECT * FROM users WHERE LOWER(login)=LOWER($1)', [String(req.body.login || '')]);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.hash)) return res.status(401).json({ err: 'Неверный логин или пароль' });
  await mk(res, u.id); res.json({ ok: 1 });
}));
app.post('/api/logout', ah(async (req, res) => { await q('DELETE FROM sess WHERE sid=$1', [sidOf(req)]); res.json({ ok: 1 }); }));

app.get('/api/state', auth, ah(async (req, res) => {
  const u = req.u, lv = await levels(u.id), got = new Map((await q('SELECT k,at FROM ach WHERE uid=$1', [u.id])).map(r => [r.k, r.at]));
  res.json({
    me: { login: u.login, xp: u.xp, streak: u.streak, best: u.best, today: await todayXp(u.id), cap: CAP },
    lessons: Object.values(LES).map(l => ({ id: l.id, b: l.b, t: l.t, lv: lv[l.id], open: open(l, lv), cool: Math.max(0, Math.ceil(((cool.get(u.id + l.id) || 0) - Date.now()) / 1000)) })),
    ach: ACH.map(a => ({ ...apub(a), got: got.get(a[0]) || null })), max: MAXL
  });
}));

app.post('/api/start', auth, ah(async (req, res) => {
  const u = req.u, l = LES[req.body.lesson], err = (c, m) => res.status(c).json({ err: m });
  if (!l) return err(400, 'Нет такого задания');
  const L = await levels(u.id);
  if (!open(l, L)) return err(403, 'Задание пока закрыто');
  if (L[l.id] >= MAXL) return err(400, 'Задание пройдено на максимум');
  const w = (cool.get(u.id + l.id) || 0) - Date.now();
  if (w > 0) return err(429, `Подожди ещё ${Math.ceil(w / 1000)} сек.`);
  if (await todayXp(u.id) >= CAP) return err(429, 'Дневной лимит XP набран. Возвращайся завтра!');
  const old = runs.get(u.id); if (old) cool.set(u.id + old.les, Date.now() + COOL); // новая попытка при незавершённой = сброс прежней
  const r = { les: l.id, lvl: L[l.id] + 1, qs: shuf(l.p).map(prep), i: 0, bad: 0 };
  runs.set(u.id, r); res.json({ n: r.qs.length, ...cur(r) });
}));

app.post('/api/answer', auth, ah(async (req, res) => {
  const u = req.u, r = runs.get(u.id);
  if (!r) return res.json({ over: 1 });
  const late = Date.now() - r.qt > r.lim * 1000 + 3000;
  const c = late ? { ok: false } : r.qs[r.i].chk(req.body.a);
  r.i++; if (!c.ok) r.bad++;
  const n = r.qs.length, fail = r.bad > (r.lvl < 3 ? 1 : 0), wait = c.e ? 3500 : 1600, out = { right: c.ok, e: c.e, wait, late };
  if (fail || r.i >= n) {
    runs.delete(u.id);
    if (fail) { cool.set(u.id + r.les, Date.now() + COOL); return res.json({ ...out, end: 1, pass: 0 }); }
    const perfect = r.bad == 0, xp = 10 * r.lvl + (perfect ? 5 : 0), d = day(), x = await q1('SELECT * FROM users WHERE id=$1', [u.id]);
    await q('INSERT INTO prog VALUES($1,$2,$3) ON CONFLICT(uid,les) DO UPDATE SET lv=EXCLUDED.lv', [u.id, r.les, r.lvl]);
    await q('INSERT INTO daily VALUES($1,$2,$3) ON CONFLICT(uid,day) DO UPDATE SET xp=daily.xp+EXCLUDED.xp', [u.id, d, xp]);
    const st = x.last == d ? x.streak : x.last == day(1) ? x.streak + 1 : 1;
    await q('UPDATE users SET xp=xp+$1,streak=$2,best=GREATEST(best,$3),last=$4,perfect=perfect+$5 WHERE id=$6', [xp, st, st, d, perfect ? 1 : 0, u.id]);
    return res.json({ ...out, end: 1, pass: 1, xp, streak: st, perfect, newAch: await checkAch(u.id) });
  }
  res.json({ ...out, ...cur(r, wait) });
}));

app.post('/api/abort', auth, (req, res) => { // уход со страницы = попытка сброшена + кулдаун
  const r = runs.get(req.u.id); if (r) { cool.set(req.u.id + r.les, Date.now() + COOL); runs.delete(req.u.id); }
  res.json({ ok: 1 });
});

const port = process.env.PORT || 3000;
init().then(() => app.listen(port, () => console.log('ЭкоКвест: http://localhost:' + port))).catch(e => { console.error('Ошибка подключения к базе:', e.message); process.exit(1); });
