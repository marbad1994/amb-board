import dns from 'node:dns/promises';
import { mailConfig } from './config.js';

// Tests replace these; production uses the system resolver.
export const resolver = { txt: (n) => dns.resolveTxt(n), mx: (n) => dns.resolveMx(n) };
const safe = async (fn, name) => { try { return await fn(name); } catch { return []; } };
export const txtOf = async (name) => (await safe(resolver.txt, name)).map((chunks) => chunks.join(''));
export const mxOf = async (name) => (await safe(resolver.mx, name)).sort((a, b) => a.priority - b.priority).map((m) => String(m.exchange).toLowerCase().replace(/\.$/, ''));

export const verifyName = (domain) => `_amb-mail.${domain}`;
export const verifyValue = (token) => `amb-mail-verification=${token}`;
export async function checkOwnership(domain, token) {
  const found = await txtOf(verifyName(domain));
  return { ok: found.includes(verifyValue(token)), found };
}

// The records the domain needs, and what DNS says now. status: ok | missing | mismatch.
export async function checkRecords(d) {
  const c = mailConfig(); const host = c.host || 'MAIL_HOST-not-set';
  const dkimName = `${d.dkim_selector}._domainkey.${d.domain}`;
  const [mx, rootTxt, dkimTxt, dmarcTxt] = await Promise.all([mxOf(d.domain), txtOf(d.domain), txtOf(dkimName), txtOf(`_dmarc.${d.domain}`)]);
  const spfs = rootTxt.filter((t) => /^v=spf1\b/i.test(t));
  const spfOk = spfs.some((t) => /\bmx\b/.test(t) || (c.ip && t.includes(`ip4:${c.ip}`)) || t.includes(`a:${host}`));
  const dkimOk = dkimTxt.some((t) => t.replace(/\s+/g, '').includes(`p=${d.dkim_public}`));
  return [
    { key: 'mx', type: 'MX', name: d.domain, value: `10 ${host}.`, status: mx.includes(host) ? 'ok' : mx.length ? 'mismatch' : 'missing', found: mx,
      note: mx.length && !mx.includes(host) ? `Mail for ${d.domain} is delivered to ${mx.join(', ')} today. Changing this record moves ALL mail for the domain to this server, including mailboxes you have somewhere else.` : 'Where other servers deliver mail for this domain.' },
    { key: 'spf', type: 'TXT', name: d.domain, value: `v=spf1 mx${c.ip ? ` ip4:${c.ip}` : ''} ~all`, status: spfOk ? 'ok' : spfs.length ? 'mismatch' : 'missing', found: spfs,
      note: spfs.length && !spfOk ? 'There is already an SPF record. A domain may have only one: add this server to it instead of adding a second record.' : 'Says which servers may send mail for the domain.' },
    { key: 'dkim', type: 'TXT', name: dkimName, value: `v=DKIM1; k=rsa; p=${d.dkim_public}`, status: dkimOk ? 'ok' : dkimTxt.length ? 'mismatch' : 'missing', found: dkimTxt.map((t) => t.slice(0, 60)),
      note: 'The signature that proves mail from this domain was not altered.' },
    { key: 'dmarc', type: 'TXT', name: `_dmarc.${d.domain}`, value: `v=DMARC1; p=none; rua=mailto:postmaster@${d.domain}`, status: dmarcTxt.some((t) => /^v=DMARC1/i.test(t)) ? 'ok' : 'missing', found: dmarcTxt,
      note: 'Tells receivers what to do with mail that fails the checks. Start with p=none and tighten it later.' },
  ];
}
