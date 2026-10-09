# Support FAQ

## AI says "not signed in" / "expired" / "could not be decrypted"

- With **nothing** connected, AI tasks return a result labelled as generated locally; no model is called. Connect a provider in Settings to get model output.
- An **expired**, unreadable or rejected credential is reported as an error on purpose rather than answered locally. Follow the message: sign in again with the `claude` / `codex` CLI, use **Sign in with Claude** in Settings, or re-enter the API key.
- "The credential key file ... is not in a recognised format": `machine.key` in the Braiwser data folder was damaged or came from an OS keyring that is unavailable. It is never overwritten automatically; delete it (stored keys and logins are then lost) to start over.
- API keys: paste Anthropic or OpenAI keys under Settings. Keys go only to the provider you chose.
- A task that stalls is cancelled when the AI timeout in Settings passes, or from the panel.

## Inspector / pins missing on the page

The guest page loads the inspector preload from inside the app package. If pins never appear, reinstall the latest release and confirm you are not blocking Electron webviews. Run `npm run e2e` on a checkout to verify the packaged preload path.

## Hand-off wrote a file but the agent did not run

Pick a preset in the hand-off modal or Settings if `claude`, `cursor-agent`, or `codex` is on your PATH. Or paste an **Agent command** such as `claude -p "{promptPath}"`. Empty still writes the request file — use **Copy prompt** instead.

## License / Pro features

Free covers browse, annotate, audit, and Markdown export. Released builds gate the Pro add-ons (client packs, HTML reports, project bundles, Playwright export, integration drafts) behind a licence key: activate a `BRW1.…` key in Settings. Licences are verified offline with a public key baked into the build. Builds run from source are development builds and unlock everything. Demo licences exist only in development and CI builds.

## Sync, team, billing, SSO

These are local-only or not implemented; see the README table. In particular, sync does not back anything up, team invitations are not sent, and there is no checkout.

## Sharing diagnostics

Settings → enable crash breadcrumbs if desired, then use the diagnostics export (`caos.analytics.diagnostics`) and send the JSON only if you choose to.
