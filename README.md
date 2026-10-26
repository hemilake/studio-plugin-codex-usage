<div align="center">
  <h1>Codex Usage</h1>
  <p>Codex plan limits and token activity for every Codex account in Hemilake Studio.</p>
</div>

# Codex Usage plugin for Hemilake Studio

This is a fork of [dongwook-chan/cloudcli-plugin-codex-usage](https://github.com/dongwook-chan/cloudcli-plugin-codex-usage) by dongwook-chan, released under the MIT license. The original shows the limits of the one Codex account in `~/.codex`. This fork reads the list of Codex accounts that Hemilake Studio keeps and shows all of them.

The tab shows:

- The rotation mode Studio uses (round robin or backup) and the account Studio would give the next turn, worked out with the same rules as Studio's account selector at medium effort.
- One card per account: label, email, plan, headroom weighted by plan ("≈ 60% of a Plus window"), primary or backup role, whether it is disabled, each rate-limit window with its reset countdown, and "Limit reached" when Codex reports it.
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
  "planWeights": { "pro": 6 },
  "roundRobinCursor": "default",
  "accounts": [
    { "id": "default", "label": "Principal", "codexHome": "/home/u/.codex", "enabled": true, "createdAt": "2026-10-26T09:00:00Z" },
    { "id": "acct-1a2b3c", "label": "Work", "codexHome": "/home/u/.cloudcli/codex-accounts/acct-1a2b3c", "enabled": true, "createdAt": "2026-10-26T09:00:00Z" }
  ]
}
```

- Array order is priority order.
- `mode` is `round_robin` or `backup`.
- `planWeights` (optional) overrides the plan capacity table, relative to Plus. `roundRobinCursor` is the last account round robin handed out.
- If the file is missing or is not valid JSON, the plugin shows a single account, `default`, using `$CODEX_HOME` or `~/.codex`.
- An account whose `codexHome` has no `auth.json` shows as not signed in; no app-server is started for it.

## Which account is next

The summary copies the policy in Studio's `codex-accounts.selector.ts`; keep the two in step.

- Remaining headroom is 100 minus the fullest live window. Windows whose reset time has passed count as empty, and a reached limit counts as 0.
- Weighted headroom is remaining headroom times the plan weight (free 0.25, go 0.5, plus/team/business/enterprise/edu 1, pro 6, unknown 1). Compound plan names such as `self_serve_business_prolite` match a known plan by token, longest name first.
- An account is eligible when it is enabled, signed in, has headroom above 0, and has weighted headroom of at least `minHeadroomPercent` times the effort factor (the tab uses medium, which is 1). An account whose limits could not be read counts as eligible, as in Studio.
- Backup mode picks the primary if eligible, else the first eligible account in order. Round robin picks the first eligible account after `roundRobinCursor`, wrapping around.
- If nothing is eligible, the account with the most weighted headroom is shown as the fallback.

Studio also keeps a session on the account it already uses while that account qualifies. The tab has no session, so it leaves that rule out.

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
| `GET /accounts` | Mode, primary account, `minHeadroomPercent`, `planWeights`, `roundRobinCursor` and, per account, `id`, `label`, `enabled`, `isPrimary`, `signedIn`, `email`, `planType`, `limits` and `error`. Accounts are queried in parallel; one failing account sets its own `error` and does not affect the rest. |
| `GET /activity?account=<id>&days=30` | Daily token series for one account. `account` defaults to `default`. Returns 404 for an unknown account and 409 for one that is not signed in. |
| `GET /activity?account=all&days=30` | The daily series of every signed-in account added up, with `accounts` (included ids) and `errors` (accounts left out and why). Lifetime tokens are summed; peak day and streaks are null because they cannot be combined across accounts. |
| `GET /rate-limits` | Limits of the default account, as in the original plugin. |
| `GET /activity` | Activity of the default account, as in the original plugin. |

`dist/index.js` is loaded by the host from a Blob URL, so it cannot import other files at runtime. Keep every import in `src/index.ts` type-only.

## License

MIT. Original work by dongwook-chan; multi-account changes by Hemilake.
