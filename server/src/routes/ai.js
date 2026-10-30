import { Router } from 'express';
import { db, parseLabels } from '../db.js';
import { sanitizeLabels } from './cards.js';
import { projectInWs } from '../access.js';

const router = Router();

const LANGUAGE_NAMES = {
  en: 'English',
  ro: 'Romanian',
  sv: 'Swedish',
};

function extractJson(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('No JSON object found in AI response');
  return JSON.parse(candidate.slice(start, end + 1));
}

// POST /api/ai/parse-task  { projectId, text, sourceLang }
// -> { available, title, description, owner, status, columnId, labels, sourceLang, translated }
router.post('/parse-task', async (req, res) => {
  const { projectId, text, sourceLang } = req.body;
  if (!projectId || !text || !text.trim()) {
    return res.status(400).json({ error: 'projectId and text are required' });
  }

  if (!projectInWs(projectId, req.ws.id)) return res.status(404).json({ error: 'not found' });
  const columns = db.prepare('SELECT id, name FROM columns WHERE project_id = ? ORDER BY position ASC').all(projectId);
  if (!columns.length) return res.status(404).json({ error: 'project has no columns' });

  const placeholders = columns.map(() => '?').join(',');
  const labelRows = db
    .prepare(`SELECT labels FROM cards WHERE column_id IN (${placeholders})`)
    .all(...columns.map((c) => c.id));
  const existingLabels = [...new Set(labelRows.flatMap((row) => parseLabels(row)))].slice(0, 30);

  const apiKey = process.env.X_GROK_API_KEY;
  if (!apiKey) {
    return res.json({
      available: false,
      warning: 'X_GROK_API_KEY is not configured on the server; the AI task helper is unavailable.',
    });
  }

  const knownSource = LANGUAGE_NAMES[sourceLang];
  const languageInstruction = knownSource
    ? `The text is in ${knownSource}.`
    : 'Detect which of English, Romanian or Swedish the text is written in.';
  const columnNames = columns.map((c) => c.name);

  const systemPrompt = `You are a task-intake assistant for a kanban board. The user will describe a task. ${languageInstruction} Extract a structured task and respond with ONLY a single JSON object (no markdown, no commentary) with exactly these keys:
{
  "title": "short English task title, max 8 words",
  "description": "fuller English description of what needs to be done, may be empty string",
  "owner": "the person's name responsible, in the casing the user used, or empty string if none mentioned",
  "column": "the single best-matching board column from this list: ${JSON.stringify(columnNames)} (default to the first one if unclear)",
  "labels": ["0 to 3 short single/two-word English tags capturing things like urgency, type of work, or theme. Reuse one of these existing labels when it fits: ${JSON.stringify(existingLabels)}. Otherwise invent a short, generic tag (e.g. \\"urgent\\", \\"bug\\", \\"design\\")."],
  "detectedLanguage": "one of: english, romanian, swedish"
}
Always translate every text field (title, description, owner, labels) to English, even if the input is Romanian or Swedish. Respond with raw JSON only.`;

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
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text.trim() },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('AI task parse error:', response.status, errText);
      return res.status(502).json({ error: 'AI task helper service error' });
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || '';
    let parsed;
    try {
      parsed = extractJson(raw);
    } catch (err) {
      console.error('AI task parse: could not parse JSON from response:', raw);
      return res.status(502).json({ error: 'AI task helper returned an unexpected response' });
    }

    const matchedColumn =
      columns.find((c) => c.name.toLowerCase() === String(parsed.column || '').toLowerCase()) || columns[0];

    const detected = String(parsed.detectedLanguage || '').toLowerCase();
    const detectedCode = Object.keys(LANGUAGE_NAMES).find((code) => LANGUAGE_NAMES[code].toLowerCase() === detected);
    const resolvedLang = knownSource ? sourceLang : detectedCode || 'unknown';

    res.json({
      available: true,
      title: String(parsed.title || '').trim().slice(0, 200) || text.trim().slice(0, 80),
      description: String(parsed.description || '').trim(),
      owner: String(parsed.owner || '').trim(),
      column: matchedColumn.name,
      columnId: matchedColumn.id,
      labels: sanitizeLabels(parsed.labels),
      sourceLang: resolvedLang,
      translated: resolvedLang !== 'en',
    });
  } catch (err) {
    console.error('AI task parse error:', err);
    res.status(502).json({ error: 'AI task helper service unreachable' });
  }
});

export default router;
