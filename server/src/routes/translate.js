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

  const apiKey = process.env.X_GROK_API_KEY;
  if (!apiKey) {
    return res.json({
      text: text.trim(),
      translated: false,
      sourceLang: sourceLang || 'unknown',
      warning: 'X_GROK_API_KEY is not configured on the server; text was left untranslated.',
    });
  }

  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-4',
        messages: [
          {
            role: 'system',
            content:
              'You are a translation engine. Translate the user text from ' +
              source +
              ' into natural, fluent English. Respond with ONLY the translated text, no preamble, no quotes, no explanation.',
          },
          { role: 'user', content: text.trim() },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Translate API error:', response.status, errText);
      return res.status(502).json({ error: 'translation service error', detail: errText });
    }

    const data = await response.json();
    const translated = data.choices?.[0]?.message?.content?.trim() || text.trim();
    res.json({ text: translated, translated: true, sourceLang: sourceLang || 'unknown' });
  } catch (err) {
    console.error('Translate error:', err);
    res.status(502).json({ error: 'translation service unreachable' });
  }
});

export default router;
