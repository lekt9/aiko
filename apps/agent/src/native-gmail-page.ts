import { GMAIL_DOMAIN, GMAIL_URL } from "../../../packages/protocol/src/google-connection.ts";
import type { PrivateCdp } from "./native-login.ts";
import { publicTarget } from "./browser-proxy.ts";

/** All expressions/results in this module stay inside the credential-owning VM.
 * Gmail account controls, not mail content, identify the selected mailbox. */
export const gmailIdentityExpression = `(() => {
  if(location.origin !== 'https://mail.google.com') return null;
  const emails=[...document.querySelectorAll('a[aria-label],button[aria-label]')]
    .filter(e=>/^Google Account:/i.test(e.getAttribute('aria-label')||''))
    .flatMap(e=>(e.getAttribute('aria-label')||'').match(/[A-Z0-9.!#$%&'*+\\/=?^_\x60{|}~-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/ig)||[]);
  const unique=[...new Set(emails.map(e=>e.toLowerCase()))];return unique.length===1?unique[0]:null;
})()`;
export const privateEmailIdentity = (value: unknown): value is string => typeof value === "string" && value.length <= 320 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);
export interface PrivateEmailRequest { key: string; value: string }
/** Websites must expose an opaque current request identifier, also present in
 * their signed email/link. Time and recipient alone cannot disambiguate an
 * attacker requesting a second sign-in for the same person. */
export const emailRequestExpression = `(() => {
  const fields=[...document.querySelectorAll('input[type="hidden"]')].filter(e=>['state','request_id','challenge_id','transaction_id'].includes(e.name)&&/^[A-Za-z0-9._~-]{16,256}$/.test(e.value));
  const unique=[...new Map(fields.map(e=>[e.name+':'+e.value,{key:e.name,value:e.value}])).values()];return unique.length===1?unique[0]:null;
})()`;
export const authenticatedIdentityExpression = `(() => {
  const controls=[...document.querySelectorAll('[data-testid="account-menu"],[data-testid="user-menu"],[aria-label^="Account"],[aria-label^="User"],.account-menu,.user-menu')].filter(e=>e.getClientRects().length);
  const emails=controls.flatMap(e=>[e.innerText,e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('data-email'),e.getAttribute('data-user-email')].filter(Boolean).join(' ').match(/[A-Z0-9.!#$%&'*+\\/=?^_\x60{|}~-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/ig)||[]);
  const unique=[...new Set(emails.map(e=>e.toLowerCase()))];return unique.length===1?unique[0]:null;
})()`;
export interface PrivateLoginEmail { from: string; to: string[]; signedBy: string; date: number; text: string; links: { text: string; href: string }[] }
export type LoginEmailResult = { status: "waiting_email" | "ambiguous" | "unsupported" } | { status: "found"; value: string };
/** Signed-by is Gmail's authenticated message-header UI, not text from the mail.
 * Selection is conservative: one fresh, addressed, authenticated message/value. */
export function selectLoginEmail(message: PrivateLoginEmail, input: { identity: string; domain: string; after: number; method: "email_code" | "email_link"; request: PrivateEmailRequest }, now = Date.now()): LoginEmailResult {
  const ownHost = (host: string) => host === input.domain || host.endsWith(`.${input.domain}`);
  if (!privateEmailIdentity(message.from) || !ownHost(message.from.split("@")[1]!.toLowerCase()) || !ownHost(message.signedBy.toLowerCase()) ||
      !message.to.some(to => to.toLowerCase() === input.identity.toLowerCase()) || !Number.isFinite(message.date) || message.date < input.after || message.date > now + 30_000 ||
      message.text.length > 64_000 || !/sign[ -]?in|log[ -]?in|verification code|one[ -]?time code/i.test(message.text) || /reset (?:your )?password|password reset|change (?:your )?password/i.test(message.text)) return { status: "unsupported" };
  if (!/^[A-Za-z0-9._~-]{16,256}$/.test(input.request.value) || !["state", "request_id", "challenge_id", "transaction_id"].includes(input.request.key)) return { status: "unsupported" };
  const bound = message.text.includes(input.request.value) || message.links.some(link => {
    try { const url = publicTarget(link.href); return url.protocol === "https:" && ownHost(url.hostname) && url.searchParams.get(input.request.key) === input.request.value; } catch { return false; }
  });
  if (!bound) return { status: "unsupported" };
  const values = input.method === "email_code"
    ? [...message.text.replaceAll(input.request.value, "").matchAll(/(?:^|\D)([0-9]{4,10})(?!\d)/g)].map(match => match[1]!)
    : message.links.filter(link => /sign[ -]?in|log[ -]?in|verify (?:and|to) (?:sign|log)/i.test(link.text)).flatMap(link => {
        try {
          const url = publicTarget(link.href);
          return url.protocol === "https:" && !url.port && url.href.length <= 2048 && ownHost(url.hostname) && url.searchParams.get(input.request.key) === input.request.value && !/reset|unsubscribe|delete|change.password/i.test(url.pathname) ? [url.href] : [];
        } catch { return []; }
      });
  const unique = [...new Set(values)];
  return unique.length === 1 ? { status: "found", value: unique[0]! } : { status: unique.length ? "ambiguous" : "unsupported" };
}

