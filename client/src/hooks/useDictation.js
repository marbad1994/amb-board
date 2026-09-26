import { useCallback, useRef, useState } from 'react';
import { api } from '../api/client.js';

const LANG_LOCALES = {
  en: 'en-US',
  ro: 'ro-RO',
  sv: 'sv-SE',
};

const SpeechRecognitionImpl =
  typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

export function useDictation({ onResult, translate = true }) {
  const [listening, setListening] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [error, setError] = useState('');
  const recognitionRef = useRef(null);

  const supported = !!SpeechRecognitionImpl;

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const start = useCallback(
    (lang = 'en') => {
      if (!supported) {
        setError('Voice dictation is not supported in this browser.');
        return;
      }
      setError('');
      const recognition = new SpeechRecognitionImpl();
      recognition.lang = LANG_LOCALES[lang] || LANG_LOCALES.en;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => setListening(true);
      recognition.onerror = (event) => {
        setError(event.error === 'not-allowed' ? 'Microphone access denied.' : `Dictation error: ${event.error}`);
        setListening(false);
      };
      recognition.onend = () => setListening(false);

      recognition.onresult = async (event) => {
        const transcript = Array.from(event.results)
          .map((r) => r[0].transcript)
          .join(' ')
          .trim();
        if (!transcript) return;

        if (lang === 'en' || !translate) {
          onResult(transcript, { translated: false });
          return;
        }

        setTranslating(true);
        try {
          const result = await api.translate(transcript, lang);
          onResult(result.text, { translated: result.translated, warning: result.warning });
        } catch (err) {
          setError(err.message);
          onResult(transcript, { translated: false });
        } finally {
          setTranslating(false);
        }
      };

      recognitionRef.current = recognition;
      recognition.start();
    },
    [onResult, supported, translate]
  );

  return { start, stop, listening, translating, error, supported };
}
