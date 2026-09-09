import { publicTarget } from "./browser-proxy.ts";

/** Identity-only consent. Extra Google product scopes must never be auto-approved. */
export function googleIdentityRequest(raw: string, domain: string): boolean {
  try {
    let url = publicTarget(raw);
    for (let depth = 0; depth < 3; depth++) {
      if (url.origin !== "https://accounts.google.com") return false;
      const redirect = url.searchParams.get("redirect_uri"), scope = url.searchParams.get("scope");
      if (redirect && scope) {
        const destination = publicTarget(redirect);
        const scopes = scope.split(/\s+/).filter(Boolean);
        return destination.protocol === "https:" && !destination.port && (destination.hostname === domain || destination.hostname.endsWith(`.${domain}`)) &&
          scopes.length > 0 && scopes.every(s => ["openid", "email", "profile", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"].includes(s));
      }
      const next = url.searchParams.get("continue");
      if (!next) return false;
      url = publicTarget(next);
    }
  } catch { /* A query string is never authority by itself. */ }
  return false;
}
export const googleEntryExpression = (origin: string, click: boolean) => `(() => {
  if(location.origin!==${JSON.stringify(origin)}||location.protocol!=='https:')return 0;
  const name=e => e.getAttribute('aria-label') || (e.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent || '').join(' ') || e.innerText || '';
  const entries=[...document.querySelectorAll('a,button,[role="button"]')].filter(e=>e.getClientRects().length&&!e.matches(':disabled')&&!e.closest('[inert],[aria-hidden="true"],[aria-disabled="true"]')&&getComputedStyle(e).visibility==='visible'&&/^(continue|sign[ -]?in|log[ -]?in) with google$/i.test(name(e).trim().replace(/\\s+/g,' ')));
  if(entries.length===1&&${click})entries[0].click();return entries.length;
})()`;
export const googleAccountExpression = (identity: string, click: boolean, href: string) => `(() => {
  if(location.href!==${JSON.stringify(href)}||location.origin!=='https://accounts.google.com'||document.querySelector('input[type="password"],input[autocomplete="one-time-code"]'))return 0;
  const entries=[...document.querySelectorAll('[data-identifier]')].filter(e=>e.getClientRects().length&&e.getAttribute('data-identifier')?.toLowerCase()===${JSON.stringify(identity)});
  if(entries.length===1&&${click})entries[0].click();return entries.length;
})()`;
export const googleConsentExpression = (nonce: string, approve: boolean) => `(() => {
  if(location.origin!=='https://accounts.google.com'||document.querySelector('input[type="password"],input[autocomplete="one-time-code"]'))return false;
  const controls=[...document.querySelectorAll('button,input[type="submit"]')].filter(e=>e.getClientRects().length&&!e.disabled&&/^(continue|allow)$/i.test((e.innerText||e.value||'').trim()));
  if(controls.length!==1||!/(wants (?:access|to)|share|sign in to|continue to)/i.test(document.body.innerText))return false;
  if(${approve}) { if(window.__unlockConsent?.id!==${JSON.stringify(nonce)}||window.__unlockConsent?.href!==location.href||window.__unlockConsent?.button!==controls[0])return false;delete window.__unlockConsent;controls[0].click(); }
  else window.__unlockConsent={id:${JSON.stringify(nonce)},href:location.href,button:controls[0]};
  return true;
})()`;
