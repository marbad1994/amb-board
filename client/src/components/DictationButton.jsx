import { useState } from 'react';
import { Mic, Square, Loader2 } from 'lucide-react';
import { useDictation } from '../hooks/useDictation.js';

export default function DictationButton({ onText, translate = true }) {
  const [warning, setWarning] = useState('');
  const { start, stop, listening, translating, error, supported } = useDictation({
    translate,
    onResult: (text, meta) => {
      setWarning(meta?.warning || '');
      onText(text, meta);
    },
  });

  if (!supported) return null;

  return (
    <div className="dictation">
      <button
        type="button"
        className={`dictation__mic ${listening ? 'is-listening' : ''}`}
        onClick={() => {
          setWarning('');
          if (listening) stop();
          else start();
        }}
        disabled={translating}
        title={listening ? 'Stop dictation' : 'Start dictation — speak English, Romanian or Swedish, language is detected automatically'}
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
      {!error && warning && <span className="dictation__error">{warning}</span>}
    </div>
  );
}
