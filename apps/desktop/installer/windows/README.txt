Aiko for Windows x86_64
========================

Install
-------
Double-click install.cmd. The installer places Aiko in:

  %LOCALAPPDATA%\Programs\Aiko

It creates Start Menu and desktop shortcuts and starts Aiko. The bundled
aiko.exe runtime launches automatically with the desktop application; no
separate CLI installation is required.

Identity and uninstall
----------------------
Aiko reuses the existing login and user data under %USERPROFILE%\.aiko.
Uninstall Aiko from Windows Settings or the Start Menu. Uninstall deliberately
preserves that shared login and user-owned data.

This development build is not Authenticode-signed. Windows may show a
reputation warning until the release is signed and establishes SmartScreen
reputation.
