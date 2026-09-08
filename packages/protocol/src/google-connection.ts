/** Gmail's public address redirects; the mailbox is the connected resource.
 * This identity is not a grant to other Google products or third-party sites. */
export const GMAIL_DOMAIN = "mail.google.com";
export const GMAIL_URL = "https://mail.google.com/mail/u/0/";
export function isGmailDomain(domain: string) {
  return [GMAIL_DOMAIN, "gmail.com", "www.gmail.com"].includes(domain);
}
export function canonicalGmailDomain(domain: string) {
  return isGmailDomain(domain) ? GMAIL_DOMAIN : domain;
}
