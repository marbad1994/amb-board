import { EMAIL_RE } from '../automations/spec.js';

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN_RE = new RegExp(`^(?=.{4,253}$)(?:${LABEL}\\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$`);
export const normalizeDomain = (v) => String(v ?? '').trim().toLowerCase().replace(/\.$/, '');
export const validDomain = (d) => DOMAIN_RE.test(d) && !/\.(local|localhost|internal|invalid|test|example)$/.test(d);

const LOCAL_RE = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;
export const normalizeLocal = (v) => String(v ?? '').trim().toLowerCase();
export const validLocal = (l) => LOCAL_RE.test(l) && !l.includes('..');
export const validEmail = (e) => EMAIL_RE.test(e) && e.length <= 254;
