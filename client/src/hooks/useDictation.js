import { useCallback, useRef, useState } from 'react';
import { api } from '../api/client.js';

// The Web Speech API has no built-in "detect any language" mode — recognition.lang
// must be set per session for decent accuracy. To auto-detect among our supported
// languages without a manual picker, we race one recognizer per candidate locale
// against the same utterance and keep whichever produced the highest-confidence result.
const CANDIDATES = [
  { code: 'en', locale: 'en-US' },
  { code: 'ro', locale: 'ro-RO' },
  { code: 'sv', locale: 'sv-SE' },
];

const SpeechRecognitionImpl =
  typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

export function useDictation({ onResult, translate = true }) {
  const [listening, setListening] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [error, setError] = useState('');
  const recognizersRef = useRef([]);

  const supported = !!SpeechRecognitionImpl;

  const stop = useCallback(() => {
    recognizersRef.current.forEach((r) => {
      try {
        r.stop();
      } catch {
        // already stopped
      }
    });
  }, []);

  const start = useCallback(() => {
    if (!supported) {
      setError('Voice dictation is not supported in this browser.');
      return;
    }
    setError('');
    setListening(true);

    const candidates = [];
    let ended = 0;
    let settled = false;
    let deniedCount = 0;

    const finish = async () => {
      if (settled) return;
      settled = true;
      setListening(false);

      const heard = candidates.filter((c) => c.transcript);
      if (!heard.length) {
        if (deniedCount === CANDIDATES.length) setError('Microphone access denied.');
        return;
      }
      heard.sort((a, b) => b.confidence - a.confidence || b.transcript.length - a.transcript.length);
      const best = heard[0];

      if (best.code === 'en' || !translate) {
        onResult(best.transcript, { translated: false, detectedLang: best.code });
        return;
      }

      setTranslating(true);
      try {
        const result = await api.translate(best.transcript, best.code);
        onResult(result.text, { translated: result.translated, warning: result.warning, detectedLang: best.code });
      } catch (err) {
        setError(err.message);
        onResult(best.transcript, { translated: false, detectedLang: best.code });
      } finally {
        setTranslating(false);
      }
    };

    const onOneEnded = () => {
      ended += 1;
      if (ended === CANDIDATES.length) finish();
    };

    recognizersRef.current = CANDIDATES.map(({ code, locale }) => {
      const recognition = new SpeechRecognitionImpl();
      recognition.lang = locale;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      recognition.onresult = (event) => {
        const alt = event.results[0]?.[0];
        const transcript = alt?.transcript?.trim();
        if (transcript) candidates.push({ code, transcript, confidence: alt.confidence || 0 });
      };
      recognition.onerror = (event) => {
        if (event.error === 'not-allowed') deniedCount += 1;
      };
      recognition.onend = onOneEnded;

      try {
        recognition.start();
      } catch {
        onOneEnded();
      }
      return recognition;
    });
  }, [onResult, supported, translate]);

  return { start, stop, listening, translating, error, supported };
}
