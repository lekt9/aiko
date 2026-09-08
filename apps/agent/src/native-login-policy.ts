import { GMAIL_DOMAIN, GMAIL_URL, isGmailDomain } from "../../../packages/protocol/src/google-connection.ts";

/** Private sign-in and cookie custody are separate from actor browsing authority.
 * Gmail needs Google's parent-domain cookies, not access to every Google app. */
export function nativeLoginStartUrl(domain: string) {
  return isGmailDomain(domain) ? GMAIL_URL : `https://${domain}/`;
}
export function nativeLoginResourceHost(domain: string, host: string) {
  return isGmailDomain(domain) ? host === GMAIL_DOMAIN : host === domain || host.endsWith(`.${domain}`);
}
export function nativeLoginProviderHost(domain: string, host: string) {
  return isGmailDomain(domain) && host === "accounts.google.com";
}
export function nativeCookieScope(domain: string) {
  return isGmailDomain(domain)
    ? { domains: ["google.com", "accounts.google.com", GMAIL_DOMAIN], includeSubdomains: false }
    : { domains: [domain], includeSubdomains: true };
}
export function nativeCookieDomainAllowed(domain: string, cookieDomain: string) {
  const host = cookieDomain.replace(/^\./, "");
  const scope = nativeCookieScope(domain);
  return scope.domains.some(d => host === d || (scope.includeSubdomains && host.endsWith(`.${d}`)));
}
/** Parent cookies cannot be owned by independently revocable connections. */
export function nativeLoginScopesOverlap(a: string, b: string) {
  return nativeCookieScope(a).domains.some(x => nativeCookieScope(b).domains.some(y =>
    x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`)));
}
export function nativeLoginAuthenticatedSelector(domain: string) {
  if (isGmailDomain(domain))
    return '[role="navigation"] a[href*="#inbox"], [role="navigation"] a[href*="/mail/"][href*="inbox"]';
  if (domain === "linkedin.com") return '.global-nav__me, [data-control-name="nav.settings"]';
  if (domain === "x.com") return '[data-testid="SideNav_AccountSwitcher_Button"]';
  return 'a[href*="logout"], a[href*="signout"], form[action*="logout"], [data-testid="account-menu"]';
}
