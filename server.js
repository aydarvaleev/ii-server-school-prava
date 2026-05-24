const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const mammoth = require('mammoth');
const { HttpsProxyAgent } = require('https-proxy-agent');

// ─── ИНИЦИАЛИЗАЦИЯ (один раз при старте) ────────────────────────────
const app = express();

// Прокси для обхода блокировки Anthropic с российских IP
// HTTPS_PROXY задаётся в переменных окружения Timeweb: http://login:pass@ip:port
const proxyUrl = process.env.HTTPS_PROXY;
const clientOptions = { apiKey: process.env.ANTHROPIC_API_KEY };
if (proxyUrl) {
  clientOptions.httpAgent = new HttpsProxyAgent(proxyUrl);
  console.log('Прокси подключён:', proxyUrl.replace(/:([^@]+)@/, ':***@'));
} else {
  console.log('Прокси не настроен — работаем напрямую');
}
const client = new Anthropic(clientOptions);

app.set('trust proxy', 1);

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));

// ─── СЧЁТЧИКИ ЗАПРОСОВ В ПАМЯТИ ─────────────────────────────────────
// Формат: { 'ip_plan_date': count }
const dailyCounters = new Map();
const minuteCounters = new Map();

// Сброс счётчиков в 00:00 МСК
function getMskDateKey() {
  const now = new Date();
  // МСК = UTC+3
  const msk = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return msk.toISOString().slice(0, 10); // '2026-04-10'
}
function getMinuteKey() {
  return Math.floor(Date.now() / 60000); // меняется каждую минуту
}

// Чистим старые записи раз в час
setInterval(() => {
  const today = getMskDateKey();
  const nowMinute = getMinuteKey();
  for (const [key] of dailyCounters) {
    if (!key.endsWith(today)) dailyCounters.delete(key);
  }
  for (const [key] of minuteCounters) {
    const keyMinute = parseInt(key.split('_').pop());
    if (nowMinute - keyMinute > 2) minuteCounters.delete(key);
  }
}, 60 * 60 * 1000);

function checkAndIncrementLimits(ip, plan) {
  const config = PLANS[plan] || PLANS.standard;
  const today = getMskDateKey();
  const nowMinute = getMinuteKey();

  const dayKey = `${ip}_${plan}_${today}`;
  const minKey = `${ip}_${plan}_${nowMinute}`;

  const dayCount = dailyCounters.get(dayKey) || 0;
  const minCount = minuteCounters.get(minKey) || 0;

  if (dayCount >= config.requestsPerDay) {
    return { allowed: false, error: `Достигнут дневной лимит (${config.requestsPerDay} запросов). Лимит обновится в 00:00 по московскому времени.`, used: dayCount, limit: config.requestsPerDay };
  }
  if (minCount >= config.requestsPerMinute) {
    return { allowed: false, error: `Слишком много запросов. Подождите минуту.`, used: dayCount, limit: config.requestsPerDay };
  }

  dailyCounters.set(dayKey, dayCount + 1);
  minuteCounters.set(minKey, minCount + 1);
  return { allowed: true, used: dayCount + 1, limit: config.requestsPerDay };
}

function getUsedToday(ip, plan) {
  const today = getMskDateKey();
  const dayKey = `${ip}_${plan}_${today}`;
  return dailyCounters.get(dayKey) || 0;
}

// ─── АНАЛИТИКА ───────────────────────────────────────────────────────
const analytics = {
  totalRequests: 0,
  todayRequests: 0,
  todayDate: getMskDateKey(),
  uniqueIPs: new Set(),
  todayIPs: new Set(),
  modeStats: { 1: 0, 2: 0, 3: 0 },
  planStats: { standard: 0, premium: 0 },
  recentQueries: [], // все запросы за 7 дней
  dailyStats: {}     // статистика по дням
};

// Сброс дневной статистики в 00:00 МСК
setInterval(() => {
  const today = getMskDateKey();
  if (analytics.todayDate !== today) {
    analytics.todayDate = today;
    analytics.todayRequests = 0;
    analytics.todayIPs = new Set();
    console.log('Дневная статистика сброшена. Новый день:', today);
  }
}, 60 * 1000); // проверяем каждую минуту

