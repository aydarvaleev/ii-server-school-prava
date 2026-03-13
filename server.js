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

// ─── ЛИМИТЫ ──────────────────────────────────────────────────────────
const perMinuteLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: { error: 'Превышен лимит: не более 10 запросов в минуту.' }
});
const perDayLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, max: 30,
  message: { error: 'Превышен дневной лимит: не более 30 запросов в сутки.' }
});

const MAX_TEXT_CHARS = 100000; // ~70 страниц

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

ЗАПРЕТ НА ГАЛЛЮЦИНАЦИИ О НОРМАХ ПРАВА:
- НИКОГДА не утверждай что какая-либо статья, норма или закон не существует, если ты не уверен на 100%.
- Если не можешь найти норму — напиши: «Рекомендую проверить актуальную редакцию в правовой базе (ГАРАНТ, КонсультантПлюс)».
- Помни: в кодексах РФ нумерация статей может быть нелинейной (статьи 186.1, 186.2 и т.д.), статьи могут быть добавлены или изменены.`;

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
1. Обобщение представленных судебных актов
2. Подходы судов
3. Факторы и обстоятельства, ставшие ключевыми для принятия решения
4. Условия применимости выводов к текущему спору
5. Риски некорректного использования практики

Не используй вымышленные судебные акты. Работай только с предоставленными материалами. Объём ответа — не более 1000 слов.`
};

// ─── КЕШ ГАРАНТ ──────────────────────────────────────────────────────
const garantCache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

async function searchGarant(query) {
  try {
    const token = process.env.GARANT_TOKEN;
    if (!token) return null;

    const cacheKey = query.trim().toLowerCase();
    const cached = garantCache.get(cacheKey);
    if (cached && Date.now() - cached.time < CACHE_TTL) return cached.data;

    const response = await fetch('https://api.garant.ru/v2/search', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ text: query, page: 1, env: 'internet', sort: 0, sortOrder: 0 })
    });

    if (!response.ok) return null;
    const data = JSON.parse(await response.text());
    const docs = data.documents || [];
    console.log('ГАРАНТ найдено:', docs.length);

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
app.post('/api/chat', perDayLimiter, perMinuteLimiter, async (req, res) => {
  const { messages, mode, file, file2, compareMode } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Некорректный запрос.' });
  }

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
        if (extractedText.length > MAX_TEXT_CHARS) extractedText = extractedText.slice(0, MAX_TEXT_CHARS);
        finalMessages[finalMessages.length - 1] = {
          role: 'user',
          content: `${lastMsg.content || 'Проанализируй документ'}\n\n[Файл: ${file.name}]\n\n${extractedText}`
        };
      }
    }

    // ─── ГАРАНТ ──────────────────────────────────────────────────────
    let garantContext = '';
    if (modeNum === 1 || modeNum === 3) {
      const lastUserMessage = finalMessages[finalMessages.length - 1];
      const queryText = typeof lastUserMessage.content === 'string'
        ? lastUserMessage.content
        : lastUserMessage.content?.[lastUserMessage.content.length - 1]?.text || '';

      const stopWords = ['как', 'что', 'где', 'когда', 'зачем', 'почему', 'какова', 'каков', 'правомерен', 'ли', 'и', 'в', 'на', 'по', 'с', 'о', 'а', 'но'];
      const words = queryText.trim().split(/\s+/)
        .filter(w => w.length > 3 && !stopWords.includes(w.toLowerCase()))
        .slice(0, 5).join(' ');
      const searchPhrase = words.slice(0, 80);

      if (searchPhrase) {
        const garantDocs = await searchGarant(searchPhrase);
        if (garantDocs && garantDocs.length > 0) {
          garantContext = '\n\n─── ДОКУМЕНТЫ ИЗ БАЗЫ ГАРАНТ ───\n' +
            'Следующие документы найдены в правовой базе ГАРАНТ. Обязательно укажи ссылки на релевантные документы в своём ответе в формате: [Название документа](ссылка)\n\n' +
            garantDocs.slice(0, 5).map((doc, i) =>
              `${i + 1}. ${doc.name}\n   Ссылка: https://internet.garant.ru${doc.url}`
            ).join('\n\n');
        }
      }
    }

    const fullSystemPrompt = globalPrompt + '\n\n' + modePrompt + garantContext;

    // ─── СТРИМИНГ ────────────────────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: fullSystemPrompt,
      messages: finalMessages
    });

    stream.on('text', (text) => {
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    });

    stream.on('error', (err) => {
      console.error('Stream error:', err.message);
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    });

    stream.on('finalMessage', () => {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    });

  } catch (err) {
    console.error('Ошибка:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Ошибка сервера: ' + err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