export async function confirmGmailIdentity(cdp: PrivateCdp, sessionId: string, identity: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  await cdp.send("Page.navigate", { url: GMAIL_URL }, sessionId);
  for (let n = 0; n < 40; n++) {
    await new Promise(resolve => setTimeout(resolve, 200)); signal?.throwIfAborted();
    const result = await cdp.send("Runtime.evaluate", { expression: gmailIdentityExpression, returnByValue: true }, sessionId);
    if (privateEmailIdentity(result.result?.value)) return result.result.value === identity;
  }
  return false;
}

/** Read through Gmail's first-party UI. No undocumented API or OAuth assumption.
 * Unsupported/localized headers fail closed rather than trusting message text. */
export async function readGmailLoginEmail(cdp: PrivateCdp, sessionId: string, input: { identity: string; domain: string; after: number; method: "email_code" | "email_link"; request: PrivateEmailRequest }, signal?: AbortSignal): Promise<LoginEmailResult> {
  const evaluate = async (expression: string) => {
    signal?.throwIfAborted();
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw Error("Private Gmail inspection failed");
    return result.result?.value;
  };
  const pause = async () => { await new Promise(resolve => setTimeout(resolve, 200)); signal?.throwIfAborted(); };
  const query = `in:inbox to:${input.identity} from:(@${input.domain}) after:${Math.floor(input.after / 1000)}`;
  await cdp.send("Page.navigate", { url: `${GMAIL_URL}#search/${encodeURIComponent(query)}` }, sessionId);
  for (let n = 0; n < 40; n++) {
    await pause();
    if (await evaluate(gmailIdentityExpression) !== input.identity) continue;
    const count = await evaluate(`location.origin === 'https://${GMAIL_DOMAIN}' ? [...document.querySelectorAll('tr.zA')].filter(e=>e.getClientRects().length).length : -1`);
    if (count > 1) return { status: "ambiguous" };
    if (count === 1) break;
    if (n === 39) return { status: "waiting_email" };
  }
  if (await evaluate(gmailIdentityExpression) !== input.identity) return { status: "unsupported" };
  const opened = await evaluate(`(() => { if(location.origin !== 'https://${GMAIL_DOMAIN}') return false; const rows=[...document.querySelectorAll('tr.zA')].filter(e=>e.getClientRects().length);if(rows.length!==1)return false;rows[0].click();return true;})()`);
  if (!opened) return { status: "ambiguous" };
  let message: PrivateLoginEmail | undefined;
  for (let n = 0; n < 40; n++) {
    await pause();
    if (await evaluate(gmailIdentityExpression) !== input.identity) return { status: "unsupported" };
    // Open authenticated header details, never an action/link inside the message.
    await evaluate(`(() => {const controls=[...document.querySelectorAll('[aria-label="Show details"],[data-tooltip="Show details"]')].filter(e=>!e.closest('.a3s')&&e.getClientRects().length);if(controls.length===1)controls[0].click();})()`);
    message = await evaluate(`(() => {
      if(location.origin!=='https://${GMAIL_DOMAIN}')return null;
      const bodies=[...document.querySelectorAll('.adn .a3s')].filter(e=>e.getClientRects().length);
      if(bodies.length!==1)return null;const body=bodies[0], container=body.closest('.adn');
      const rows=[...document.querySelectorAll('tr')].filter(e=>!e.closest('.a3s')&&e.getClientRects().length);
      const header=name=>{const matches=rows.filter(r=>(r.cells[0]?.innerText||'').trim().toLowerCase()===name+':');return matches.length===1?(matches[0].cells[1]?.innerText||'').trim():'';};
      const addresses=value=>value.match(/[A-Z0-9.!#$%&'*+\\/=?^_\x60{|}~-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/ig)||[];
      const from=addresses(header('from'));const to=addresses(header('to'));
      const signedBy=header('signed-by').toLowerCase();const date=Date.parse(header('date').replace(/[\\u00a0\\u202f]/g,' '));
      if(from.length!==1||!to.length||!signedBy||!Number.isFinite(date))return null;
      return {from:from[0],to,signedBy,date,text:body.innerText.slice(0,64001),links:[...body.querySelectorAll('a[href]')].slice(0,32).map(a=>({text:(a.innerText||'').slice(0,120),href:a.href.slice(0,2049)}))};
    })()`);
    if (message) break;
  }
  return message ? selectLoginEmail(message, input) : { status: "unsupported" };
}