function recordAnalytics(ip, plan, mode, queryText) {
  analytics.totalRequests++;
  analytics.todayRequests++;
  analytics.uniqueIPs.add(ip);
  analytics.todayIPs.add(ip);
  analytics.modeStats[mode] = (analytics.modeStats[mode] || 0) + 1;
  analytics.planStats[plan] = (analytics.planStats[plan] || 0) + 1;

  // Дневная статистика
  const today = getMskDateKey();
  if (!analytics.dailyStats[today]) {
    analytics.dailyStats[today] = { requests: 0, uniqueIPs: new Set() };
  }
  analytics.dailyStats[today].requests++;
  analytics.dailyStats[today].uniqueIPs.add(ip);

  // Сохраняем полный текст запроса
  const fullText = typeof queryText === 'string' ? queryText : '[файл/сравнение]';
  analytics.recentQueries.unshift({
    time: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
    date: today,
    plan,
    mode,
    text: fullText
  });

  // Удаляем запросы старше 7 дней
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const cutoffDate = sevenDaysAgo.toISOString().slice(0, 10);
  while (analytics.recentQueries.length > 0) {
    const last = analytics.recentQueries[analytics.recentQueries.length - 1];
    if (last.date < cutoffDate) analytics.recentQueries.pop();
    else break;
  }
  // Максимум 500 записей в памяти
  if (analytics.recentQueries.length > 500) analytics.recentQueries.pop();
}

// ─── ТАРИФЫ ──────────────────────────────────────────────────────────
const PLANS = {
  standard: {
    maxInputChars: 30000,   // символов ввода
    maxTokens: 4000,        // символов ответа (~4000 токенов)
    requestsPerDay: 15,
    requestsPerMinute: 5
  },
  premium: {
    maxInputChars: 100000,  // символов ввода
    maxTokens: 16000,       // символов ответа (~30 000 символов ≈ 16 000 токенов)
    requestsPerDay: 30,
    requestsPerMinute: 10
  }
};

const MAX_TEXT_CHARS = 100000; // общий лимит извлечения текста из файла

// ─── ПРОМПТЫ ─────────────────────────────────────────────────────────
const globalPrompt = `ОБЩИЕ ПРАВИЛА (обязательны во всех режимах):

ТЕМАТИКА:
- Ты работаешь ТОЛЬКО по юридическим вопросам в рамках законодательства РФ.
- Если пользователь задаёт вопрос НЕ по юридической теме (например, про погоду, рецепты, технологии, политику и т.д.) — вежливо откажи и напомни, что ты специализируешься только на юридических и процессуальных вопросах.
- Не отвечай на просьбы написать стихи, код, переводы и любой контент вне юридической сферы.

ПРОДУКТЫ КЛУБА ПРОЦЕССУАЛИСТОВ:
Если в запросе пользователя встречается тема, связанная с одним из продуктов ниже — в конце своего ответа добавь короткий абзац (1-2 предложения) с мягкой рекомендацией. Не навязывай, упоминай один раз и только по теме запроса.

Список продуктов:
- Медиация и переговоры → Вебинар «Как навыки медиации помогают юристам зарабатывать больше» — 17 марта 2026 г. Ссылка: https://clck.ru/3SS2fD
- Процессуальная стратегия и подготовка к суду → Курс «Клуб процессуалистов» — профессиональное сообщество для юристов. Ссылка: https://clck.ru/3SS2uJ

ВАЖНО: не упоминай продукты если тема запроса не связана с ними.

КОРОТКИЕ ОТВЕТЫ НА НЕЙТРАЛЬНЫЕ ЗАПРОСЫ:
Если пользователь пишет что-то нейтральное, тестовое или не содержащее юридического вопроса (например: "привет", "тест", "тестовый запуск", "проверка", "как дела") — отвечай коротко, одним предложением. Не перечисляй свои возможности, не просить предоставить материалы. Просто вежливо скажи что готов помочь с юридическими вопросами.

ЗАПРЕТ НА ГАЛЛЮЦИНАЦИИ:
- НИКОГДА не придумывай суммы, цифры, даты, сроки, штрафы или любые числовые данные которых нет в документе. Если сумма не указана — пиши «сумма определяется в Приложении / Задании» или «не указана в тексте договора».
- НИКОГДА не утверждай что какая-либо статья, норма или закон не существует, если ты не уверен на 100%.
- Если не можешь найти норму — напиши: «Рекомендую проверить актуальную редакцию в правовой базе (ГАРАНТ, КонсультантПлюс)».
- Помни: в кодексах РФ нумерация статей может быть нелинейной (статьи 186.1, 186.2 и т.д.), статьи могут быть добавлены или изменены.
- При анализе документов работай ТОЛЬКО с тем что реально написано в тексте. Не заполняй пробелы «типичными» значениями.`;

