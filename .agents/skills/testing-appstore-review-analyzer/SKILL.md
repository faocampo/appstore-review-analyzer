---
name: testing-appstore-review-analyzer
description: Run credential-free browser tests for the ReviewSignal dashboard, including deterministic demo assertions, source validation, and responsive review-table checks.
---

# ReviewSignal browser testing

## Setup

1. From the repository root, load NVM with `source "$HOME/.nvm/nvm.sh"` if `node` is not on `PATH`.
2. Install dependencies with `npm install --legacy-peer-deps` when `node_modules` is absent.
3. Start the app with `npm run dev`; mock mode is the default and does not require `.env.local`.
4. Open `http://localhost:3000` and wait for the automatic demo analysis.

## Deterministic demo flow

- Compute expected review counts from the fixture's relative date offsets rather than hard-coding calendar dates across sessions.
- Verify the default dashboard, both completeness notices, and the latest-N review map.
- Narrow the date range, reduce latest-N, submit through the UI, and compare all changed aggregates and review order.
- Treat the submit loading label as verified only when it is visibly captured in a recorded frame.

## Adversarial source checks

- Official store API mode should expose only the Android package and App Store Connect ID; tokens must remain server-side.
- Submit CSV mode without files and require actionable missing-upload text, not only a generic request error.

## Responsive checks

- Use Chrome device emulation at 390 CSS px when the desktop window manager enforces a larger minimum width.
- Confirm `document.documentElement.scrollWidth <= document.documentElement.clientWidth`.
- Confirm `.review-table` has its own horizontal overflow and demonstrate scrolling it to reveal the sentiment and reason columns.

## Devin Secrets Needed

- None for demo and validation testing.
- `TYPESAFE_API_KEY` for Jev classification.
- `GOOGLE_PLAY_ACCESS_TOKEN` for live Google Play retrieval.
- `APPLE_APP_STORE_CONNECT_TOKEN` for live App Store Connect retrieval.
