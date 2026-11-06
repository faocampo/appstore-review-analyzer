---
name: testing-appstore-review-analyzer
description: Run credential-free browser tests for the ReviewSignal dashboard, including deterministic demo assertions, source validation, and responsive review-table checks.
---

# ReviewSignal browser testing

## Setup

1. From the repository root, load NVM with `source "$HOME/.nvm/nvm.sh"` if `node` is not on `PATH`.
2. Install dependencies with `npm install --legacy-peer-deps` when `node_modules` is absent.
3. Start the app with `npm run dev`; the mock classifier is the default outside production and does not require `.env.local`. Leave `ANALYZE_API_TOKEN` unset locally, or set it and enter it in the access-token field that appears after a 401.
4. Open `http://localhost:3000` and wait for the automatic demo analysis.

## Deterministic demo flow

- Compute expected review counts from the fixture's relative date offsets rather than hard-coding calendar dates across sessions.
- Verify the default dashboard, the SAMPLE DATA tag, the Data coverage card (one `Complete` demo source), the notes, and the latest-N review table.
- Narrow the date range, reduce latest-N, submit through the UI, and compare all changed aggregates and review order.
- Treat the submit loading label as verified only when it is visibly captured in a recorded frame.

## Adversarial source checks

- Official store API mode should expose only the Android package and App Store Connect ID; tokens must remain server-side.
- Submit store API mode without credentials and require the actionable "no credentials are configured" message; the previous result must be cleared.
- Submit CSV mode without files and require actionable missing-upload text, not only a generic request error.

## Responsive checks

- Use Chrome device emulation at 390 CSS px when the desktop window manager enforces a larger minimum width.
- Confirm `document.documentElement.scrollWidth <= document.documentElement.clientWidth`.
- At 390 px the review table collapses into stacked rows with labels (Store, Rating, Sentiment, Reason); confirm no horizontal scrolling is needed.

## Devin Secrets Needed

- None for demo and validation testing.
- `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` for OpenRouter classification.
- `TYPESAFE_API_KEY` for Jev classification.
- `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` for live Google Play retrieval.
- `APPLE_ISSUER_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` for live App Store Connect retrieval.