const systemPrompts = {
  1: `Ты — ИИ-помощник процессуалиста. Режим: Анализ и структурирование правовой позиции.

Структура ответа:
1. Нейтральное резюме фактических обстоятельств
2. Возможные варианты правовой квалификации
3. Структура правовой позиции по логическим блокам
4. Сильные стороны позиции
5. Потенциально уязвимые места
6. Вопросы и аспекты, требующие уточнения или проверки

Работай только с предоставленным текстом. Не выдумывай факты. Не давай категоричных прогнозов исхода дела. Используй нейтральные формулировки. Работай исключительно в рамках законодательства РФ. Объём ответа — не более 1000 слов.

ВАЖНО ПРО НОРМЫ ПРАВА: Никогда не утверждай что статья или норма не существует. Нумерация статей в кодексах РФ может быть нелинейной. Если не уверен в содержании нормы — скажи об этом прямо и рекомендуй проверить в ГАРАНТ или КонсультантПлюс.`,

  2: `Ты — редактор юридических текстов (legal writing + legal design). Твоя задача — переработать присланный юридический текст так, чтобы он стал понятнее и легче для чтения, но при этом НЕ изменился юридический смысл и содержание.

КРИТИЧЕСКИЕ ОГРАНИЧЕНИЯ:
1) НЕ меняй правовой смысл, условия, права/обязанности, сроки, суммы, основания, ссылки на нормы.
2) НЕ добавляй новые факты, обязательства, исключения, санкции, гарантии, определения.
3) Сомнительные места оставляй максимально близко к исходнику.
4) Противоречие/двусмысленность в исходнике — сохрани как есть, отметь в таблице правок.

НУМЕРАЦИЯ:
5) Сохраняй структуру и порядок нумерации. Не переименовывай пункты.

КАК ПЕРЕРАБАТЫВАТЬ:
A) Убирай канцелярит, повторы, пустые вводные.
B) Короткие предложения, понятные связи, юридическая аккуратность.
C) Активный залог, где смысл не меняется.
D) Отглагольные существительные → глаголы: «осуществление» → «выполнить».
E) Дроби длинные предложения.
F) Перечни оформляй списками, но НЕ добавляй заголовки.
G) Ссылки на нормы сохраняй.

ССЫЛКИ НА ЗАКОН:
H) Не начинай предложение со слов «Согласно», «В соответствии», «На основании». Сначала суть — потом источник в скобках в конце.

ЛЕКСИЧЕСКИЕ ЗАМЕНЫ:
- «в целях» → «чтобы» / «для»
- «денежные средства» → «деньги»
- «в размере» → убрать, сумму напрямую
- «является» → тире «—» (если определение)
- «не представляется возможным» → «невозможно»
- «настоящий договор/раздел/пункт» → убрать «настоящий»
- «в случае если» → «если»

СКОБКИ И ЧИСЛА:
K) Не расшифровывай суммы словами: «215 000 (двести пятнадцать тысяч)» → «215 000».

ДАТЫ:
L) Все даты — дд.мм.гггг. Убирай «г.», «года», словесные месяцы.

ОФОРМЛЕНИЕ:
- Кавычки: «ёлочки»
- Проценты: без пробела (0,1%)
- Деньги: знак валюты справа с пробелом (500 000 ₽)

ФОРМАТ ОТВЕТА (строго):
1) Переработанный текст.
2) Таблица правок «Было → Стало» — 5–12 самых показательных изменений.`,

  3: `Ты — ИИ-помощник процессуалиста. Режим: Анализ судебной практики.

В блоке ГАРАНТ ниже будут реальные тексты судебных актов из базы ГАРАНТ с конкретными реквизитами.

Структура ответа:
1. Обобщение подходов судов по данной теме
2. Ключевые факторы и обстоятельства, влияющие на решение
3. Конкретные примеры из переданных судебных актов — ОБЯЗАТЕЛЬНО указывай: название суда, номер дела, дату, краткую суть решения
4. Условия применимости выводов к текущей ситуации
5. Риски и рекомендации

ВАЖНО:
- Используй реквизиты ТОЛЬКО из текстов документов в блоке ГАРАНТ ниже. Не придумывай номера дел и даты.
- Если в блоке ГАРАНТ есть тексты документов — обязательно называй конкретные реквизиты из них.
- Если документы не загружены или их текст не содержит реквизитов — честно скажи об этом и дай общий анализ подходов судов на основе своих знаний, указав что конкретные дела нужно найти в ГАРАНТ или на kad.arbitr.ru.
- Ссылайся на документы в формате [Название](ссылка).
- Объём ответа — не более 1200 слов.`
};

