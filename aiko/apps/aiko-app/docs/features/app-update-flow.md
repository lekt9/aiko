# App update flow

Settings → About → Check for updates.

## Behaviour

1. Signed release (plugin on + platform supports): check → download → install → `prepare_for_app_update` → relaunch.
2. Unsigned / local / plugin off: query GitHub Releases, then **Open release page** and optional **Download installer**.
3. Package types that cannot auto-update (e.g. Linux non-AppImage): manual path with honest unsupported channel copy.
4. Status copy and channel honesty: pure `src/lib/appUpdateHonesty.ts` (never invents versions; agents stop only after successful install prepare).

## Verify

1. Check update against a known newer release — download URL points at the matching asset when present.
2. When already latest — status says up to date.
3. Local / unsigned build shows GitHub download channel, not silent in-app.
