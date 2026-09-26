import { Router } from 'express';

const router = Router();

const LANGUAGE_NAMES = {
  en: 'English',
  ro: 'Romanian',
  sv: 'Swedish',
};

// POST /api/translate  { text, sourceLang }  -> { text, translated, sourceLang }
router.post('/', async (req, res) => {
  const { text, sourceLang } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });

  const source = LANGUAGE_NAMES[sourceLang] || 'the source language';

  if (sourceLang === 'en') {
    return res.json({ text: text.trim(), translated: false, sourceLang: 'en' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.json({
      text: text.trim(),
      translated: false,
      sourceLang: sourceLang || 'unknown',
      warning: 'ANTHROPIC_API_KEY is not configured on the server; text was left untranslated.',
    });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system:
          'You are a translation engine. Translate the user text from ' +
          source +
          ' into natural, fluent English. Respond with ONLY the translated text, no preamble, no quotes, no explanation.',
        messages: [{ role: 'user', content: text.trim() }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Translate API error:', response.status, errText);
      return res.status(502).json({ error: 'translation service error', detail: errText });
    }

    const data = await response.json();
    const translated = data.content?.[0]?.text?.trim() || text.trim();
    res.json({ text: translated, translated: true, sourceLang: sourceLang || 'unknown' });
  } catch (err) {
    console.error('Translate error:', err);
    res.status(502).json({ error: 'translation service unreachable' });
  }
});

export default router;
