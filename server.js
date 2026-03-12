const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();

// Доверяем прокси Railway
app.set('trust proxy', 1);

// Разрешаем запросы с любого домена (включая GetCourse)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.options('*', cors());

app.use(express.json({ limit: '10mb' }));

// ─── ЛИМИТЫ ЗАПРОСОВ ────────────────────────────────────────────────
// 10 запросов в минуту на одного пользователя
const perMinuteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Превышен лимит: не более 10 запросов в минуту.' }
});

// 30 запросов в сутки на одного пользователя
const perDayLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 30,
  message: { error: 'Превышен дневной лимит: не более 30 запросов в сутки.' }
});

// ─── ОБЩИЙ СИСТЕМНЫЙ ПРОМПТ (применяется ко всем режимам) ───────────
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

Пример мягкой рекомендации:
«Кстати, если вас интересует развитие навыков в этой теме — [название продукта] может быть полезен: [ссылка]»

ВАЖНО: не упоминай продукты если тема запроса не связана с ними. Не рекламируй навязчиво.`;

// ─── СИСТЕМНЫЕ ПРОМПТЫ ДЛЯ 6 РЕЖИМОВ ───────────────────────────────
const systemPrompts = {
  1: `Ты — ИИ-помощник процессуалиста. Режим: Анализ и структурирование правовой позиции.

Структура ответа:
1. Нейтральное резюме фактических обстоятельств
2. Возможные варианты правовой квалификации
3. Структура правовой позиции по логическим блокам
4. Сильные стороны позиции
5. Потенциально уязвимые места
6. Вопросы и аспекты, требующие уточнения или проверки

Работай только с предоставленным текстом. Не выдумывай факты. Не давай категоричных прогнозов исхода дела. Используй нейтральные формулировки. Работай исключительно в рамках законодательства РФ. Объём ответа — не более 1000 слов.`,

  2: `Ты — ИИ-помощник процессуалиста. Режим: Подготовка и доработка процессуальных документов.

Структура ответа:
1. Общая оценка логики документа
2. Сильные стороны текста
3. Логические разрывы и перегруженные фрагменты
4. Рекомендации по улучшению структуры
5. Точечные предложения по формулировкам (без изменения сути)

НЕ меняй правовой смысл, условия, сроки, суммы, ссылки на нормы. НЕ добавляй новые факты. Сохраняй нумерацию исходного текста. Объём ответа — не более 1000 слов.`,

  3: `Ты — ИИ-помощник процессуалиста. Режим: Анализ позиции оппонента и контраргументы.

Структура ответа:
1. Пересказ позиции оппонента в нейтральной форме
2. Логические уязвимости
3. Возможные правовые противоречия
4. Недостаточность доказательственной базы
5. Вопросы и направления для возражений
6. Аспекты, требующие дополнительной проверки

Без обвинительного тона. Без прогнозов исхода дела. Объём ответа — не более 1000 слов.`,

  4: `Ты — ИИ-помощник процессуалиста. Режим: Подготовка к судебному заседанию.

Структура ответа:
1. Ключевые вопросы, которые могут возникнуть у суда
2. Вопросы к оппоненту
3. Вопросы к доказательствам
4. Потенциально сложные моменты заседания
5. Точки особого контроля

Без советов по поведению в суде. Без прогнозов реакции суда. Объём ответа — не более 1000 слов.`,

  5: `Ты — ИИ-помощник процессуалиста. Режим: Анализ судебной практики.

Структура ответа:
1. Обобщение представленных судебных актов
2. Подходы судов
3. Факторы и обстоятельства, ставшие ключевыми для принятия решения
4. Условия применимости выводов к текущему спору
5. Риски некорректного использования практики

Не используй вымышленные судебные акты. Работай только с предоставленными материалами. Объём ответа — не более 1000 слов.`,

  6: `Ты — ИИ-помощник процессуалиста. Режим: Юридический стресс-тест позиции или документа.

Структура ответа:
1. Потенциальные фактические риски
2. Логические уязвимости
3. Риски доказательственной базы
4. Правовые неопределённости
5. Процессуальные риски
6. Рекомендации по усилению и проверке

