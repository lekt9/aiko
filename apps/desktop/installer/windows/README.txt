Aiko for Windows x86_64
========================

Install
-------
Double-click install.cmd. The installer places Aiko in:

  %LOCALAPPDATA%\Programs\Aiko

It creates Start Menu and desktop shortcuts and starts Aiko. The bundled
aiko.exe runtime and Contract trust kernel launch automatically with the
desktop application; no separate CLI or network daemon installation is
required. Collective participation remains disabled until you enable it.
The portable folder must keep contract\contract.dll in its supplied
subdirectory beside aiko.exe and aiko-desktop.exe; it is the deterministic
Contract trust kernel.

Identity and uninstall
----------------------
Aiko reuses the existing login and user data under %USERPROFILE%\.aiko.
Uninstall Aiko from Windows Settings or the Start Menu. Uninstall deliberately
preserves that shared login and user-owned data.

This development build is not Authenticode-signed. Windows may show a
reputation warning until the release is signed and establishes SmartScreen
reputation.
