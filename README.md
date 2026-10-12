# vote13.pt

A tongue-in-cheek simulator of a Brazilian *urna eletrônica* (electronic voting machine).
It behaves exactly like the real thing — except it only accepts one vote: **13**.
Type anything else and the machine cheerfully refuses and sends you back until you get it right.

🌟 Live: https://vote13.pt

## What's inside

Pure static site — no backend, no build step. The 3D urna uses [three.js](https://threejs.org) loaded from a pinned CDN via an import map.

| File | Purpose |
|------|---------|
| `index.html` | Layout, styles, vote logic (state machine) and the 2D urna (fallback) |
| `urna3d.js` | The 3D urna: three.js scene, LCD drawn on a canvas texture, clickable keys |
| `lula.jpg` | Candidate photo (rendered black & white, like the urna screen) |
| `button.m4a` | Real keypress sound, split from a recording of an urna |
| `confirm.m4a` | Real vote-confirmation song |

## How it works

- Enter a 2-digit number on the keypad (or your physical keyboard).
- **13** → the candidate card appears; press **CONFIRMA** (green) to cast the vote → **FIM** + confirmation sound.
- **Anything else** → red "Voto recusado" screen with a random ribbing, then back to voting.
- **CORRIGE** (orange) clears · **BRANCO** is politely refused.

Keyboard: digits `0-9`, `Enter` = CONFIRMA, `Backspace` = CORRIGE.

### 3D mode

When WebGL is available the page shows a 3D urna (drag to orbit, scroll/pinch to zoom; it drifts back to
the resting view when you let go). The vote logic stays in `index.html`: it broadcasts every change as a
`urna:change` event and exposes `window.urna`, and `urna3d.js` only mirrors that state.
If WebGL or the CDN is unavailable, the original 2D urna is shown instead. Force the 2D version with `?2d`.
`?debug` exposes `window.__urna3d.frame()` to step frames by hand (handy in background/headless tabs).

## Run locally

Serve the folder (ES modules and the canvas photo need http; opening `index.html` from disk falls back to 2D):

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploy

Static hosting only — deployed via **Cloudflare Pages** (no database needed).
Every push to `main` auto-deploys.