Конструктивный и нейтральный тон. Приоритизация рисков. Объём ответа — не более 1000 слов.`
};

// ─── КЕШ ДЛЯ ГАРАНТ ЗАПРОСОВ ────────────────────────────────────────
const garantCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 час

// ─── ГАРАНТ API — ПОИСК ДОКУМЕНТОВ ─────────────────────────────────
async function searchGarant(query) {
  try {
    const token = process.env.GARANT_TOKEN;
    if (!token) {
      console.log('ГАРАНТ: токен не найден');
      return null;
    }

    const cacheKey = query.trim().toLowerCase();
    const cached = garantCache.get(cacheKey);
    if (cached && Date.now() - cached.time < CACHE_TTL) {
      console.log('ГАРАНТ: из кеша');
      return cached.data;
    }

    const requestBody = { text: query, page: 1, env: 'internet', sort: 0, sortOrder: 0 };
    console.log('ГАРАНТ запрос:', JSON.stringify(requestBody));

    const response = await fetch('https://api.garant.ru/v2/search', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(requestBody)
    });

    console.log('ГАРАНТ статус:', response.status, response.statusText);
    const rawText = await response.text();
    console.log('ГАРАНТ ответ:', rawText.slice(0, 500));

    if (!response.ok) return null;

    const data = JSON.parse(rawText);
    const docs = data.documents || [];
    console.log('ГАРАНТ документов найдено:', docs.length);

    garantCache.set(cacheKey, { data: docs, time: Date.now() });
    if (garantCache.size > 500) {
      garantCache.delete(garantCache.keys().next().value);
    }

    return docs;
  } catch (err) {
    console.error('ГАРАНТ исключение:', err.message);
    return null;
  }
}

// ─── ОСНОВНОЙ МАРШРУТ ────────────────────────────────────────────────
app.post('/api/chat', perDayLimiter, perMinuteLimiter, async (req, res) => {
  const { messages, mode, file } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Некорректный запрос: отсутствуют сообщения.' });
  }

  const modeNum = parseInt(mode) || 1;
  const modePrompt = systemPrompts[modeNum] || systemPrompts[1];

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    let finalMessages = [...messages];
    let extractedFileText = null;

    // Если прикреплён docx или pdf — извлекаем текст
    if (file && file.base64 && file.ext) {
      const buffer = Buffer.from(file.base64, 'base64');
      const lastMsg = finalMessages[finalMessages.length - 1];

      if (file.ext === 'pdf') {
        finalMessages[finalMessages.length - 1] = {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: file.base64 }
            },
            { type: 'text', text: lastMsg.content || 'Проанализируй этот документ' }
          ]
        };
        extractedFileText = '[PDF документ]';
      } else if (file.ext === 'docx') {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ buffer });
        extractedFileText = result.value || '';
        finalMessages[finalMessages.length - 1] = {
          role: 'user',
          content: `${lastMsg.content || 'Проанализируй документ'}\n\n[Файл: ${file.name}]\n\n${extractedFileText}`
        };
      }
    }

    // ─── ПОИСК В ГАРАНТ (только режимы 1 и 5) ───────────────────────
    let garantContext = '';
    console.log('Режим запроса:', modeNum, '| ГАРАНТ активен:', modeNum === 1 || modeNum === 5);
    if (modeNum === 1 || modeNum === 5) {
      const lastUserMessage = finalMessages[finalMessages.length - 1];
      const queryText = typeof lastUserMessage.content === 'string'
        ? lastUserMessage.content
        : lastUserMessage.content?.[lastUserMessage.content.length - 1]?.text || '';

      // Формируем короткую поисковую фразу для ГАРАНТа (до 60 символов)
      // Убираем вопросительные слова и берём суть
      const stopWords = ['как', 'что', 'где', 'когда', 'зачем', 'почему', 'какова', 'каков', 'правомерен', 'ли', 'и', 'в', 'на', 'по', 'с', 'о', 'а', 'но'];
      const words = queryText.trim().split(/\s+/)
        .filter(w => w.length > 3 && !stopWords.includes(w.toLowerCase()))
        .slice(0, 5)
        .join(' ');
      const searchPhrase = words.slice(0, 80);
      console.log('ГАРАНТ поисковая фраза:', searchPhrase);
      const garantDocs = await searchGarant(searchPhrase);

      if (garantDocs && garantDocs.length > 0) {
        garantContext = '\n\n─── ДОКУМЕНТЫ ИЗ БАЗЫ ГАРАНТ ───\n' +
          'Следующие документы найдены в правовой базе ГАРАНТ и могут быть релевантны запросу.\n' +
          'При необходимости ссылайся на них в ответе:\n\n' +
          garantDocs.map((doc, i) =>
            `${i + 1}. ${doc.name}\n   Ссылка: https://internet.garant.ru${doc.url}`
          ).join('\n\n');
      }
    }

    const fullSystemPrompt = globalPrompt + '\n\n' + modePrompt + garantContext;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: fullSystemPrompt,
      messages: finalMessages
    });

    const reply = response.content?.[0]?.text || 'Не удалось получить ответ.';
    res.json({ reply, extractedText: extractedFileText || null });

  } catch (err) {
    console.error('Ошибка Claude API:', err.message);
    res.status(500).json({ error: 'Ошибка сервера: ' + err.message });
  }
});

// ─── ПРОВЕРКА РАБОТОСПОСОБНОСТИ ──────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Сервер ИИ-помощника работает.' });
});

// ─── ЗАПУСК ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
