# vote13.pt

A tongue-in-cheek simulator of a Brazilian *urna eletrônica* (electronic voting machine).
It behaves exactly like the real thing — except it only accepts one vote: **13**.
Type anything else and the machine cheerfully refuses and sends you back until you get it right.

🌟 Live: https://vote13.pt

## What's inside

Pure static site — no backend, no build step, no dependencies.

| File | Purpose |
|------|---------|
| `index.html` | The whole app: layout, styles, and vote logic |
| `lula.jpg` | Candidate photo (rendered black & white, like the urna screen) |
| `button.m4a` | Real keypress sound, split from a recording of an urna |
| `confirm.m4a` | Real vote-confirmation song |

## How it works

- Enter a 2-digit number on the keypad (or your physical keyboard).
- **13** → the candidate card appears; press **CONFIRMA** (green) to cast the vote → **FIM** + confirmation sound.
- **Anything else** → red "Voto recusado" screen with a random ribbing, then back to voting.
- **CORRIGE** (orange) clears · **BRANCO** is politely refused.

Keyboard: digits `0-9`, `Enter` = CONFIRMA, `Backspace` = CORRIGE.

## Run locally

Just open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploy

Static hosting only — deployed via **Cloudflare Pages** (no database needed).
Every push to `main` auto-deploys.
