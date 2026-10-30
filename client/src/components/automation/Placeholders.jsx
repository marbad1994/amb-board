// Shows {{placeholders}} in running text as small tinted chips, so they are easy to tell apart without a code font.
export default function Placeholders({ text }) {
  return String(text ?? '').split(/(\{\{[^{}]+\}\})/g).map((part, i) => (/^\{\{[^{}]+\}\}$/.test(part) ? <span key={i} className="ab-ph">{part}</span> : part));
}