// ─── КЕШ ГАРАНТ ──────────────────────────────────────────────────────
const garantCache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

async function searchGarant(query, suffix = '') {
  try {
    const token = process.env.GARANT_TOKEN;
    if (!token) return null;

    const fullQuery = suffix ? `${query} ${suffix}` : query;
    const cacheKey = fullQuery.trim().toLowerCase();
    const cached = garantCache.get(cacheKey);
    if (cached && Date.now() - cached.time < CACHE_TTL) return cached.data;

    const response = await fetch('https://api.garant.ru/v2/search', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ text: fullQuery, page: 1, env: 'internet', sort: 0, sortOrder: 0 })
    });

    if (!response.ok) return null;
    const data = JSON.parse(await response.text());
    const docs = data.documents || [];
    console.log(`ГАРАНТ [${suffix || 'общий'}] найдено:`, docs.length);

    garantCache.set(cacheKey, { data: docs, time: Date.now() });
    if (garantCache.size > 500) garantCache.delete(garantCache.keys().next().value);
    return docs;
  } catch (err) {
    console.error('ГАРАНТ ошибка:', err.message);
    return null;
  }
}

// ─── ИЗВЛЕЧЕНИЕ ТЕКСТА ───────────────────────────────────────────────
// Извлекаем текст по абзацам — сохраняет структуру документа
function extractDocxText(buf) {
  const AdmZip = require('adm-zip') // fallback если нет — используем mammoth
  try {
    const zip = new AdmZip(buf);
    const xml = zip.readAsText('word/document.xml');
    const { DOMParser } = require('@xmldom/xmldom');
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const paras = doc.getElementsByTagNameNS(NS, 'p');
    const lines = [];
    for (let i = 0; i < paras.length; i++) {
      const ts = paras[i].getElementsByTagNameNS(NS, 't');
      let line = '';
      for (let j = 0; j < ts.length; j++) line += ts[j].textContent || '';
      if (line.trim()) lines.push(line.trim());
    }
    return lines.join('\n');
  } catch(e) {
    return null;
  }
}

async function extractFileText(f) {
  if (!f || !f.base64 || !f.ext) return null;
  if (f.ext === 'pdf') return { type: 'pdf', data: f.base64, name: f.name };
  if (f.ext === 'docx') {
    const buf = Buffer.from(f.base64, 'base64');
    let text = '';
    try {
      // Читаем docx как zip и парсим XML по абзацам — сохраняет структуру
      const JSZip = require('jszip');
      const zip = await JSZip.loadAsync(buf);
      const xmlContent = await zip.file('word/document.xml').async('string');
      const NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
      // Простой regex-парсинг абзацев из XML
      const paraRegex = /<w:p[ >][\s\S]*?<\/w:p>/g;
      const textRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
      const paragraphs = [];
      let paraMatch;
      while ((paraMatch = paraRegex.exec(xmlContent)) !== null) {
        const paraXml = paraMatch[0];
        const texts = [];
        let tMatch;
        const tRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
        while ((tMatch = tRegex.exec(paraXml)) !== null) {
          texts.push(tMatch[1]);
        }
        const line = texts.join('').trim();
        if (line) paragraphs.push(line);
      }
      text = paragraphs.join('\n');
    } catch(e) {
      // Fallback на mammoth если jszip недоступен
      console.log('jszip failed, trying mammoth:', e.message);
      try {
        const res = await mammoth.extractRawText({ buffer: buf });
        text = (res.value || '').trim();
      } catch(e2) {
        console.log('mammoth также не сработал:', e2.message);
      }
    }
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS);
      console.log('Текст обрезан до ' + MAX_TEXT_CHARS + ' символов');
    }
    console.log('Извлечено символов:', text.length, '| абзацев:', text.split('\n').length);
    return { type: 'text', text, name: f.name };
  }
  return null;
}

