/** These expressions run only inside the private page. No values or page text
 * leave the VM; callers receive field kinds or a discovered navigation address. */
export const nativeLoginFields = `(() => {
  const visible = e => e instanceof HTMLInputElement && !e.disabled && !e.readOnly && !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const inputs = [...document.querySelectorAll('input')].filter(visible);
  const label = e => [e.name,e.id,e.autocomplete,e.getAttribute('aria-label'),e.placeholder,...[...(e.labels || [])].map(l => l.textContent)].filter(Boolean).join(' ');
  const password = inputs.filter(e => e.type === 'password');
  const text = inputs.filter(e => ['text','email','tel','number'].includes(e.type));
  // Some identity screens label an OTP simply "Code", even with name="email".
  // Require verification instructions so coupon/postal fields stay unrelated.
  const verificationContext = !password.length && /(?:verification|security) code|code (?:we )?sent|check your (?:email|phone)|authenticator app/i.test(document.body?.innerText || '');
  const plainCode = e => [e.getAttribute('aria-label'),e.placeholder,...[...(e.labels || [])].map(l => l.textContent)].some(value => /^code$/i.test((value || '').trim()));
  const code = text.filter(e => /one-time-code|verification.?code|security.?code|passcode|(^|[\\s_-])(otp|pin)([\\s_-]|$)/i.test(label(e)) || (verificationContext && plainCode(e)));
  let username = text.filter(e => !code.includes(e) && (e.type === 'email' || /username|user.?name|email|e-mail|phone|loginfmt|identifier|session_key|(^|[\\s_-])login([\\s_-]|$)/i.test(label(e))));
  if (password.length === 1 && password[0].form) username = username.filter(e => e.form === password[0].form);
  if (!username.length && password.length === 1 && password[0].form) {
    const candidates = text.filter(e => !code.includes(e) && e.form === password[0].form && e.type === 'text' && !/search/i.test(label(e)));
    if (candidates.length === 1) username = candidates;
  }
  // A landing page's newsletter/search field is not a username-first login.
  const loginContext = /(^|\\/)(login|signin|sign-in|log-in|auth)(\\/|$)/i.test(location.pathname) ||
    [...document.querySelectorAll('h1,h2,form button,form input[type="submit"]')].some(e => /^(log\\s*in|sign\\s*in|next|continue)$/i.test((e.textContent || e.value || '').trim()));
  if (!password.length && !code.length && !loginContext) username = [];
  return {username,password,code};
})()`;

/** Google has an input named "action", which shadows HTMLFormElement.action.
 * Use attributes and prototype methods, never named form properties. Include
 * externally associated submit buttons; reject foreign overrides before typing. */
export const nativeLoginFormSafe = `(e) => {
  const f=e?.form; if(!f) return true;
  const sameOrigin=value => new URL(value || location.href,location.href).origin === location.origin;
  const buttons=[...document.querySelectorAll('button,input')].filter(b => b.form === f && b.type === 'submit' && !b.disabled && b.getClientRects().length);
  return sameOrigin(f.getAttribute('action')) && buttons.length <= 1 && buttons.every(b => sameOrigin(b.getAttribute('formaction') || f.getAttribute('action')));
}`;
export const nativeLoginSubmit = (origin: string) => `(() => {
  const e=document.activeElement; const f=e?.form; const safeForm=${nativeLoginFormSafe};
  if(location.origin !== ${JSON.stringify(origin)} || location.protocol !== 'https:' || !(e instanceof HTMLInputElement) || !safeForm(e)) return false;
  if(!f) return 'enter';
  const buttons=[...document.querySelectorAll('button,input')].filter(b => b.form === f && b.type === 'submit' && !b.disabled && b.getClientRects().length);
  HTMLFormElement.prototype.requestSubmit.call(f,buttons[0]);return true;
})()`;

// Discover the website's own entry point, without a per-domain path table.
// Repeated links to the same address are fine; distinct choices stay with the owner.
export const nativeLoginLink = `(() => {
  if (document.readyState !== 'complete' || document.querySelector('input[type="password"],input[autocomplete="one-time-code"]')) return null;
  const links = [...document.querySelectorAll('a[href]')].filter(e => e.getClientRects().length && /^(log\\s*in|sign\\s*in)$/i.test((e.getAttribute('aria-label') || e.textContent || '').trim()));
  const urls = [...new Set(links.map(e => e.href).filter(url => url !== location.href))];
  return urls.length === 1 ? urls[0] : null;
})()`;
