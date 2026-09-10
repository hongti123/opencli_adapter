## 2026-08-21 by Codex

Verified against the Guangdong Electronic Tax Service with OpenCLI profile `opc-default`:

- The authenticated subject menu has the stable trigger `#NavTopPopup`.
- Hovering it reveals a `.grlist` containing `.t-icon-logout` and the text `退出登录`.
- A successful logout first exposes the public portal `.loginBtn`; the site may then redirect to the unified identity page `#/login`, where a visible taxpayer-ID/password/login form is the second valid success surface.
- Success also requires `#NavTopPopup` and `主体信息` to be absent.
