import { useState } from 'react';
import { Mic, Square, Loader2 } from 'lucide-react';
import { useDictation } from '../hooks/useDictation.js';

const LANGUAGES = [
  { code: 'en', label: 'EN' },
  { code: 'ro', label: 'RO' },
  { code: 'sv', label: 'SV' },
];

export default function DictationButton({ onText, size = 'md' }) {
  const [lang, setLang] = useState('en');
  const { start, stop, listening, translating, error, supported } = useDictation({
    onResult: (text) => onText(text),
  });

  if (!supported) return null;

  return (
    <div className={`dictation dictation--${size}`}>
      <select
        className="dictation__lang"
        value={lang}
        onChange={(e) => setLang(e.target.value)}
        disabled={listening || translating}
        aria-label="Spoken language"
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={`dictation__mic ${listening ? 'is-listening' : ''}`}
        onClick={() => (listening ? stop() : start(lang))}
        disabled={translating}
        title={listening ? 'Stop dictation' : 'Start dictation (speak EN, RO or SV — output is English)'}
      >
        {translating ? (
          <Loader2 size={18} className="spin" />
        ) : listening ? (
          <Square size={16} />
        ) : (
          <Mic size={18} />
        )}
      </button>
      {error && <span className="dictation__error">{error}</span>}
    </div>
  );
}