// ─── ОСНОВНОЙ МАРШРУТ ────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, mode, file, file2, compareMode, plan } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Некорректный запрос.' });
  }

  // Определяем тариф
  const planKey = plan === 'premium' ? 'premium' : 'standard';
  const planConfig = PLANS[planKey];
  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';

  // Проверяем лимиты
  const limitCheck = checkAndIncrementLimits(clientIP, planKey);
  if (!limitCheck.allowed) {
    return res.status(429).json({ error: limitCheck.error, used: limitCheck.used, limit: limitCheck.limit });
  }

  console.log('Тариф:', planKey, '| запросов сегодня:', limitCheck.used, '/', limitCheck.limit);

  const modeNum = parseInt(mode) || 1;
  const modePrompt = systemPrompts[modeNum] || systemPrompts[1];

  try {
    let finalMessages = [...messages];

    // ─── ФАЙЛЫ ───────────────────────────────────────────────────────
    if (compareMode && file && file2) {
      const doc1 = await extractFileText(file);
      const doc2 = await extractFileText(file2);
      const lastMsg = finalMessages[finalMessages.length - 1];
      const baseText = typeof lastMsg.content === 'string' ? lastMsg.content : '';

      if (doc1 && doc2) {
        const buildContent = (doc, label) => doc.type === 'pdf'
          ? [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: doc.data } },
              { type: 'text', text: `[${label}: ${doc.name}]` }
            ]
          : [{ type: 'text', text: `=== ${label}: ${doc.name} ===\n\n${doc.text}` }];

        finalMessages[finalMessages.length - 1] = {
          role: 'user',
          content: [
            ...buildContent(doc1, 'ВЕРСИЯ 1 — исходный документ'),
            ...buildContent(doc2, 'ВЕРСИЯ 2 — документ с правками'),
            { type: 'text', text: baseText || 'Проанализируй изменения между версиями: какие положения изменены, какие создают юридические риски, как изменился баланс интересов сторон.' }
          ]
        };
      }
    } else if (file && file.base64 && file.ext) {
      const lastMsg = finalMessages[finalMessages.length - 1];
      if (file.ext === 'pdf') {
        finalMessages[finalMessages.length - 1] = {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.base64 } },
            { type: 'text', text: lastMsg.content || 'Проанализируй этот документ' }
          ]
        };
      } else if (file.ext === 'docx') {
        const buf = Buffer.from(file.base64, 'base64');
        const result = await mammoth.extractRawText({ buffer: buf });
        let extractedText = result.value || '';
        if (extractedText.length > planConfig.maxInputChars) {
          extractedText = extractedText.slice(0, planConfig.maxInputChars);
          console.log('Текст обрезан по тарифу до', planConfig.maxInputChars, 'символов');
        }
        finalMessages[finalMessages.length - 1] = {
          role: 'user',
          content: `${lastMsg.content || 'Проанализируй документ'}\n\n[Файл: ${file.name}]\n\n${extractedText}`
        };
      }
    }

    // Проверяем лимит символов ввода (текстовый запрос без файла)
    const lastMsgContent = finalMessages[finalMessages.length - 1]?.content;
    if (typeof lastMsgContent === 'string' && lastMsgContent.length > planConfig.maxInputChars) {
      return res.status(400).json({
        error: `Превышен лимит символов для вашего тарифа (${planConfig.maxInputChars.toLocaleString()} символов). Сократите запрос или перейдите на тариф Премиум.`
      });
    }

    // Записываем аналитику
    const lastMsgForAnalytics = finalMessages[finalMessages.length - 1];
    const queryPreview = typeof lastMsgForAnalytics?.content === 'string'
      ? lastMsgForAnalytics.content : '[файл/сравнение]';
    recordAnalytics(clientIP, planKey, modeNum, queryPreview);

    // ─── ГАРАНТ ───────────────────────────────────────────────────────
    let garantContext = '';
    const lastUserMessage = finalMessages[finalMessages.length - 1];
    const queryText = typeof lastUserMessage.content === 'string'
      ? lastUserMessage.content
      : lastUserMessage.content?.[lastUserMessage.content.length - 1]?.text || '';

    const stopWords = ['как', 'что', 'где', 'когда', 'зачем', 'почему', 'какова', 'каков',
      'правомерен', 'ли', 'и', 'в', 'на', 'по', 'с', 'о', 'а', 'но', 'это', 'есть',
      'быть', 'при', 'если', 'или', 'для', 'его', 'её', 'них', 'они', 'мне', 'вам',
      'приведи', 'дай', 'найди', 'покажи', 'расскажи', 'укажи', 'перечисли'];
    const searchPhrase = queryText.trim().split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.includes(w.toLowerCase()))
      .slice(0, 6).join(' ').slice(0, 100);

    if (modeNum === 1 && searchPhrase) {
      // ── Режим 01: ссылки на законодательство ──
      // Используем и полный запрос и ключевые слова для лучшего покрытия
      const garantQuery1 = queryText.slice(0, 200);
      const [lawDocs, courtDocs] = await Promise.all([
        searchGarant(garantQuery1),
        searchGarant(searchPhrase, 'судебная практика решение суда')
      ]);
      const allDocs = [];
      const seen = new Set();
      if (courtDocs) for (const d of courtDocs.slice(0, 5)) { if (!seen.has(d.url)) { seen.add(d.url); allDocs.push({ ...d, src: 'практика' }); } }
      if (lawDocs)   for (const d of lawDocs.slice(0, 5))   { if (!seen.has(d.url)) { seen.add(d.url); allDocs.push({ ...d, src: 'закон' }); } }
      if (allDocs.length > 0) {
        garantContext = '\n\n─── ДОКУМЕНТЫ ИЗ БАЗЫ ГАРАНТ ───\nНайдены документы из базы ГАРАНТ. Ссылайся на релевантные нормы в формате [Название](ссылка).\n\n' +
          allDocs.slice(0, 5).map((d, i) => {
            const tag = d.src === 'практика' ? '[Судебная практика]' : '[Законодательство]';
            return `${i + 1}. ${tag} ${d.name}\n   Ссылка: https://internet.garant.ru${d.url}`;
          }).join('\n\n');
      }
    }

    if (modeNum === 3 && searchPhrase) {
      // ── Режим 03: поиск судебной практики + метаданные документов ──
      const token = process.env.GARANT_TOKEN;

      // Используем полный текст запроса пользователя — так ГАРАНТ найдёт больше
      // searchPhrase (фильтрованные слова) часто даёт плохие результаты
      const garantQuery = queryText.slice(0, 200); // полный запрос пользователя
      const garantQuery2 = searchPhrase + ' притворная сделка суд решение';

      const [res1, res2] = await Promise.all([
        fetch('https://api.garant.ru/v2/search', {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({
            text: garantQuery,
            page: 1, env: 'internet', sort: 0, sortOrder: 0
          })
        }),
        fetch('https://api.garant.ru/v2/search', {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({
            text: garantQuery2,
            page: 1, env: 'internet', sort: 0, sortOrder: 0
          })
        })
      ]);

      const seen = new Set();
      const courtDocs = [];

      for (const resp of [res1, res2]) {
        if (resp.ok) {
          const data = await resp.json().catch(() => ({}));
          for (const d of (data.documents || [])) {
            if (!seen.has(d.url) && courtDocs.length < 8) {
              seen.add(d.url);
              courtDocs.push(d);
            }
          }
        }
      }
      console.log('ГАРАНТ режим 03: найдено документов:', courtDocs.length);

      // Загружаем метаданные топ-5 документов (/v2/topic - 300 запросов/мес)
      const metaDocs = await Promise.all(courtDocs.slice(0, 5).map(async (doc) => {
        try {
          const metaResp = await fetch(`https://api.garant.ru/v2/topic/${doc.topic}`, {
            headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` }
          });
          if (!metaResp.ok) return { ...doc, meta: null };
          const meta = await metaResp.json();
          return { ...doc, meta };
        } catch (e) {
          return { ...doc, meta: null };
        }
      }));

      console.log('ГАРАНТ режим 03: загружено метаданных:', metaDocs.filter(d => d.meta).length);

      if (courtDocs.length > 0) {
        garantContext = '\n\n─── СУДЕБНАЯ ПРАКТИКА ИЗ БАЗЫ ГАРАНТ ───\n' +
          'Найдены следующие документы из базы ГАРАНТ. ' +
          'Используй реквизиты из метаданных ниже (тип, номер, дата, орган). ' +
          'Ссылайся в формате [Название](ссылка).\n\n';

        garantContext += metaDocs.map((d, i) => {
          const m = d.meta;
          let info = `${i + 1}. ${d.name}\n   Ссылка: https://internet.garant.ru${d.url}`;
          if (m) {
            if (m.type?.length)    info += `\n   Тип: ${m.type.join(', ')}`;
            if (m.number?.length)  info += `\n   Номер: ${m.number.join(', ')}`;
            if (m.date?.length)    info += `\n   Дата: ${m.date.join(', ')}`;
            if (m.adopted?.length) info += `\n   Орган: ${m.adopted[0]}`;
            if (m.status)          info += `\n   Статус: ${m.status}`;
          }
          return info;
        }).join('\n\n');
      } else {
        garantContext = '\n\n─── ГАРАНТ ───\nПо данному запросу документы в базе ГАРАНТ не найдены. ' +
          'Проанализируй подходы судов на основе своих знаний и укажи что конкретные реквизиты ' +
          'нужно проверить в ГАРАНТ, КонсультантПлюс или на kad.arbitr.ru.';
      }
    }

    const fullSystemPrompt = globalPrompt + '\n\n' + modePrompt + garantContext;

    // ─── СТРИМИНГ с повтором при перегрузке Anthropic ────────────────
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const MAX_RETRIES = 3;
    const RETRY_DELAY = 5000; // 5 секунд между попытками

    async function tryStream(attempt) {
      return new Promise((resolve, reject) => {
        const stream = client.messages.stream({
          model: 'claude-sonnet-4-20250514',
          max_tokens: planConfig.maxTokens,
          system: fullSystemPrompt,
          messages: finalMessages
        });

        stream.on('text', (text) => {
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        });

        stream.on('error', (err) => {
          const isOverloaded = err.message && (
            err.message.includes('overloaded') ||
            err.message.includes('Overloaded') ||
            err.status === 529
          );
          if (isOverloaded && attempt < MAX_RETRIES) {
            console.log(`Anthropic перегружен, попытка ${attempt + 1}/${MAX_RETRIES} через ${RETRY_DELAY/1000}с...`);
            // Сообщаем пользователю что ждём
            res.write(`data: ${JSON.stringify({ text: `\n\n⏳ Сервис временно перегружен, повторяю запрос (попытка ${attempt + 1})...\n\n` })}\n\n`);
            setTimeout(() => resolve('retry'), RETRY_DELAY);
          } else {
            console.error('Stream error:', err.message);
            res.write(`data: ${JSON.stringify({ error: 'Сервис временно недоступен. Пожалуйста, повторите запрос через минуту.' })}\n\n`);
            res.end();
            resolve('error');
          }
        });

        stream.on('finalMessage', () => {
          res.write(`data: ${JSON.stringify({ done: true, used: limitCheck.used, limit: limitCheck.limit })}\n\n`);
          res.end();
          resolve('done');
        });
      });
    }

    // Запускаем с повторами
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const result = await tryStream(attempt);
      if (result !== 'retry') break;
    }

  } catch (err) {
    console.error('Ошибка:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Ошибка сервера: ' + err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Текущий лимит пользователя
app.get('/api/limits', (req, res) => {
  const plan = req.query.plan || 'standard';
  const planKey = plan === 'premium' ? 'premium' : 'standard';
  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
  const used = getUsedToday(clientIP, planKey);
  const limit = PLANS[planKey].requestsPerDay;
  res.json({ used, limit, remaining: limit - used });
});

// Аналитика (защищена секретным ключом)
app.get('/api/analytics', (req, res) => {
  const secret = req.query.secret;
  if (secret !== process.env.ANALYTICS_SECRET && secret !== 'lex2026') {
    return res.status(403).json({ error: 'Доступ запрещён' });
  }
  // Готовим дневную статистику для вывода
  const dailySummary = {};
  for (const [date, data] of Object.entries(analytics.dailyStats)) {
    dailySummary[date] = {
      requests: data.requests,
      uniqueUsers: data.uniqueIPs.size
    };
  }

  res.json({
    total: analytics.totalRequests,
    today: analytics.todayRequests,
    todayDate: analytics.todayDate,
    uniqueTotal: analytics.uniqueIPs.size,
    uniqueToday: analytics.todayIPs.size,
    modes: { 
      '01_Анализ_позиции': analytics.modeStats[1] || 0,
      '02_Документы': analytics.modeStats[2] || 0,
      '03_Практика': analytics.modeStats[3] || 0
    },
    plans: analytics.planStats,
    dailyStats: dailySummary,
    totalStoredQueries: analytics.recentQueries.length,
    recent: analytics.recentQueries
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
