/** These expressions run only inside the private page. No values or page text
 * leave the VM; callers receive field kinds or a discovered navigation address. */
export const nativeLoginFields = `(() => {
  const visible = e => e instanceof HTMLInputElement && !e.matches(':disabled') && !e.readOnly && !e.closest('[inert],[aria-hidden="true"]') && !!e.getClientRects().length && getComputedStyle(e).visibility === 'visible';
  const inputs = [...document.querySelectorAll('input')].filter(visible);
  const accessibleLabels = e => [e.getAttribute('aria-label'),e.placeholder,...[...(e.labels || [])].map(l => l.textContent),...(e.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent)];
  const label = e => [e.name,e.id,e.autocomplete,...accessibleLabels(e)].filter(Boolean).join(' ');
  const password = inputs.filter(e => e.type === 'password');
  const text = inputs.filter(e => ['text','email','tel','number'].includes(e.type));
  // Some identity screens label an OTP simply "Code", even with name="email".
  // Require verification instructions so coupon/postal fields stay unrelated.
  const verificationContext = !password.length && /(?:verification|security) code|code (?:we )?sent|check your (?:email|phone)|authenticator app/i.test(document.body?.innerText || '');
  const plainCode = e => accessibleLabels(e).some(value => /^code$/i.test((value || '').trim()));
  let code = text.filter(e => /one-time-code|verification.?code|security.?code|passcode|(^|[\\s_-])(otp|pin)([\\s_-]|$)/i.test(label(e)) || (verificationContext && plainCode(e)));
  // A split OTP often labels only its first digit. Expand within one explicit
  // form/group; never collect unrelated single-character inputs across a page.
  const group = e => e.closest('fieldset,[role="group"]') || e.form;
  const digits = text.filter(e => e.maxLength === 1);
  if (verificationContext || code.some(e => e.maxLength === 1)) {
    const groups = [...new Set(digits.map(group).filter(Boolean))];
    const candidates = groups.map(g => digits.filter(e => group(e) === g)).filter(es => es.length >= 4 && es.length <= 8 &&
      (!code.length || code.every(e => es.includes(e))) && text.filter(e => group(e) === group(es[0])).every(e => es.includes(e)));
    if (candidates.length === 1) code = candidates[0];
  }
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

/** Resolve a fixed field kind to one input or one bounded split-code group.
 * DOM references stay in the private page; callers export only kinds/counts. */
export const nativeLoginFieldTargets = `(fields,name) => {
  if(!['username','password','code'].includes(name))return [];
  const inputs=fields[name];
  if(inputs.length === 1)return name === 'code' && inputs[0].maxLength === 1 ? [] : inputs;
  if(name !== 'code' || inputs.length < 4 || inputs.length > 8 || !inputs.every(e => e.maxLength === 1))return [];
  const group=e => e.closest('fieldset,[role="group"]') || e.form;
  return group(inputs[0]) && inputs.every(e => group(e) === group(inputs[0]) && e.form === inputs[0].form) ? inputs : [];
}`;

/** Pin exact elements before any value is dispatched. No credential enters an
 * evaluation string: codeLength is only used to reject partial split codes. */
export const nativeLoginPrepareFields = (origin: string, names: string[], codeLength: number, nonce: string) => `(() => {
  delete window.__unlockLoginFields;
  if(location.origin !== ${JSON.stringify(origin)} || location.protocol !== 'https:')return false;
  const fields=${nativeLoginFields}, targets=${nativeLoginFieldTargets}, safeForm=${nativeLoginFormSafe};
  const names=${JSON.stringify(names)}, selected=Object.fromEntries(names.map(n => [n,targets(fields,n)]));
  if(!names.length || !names.every(n => selected[n].length && selected[n].every(safeForm)))return false;
  if(selected.code?.length > 1 && selected.code.length !== ${JSON.stringify(codeLength)})return false;
  const all=Object.values(selected).flat();
  if(!all.every(e => e.form === all[0].form))return false;
  window.__unlockLoginFields={nonce:${JSON.stringify(nonce)},href:location.href,selected};
  return Object.fromEntries(names.map(n => [n,selected[n].length]));
})()`;

export const nativeLoginFocusField = (origin: string, name: string, index: number, nonce: string) => `(() => {
  const pin=window.__unlockLoginFields;
  if(location.origin !== ${JSON.stringify(origin)} || location.protocol !== 'https:' || pin?.nonce !== ${JSON.stringify(nonce)} || pin.href !== location.href)return false;
  const fields=${nativeLoginFields}, targets=${nativeLoginFieldTargets}, safeForm=${nativeLoginFormSafe};
  const name=${JSON.stringify(name)}, selected=targets(fields,name), original=pin.selected[name];
  if(!original || selected.length !== original.length || !selected.every((e,i) => e === original[i] && safeForm(e)))return false;
  const e=selected[${JSON.stringify(index)}];if(!e)return false;
  e.focus();e.select();return document.activeElement === e;
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
export const nativeLoginSubmit = (origin: string, nonce?: string) => `(() => {
  const e=document.activeElement; const f=e?.form; const safeForm=${nativeLoginFormSafe};
  if(location.origin !== ${JSON.stringify(origin)} || location.protocol !== 'https:' || !(e instanceof HTMLInputElement) || !safeForm(e)) return false;
  ${nonce === undefined ? "" : `const pin=window.__unlockLoginFields;
  if(pin?.nonce !== ${JSON.stringify(nonce)} || pin.href !== location.href || !Object.values(pin.selected).flat().includes(e))return false;
  delete window.__unlockLoginFields;`}
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
