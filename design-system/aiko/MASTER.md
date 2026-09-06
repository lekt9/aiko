# Aiko mini app

Direction: Telegram-native, with Apple-style grouped settings. Keep system font rendering, one clear blue action, generous touch targets, 16px minimum input text, rounded 18px groups, and progressive disclosure. Preserve all existing authorization and connection behavior; no logout action in Telegram.

UI/UX Pro Max search `mobile personal assistant minimal` matched Minimalism & Swiss Style with monochrome and blue. Its landing-page hero pattern and external font pairing do not fit this utility screen; use a compact app header and native system fonts instead. React stack guidance used for accessible controls. No animation library needed.

Telegram's live CSS theme colors override system light/dark fallbacks. Honor `themeChanged`, `ready`, and safe-area/content-safe-area CSS values. Respect reduced motion, text scaling, keyboard focus, and 48px buttons. Setup instructions and web-only alternate credentials use semantic disclosures.

Sources:
- https://developer.apple.com/design/human-interface-guidelines/layout
- https://developer.apple.com/design/human-interface-guidelines/buttons
- https://core.telegram.org/bots/webapps

Implementation: `apps/web/src/styles/mini-app.css`, `apps/web/connector-site/entry.tsx`, shared connector and Secretary components. The full-screen connector entry owns the new stylesheet; unrelated vault screens retain their styles.

## App drawer refinement

The connections surface is a searchable three-column mobile app drawer (four columns on larger screens). Use quiet, tonal monogram tiles, explicit connection-status text and an All apps / Connected filter. A tile opens a compact credential sheet, bottom-aligned on phones and centered on larger screens. Group labeled username/password fields, allow paste and password-manager autofill, offer show/hide, and keep one Connect action. Do not claim passwords are stored in a vault: this flow establishes sessions. Unknown apps require an explicit website address, never an inferred `.com` domain. Keep account setup and Telegram assistant controls out of the primary connection flow through progressive disclosure. Restore focus and scroll on dismissal; preserve pending, verification and cancellation states.
