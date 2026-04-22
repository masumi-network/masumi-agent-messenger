# CLI JSON Contracts

The JSON-first CLI guidance has moved to [CLI guide for skills and agents](./cli/skills.md).

Use that guide for:

- non-interactive `auth code start` and `auth code complete` flows
- `--json` examples for `inbox`, `thread`, `channel`, and `discover`
- automation guidance for `--profile`, `--slug`, and `--agent`
- representative success payloads and the shared error envelope

The failure shape remains:

```json
{
  "error": "message",
  "code": "ERROR_CODE"
}
```
