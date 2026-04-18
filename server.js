const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const mammoth = require('mammoth');

// ─── ИНИЦИАЛИЗАЦИЯ (один раз при старте) ────────────────────────────
const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.set('trust proxy', 1);

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));

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
  recentQueries: [] // последние 50 запросов
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

  // Сохраняем последние 50 запросов (первые 100 символов)
  const preview = typeof queryText === 'string' ? queryText.slice(0, 100) : '[файл]';
  analytics.recentQueries.unshift({
    time: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
    plan, mode, preview
  });
  if (analytics.recentQueries.length > 50) analytics.recentQueries.pop();
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

Структура ответа:
1. Обобщение подходов судов по данной теме
2. Ключевые факторы и обстоятельства, влияющие на решение
3. Конкретные примеры из судебной практики (со ссылками на документы ГАРАНТ если есть)
4. Условия применимости выводов к текущей ситуации
5. Риски и рекомендации

ВАЖНО:
- Если в блоке ГАРАНТ есть судебные акты — используй их как основу анализа, ссылайся на них конкретно.
- Не выдумывай реквизиты судебных решений (номера дел, даты, названия судов).
- Если судебная практика по теме не найдена в ГАРАНТ — честно скажи об этом и дай общий анализ подходов на основе своих знаний.
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

    // ─── ГАРАНТ (двухшаговый поиск) ─────────────────────────────────
    let garantContext = '';
    if (modeNum === 1 || modeNum === 3) {
      const lastUserMessage = finalMessages[finalMessages.length - 1];
      const queryText = typeof lastUserMessage.content === 'string'
        ? lastUserMessage.content
        : lastUserMessage.content?.[lastUserMessage.content.length - 1]?.text || '';

      // Извлекаем ключевые слова
      const stopWords = ['как', 'что', 'где', 'когда', 'зачем', 'почему', 'какова', 'каков',
        'правомерен', 'ли', 'и', 'в', 'на', 'по', 'с', 'о', 'а', 'но', 'это', 'есть',
        'быть', 'при', 'если', 'или', 'для', 'его', 'её', 'них', 'они', 'мне', 'вам'];
      const words = queryText.trim().split(/\s+/)
        .filter(w => w.length > 3 && !stopWords.includes(w.toLowerCase()))
        .slice(0, 6).join(' ');
      const searchPhrase = words.slice(0, 100);

      if (searchPhrase) {
        // Запрос 1: общий поиск по законодательству
        // Запрос 2: поиск по судебной практике
        const [lawDocs, courtDocs] = await Promise.all([
          searchGarant(searchPhrase),
          searchGarant(searchPhrase, 'судебная практика решение суда')
        ]);

        const allDocs = [];
        const seen = new Set();

        // Сначала добавляем судебную практику (приоритет для режима 3)
        if (courtDocs && courtDocs.length > 0) {
          for (const doc of courtDocs.slice(0, 5)) {
            if (!seen.has(doc.url)) { seen.add(doc.url); allDocs.push({ ...doc, src: 'практика' }); }
          }
        }
        // Потом добавляем законодательство
        if (lawDocs && lawDocs.length > 0) {
          for (const doc of lawDocs.slice(0, 5)) {
            if (!seen.has(doc.url)) { seen.add(doc.url); allDocs.push({ ...doc, src: 'закон' }); }
          }
        }

        if (allDocs.length > 0) {
          // Для режима 3 — акцент на практике, для режима 1 — на законодательстве
          const topDocs = modeNum === 3
            ? allDocs.slice(0, 7)   // больше документов для анализа практики
            : allDocs.slice(0, 5);

          console.log('ГАРАНТ итого документов:', topDocs.length,
            '| практика:', topDocs.filter(d => d.src === 'практика').length,
            '| законы:', topDocs.filter(d => d.src === 'закон').length);

          const instruction = modeNum === 3
            ? 'Найдены документы из базы ГАРАНТ. Используй судебные акты для анализа практики. Обязательно ссылайся на конкретные документы в формате [Название](ссылка).'
            : 'Найдены документы из базы ГАРАНТ. Ссылайся на релевантные нормы в формате [Название](ссылка).';

          garantContext = '\n\n─── ДОКУМЕНТЫ ИЗ БАЗЫ ГАРАНТ ───\n' + instruction + '\n\n' +
            topDocs.map((doc, i) => {
              const tag = doc.src === 'практика' ? '[Судебная практика]' : '[Законодательство]';
              return `${i + 1}. ${tag} ${doc.name}\n   Ссылка: https://internet.garant.ru${doc.url}`;
            }).join('\n\n');
        }
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
          model: 'claude-sonnet-4-5',
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
  res.json({
    total: analytics.totalRequests,
    today: analytics.todayRequests,
    todayDate: analytics.todayDate,
    uniqueTotal: analytics.uniqueIPs.size,
    uniqueToday: analytics.todayIPs.size,
    modes: analytics.modeStats,
    plans: analytics.planStats,
    recent: analytics.recentQueries.slice(0, 20)
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
