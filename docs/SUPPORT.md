# Support FAQ

## AI says "not signed in" / "no key"

- Claude subscription: sign in with the `claude` CLI, or use **Sign in with Claude** in Settings.
- ChatGPT subscription: sign in with the `codex` CLI.
- API keys: paste Anthropic or OpenAI keys under Settings. Keys never leave the machine except to the provider you chose.

## Inspector / pins missing on the page

The guest page loads the inspector preload from inside the app package. If pins never appear, reinstall the latest release and confirm you are not blocking Electron webviews. Run `npm run e2e` on a checkout to verify the packaged preload path.

## Hand-off wrote a file but the agent did not run

Pick a preset in the hand-off modal or Settings if `claude`, `cursor-agent`, or `codex` is on your PATH. Or paste an **Agent command** such as `claude -p "{promptPath}"`. Empty still writes the request file — use **Copy prompt** instead.

## License / Pro features

Free covers browse, annotate, audit, and Markdown export. Activate a `BRW1.…` key in Settings for Pro. Release builds may set `BRAIWSER_ENFORCE_LICENSE=1`.

## Sharing diagnostics

Settings → enable crash breadcrumbs if desired, then use the diagnostics export (`caos.analytics.diagnostics`) and send the JSON only if you choose to.
