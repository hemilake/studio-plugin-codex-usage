<div align="center">
  <h1>Codex Usage</h1>
  <p>Codex plan limits and token activity for every Codex account in Hemilake Studio.</p>
</div>

# Codex Usage plugin for Hemilake Studio

This is a fork of [dongwook-chan/cloudcli-plugin-codex-usage](https://github.com/dongwook-chan/cloudcli-plugin-codex-usage) by dongwook-chan, released under the MIT license. The original shows the limits of the one Codex account in `~/.codex`. This fork reads the list of Codex accounts that Hemilake Studio keeps and shows all of them.

The tab shows:

- The rotation mode Studio uses (round robin or backup) and the enabled account with the most headroom, which is the one round robin picks next.
- One card per account: label, email, plan, primary or backup role, whether it is disabled, each rate-limit window with its reset countdown, and "Limit reached" when Codex reports it.
- 30-day token activity for one account or for all of them added up.
- Plan limits refresh every 60 seconds.

It uses Studio's theme colours when it runs inside Studio and falls back to its own palette elsewhere. It works from 320 px wide.

The backend talks only to the official [`codex app-server`](https://developers.openai.com/codex/app-server/) JSON-RPC interface, one process per account with `CODEX_HOME` pointing at that account's directory. It never reads `auth.json`; it only checks whether the file exists and when it changed, to restart that account's app-server after a new login.

## Accounts

Studio writes the account list to `accounts.json` in `$CLOUDCLI_CODEX_ACCOUNTS_DIR`, or in `~/.cloudcli/codex-accounts` when that variable is unset. The plugin only reads it, on every request, so new accounts show up without a restart.

```json
{
  "version": 1,
  "mode": "round_robin",
  "primaryAccountId": "default",
  "minHeadroomPercent": 5,
  "accounts": [
    { "id": "default", "label": "Principal", "codexHome": "/home/u/.codex", "enabled": true, "createdAt": "2026-10-26T09:00:00Z" },
    { "id": "acct-1a2b3c", "label": "Work", "codexHome": "/home/u/.cloudcli/codex-accounts/acct-1a2b3c", "enabled": true, "createdAt": "2026-10-26T09:00:00Z" }
  ]
}
```

- Array order is priority order.
- `mode` is `round_robin` or `backup`.
- If the file is missing or is not valid JSON, the plugin shows a single account, `default`, using `$CODEX_HOME` or `~/.codex`.
- An account whose `codexHome` has no `auth.json` shows as not signed in; no app-server is started for it.

## Requirements

- A recent Codex CLI with the `account/read`, `account/rateLimits/read` and `account/usage/read` app-server methods.
- Codex signed in with ChatGPT-backed authentication. Account activity is not available for API-key-only or Amazon Bedrock authentication; the card shows the app-server error in that case.

## Installation

In Studio, open **Settings > Plugins**, paste this repository URL and click **Install**. To install by hand:

```bash
git clone https://github.com/hemilake/studio-plugin-codex-usage.git ~/.claude-code-ui/plugins/codex-usage
cd ~/.claude-code-ui/plugins/codex-usage
npm install
npm run build
```

## Development

```bash
npm install
npm test
npm run build
```

Routes served by the plugin server (proxied by the host, all read-only):

| Route | What it returns |
|---|---|
| `GET /accounts` | Mode, primary account, `minHeadroomPercent` and, per account, `id`, `label`, `enabled`, `isPrimary`, `signedIn`, `email`, `planType`, `limits` and `error`. Accounts are queried in parallel; one failing account sets its own `error` and does not affect the rest. |
| `GET /activity?account=<id>&days=30` | Daily token series for one account. `account` defaults to `default`. Returns 404 for an unknown account and 409 for one that is not signed in. |
| `GET /activity?account=all&days=30` | The daily series of every signed-in account added up, with `accounts` (included ids) and `errors` (accounts left out and why). Lifetime tokens are summed; peak day and streaks are null because they cannot be combined across accounts. |
| `GET /rate-limits` | Limits of the default account, as in the original plugin. |
| `GET /activity` | Activity of the default account, as in the original plugin. |

`dist/index.js` is loaded by the host from a Blob URL, so it cannot import other files at runtime. Keep every import in `src/index.ts` type-only.

## License

MIT. Original work by dongwook-chan; multi-account changes by Hemilake.
