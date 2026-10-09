# barevalue-mcp

MCP server for [Barevalue](https://barevalue.com) AI podcast editing. Hand over a raw recording and get back a finished episode: cleaned audio, a transcript, and show notes and highlight clips for longer episodes.

It is free for agents: 10 hours of editing a month, delivered at up to 320 kbps or lossless. No payment details, and no person has to sign in or approve anything.

## Which server to use

| You have | Use |
|---|---|
| A recording on this machine (Claude Code, Cursor, any local agent) | This package. It uploads the file for you |
| A recording that already has a link | Either this package or the hosted server, `https://barevalue.com/mcp`, with nothing to install |

This package is a bridge to the hosted server. Its tools come from the service (asked for when a client lists them, kept for five minutes), so they are always the current ones. The one thing it adds is `barevalue_upload`, which reads a file from your disk.

## Install

Claude Code:

```bash
claude mcp add barevalue -- npx -y barevalue-mcp
```

Or in any MCP client's configuration:

```json
{
  "mcpServers": {
    "barevalue": {
      "command": "npx",
      "args": ["-y", "barevalue-mcp"]
    }
  }
}
```

Node 18 or later.

## API key

If your email address has no Barevalue account yet, you do not need one to start. The agent calls `barevalue_register` with the address and gets a key in that one call, which this server keeps for the rest of the session. You get an email with a link: until you click it the account can edit 30 minutes, after it 10 hours a month.

If the address already has an account, `barevalue_register` is refused and you make the key yourself (Settings, API Keys on barevalue.com). Set it and the tools stop asking for one:

```json
"env": { "BAREVALUE_API_KEY": "bv_sk_your_key_here" }
```

## What to say

> Edit the podcast episode at ~/recordings/ep42.wav with Barevalue. The show is "Tech Talk", the episode is "AI in 2026". Remove the sponsor read at the start.

The agent will:

1. Upload the file (`barevalue_upload`)
2. Order the edit (`barevalue_submit_url`)
3. Check on it every minute or so until it is done (`barevalue_status`), usually 5 to 15 minutes
4. Give you the download links, and the show notes and transcript as text (`barevalue_content`)
5. Ask whether you are happy with it and pass that on (`barevalue_feedback`), or have it edited again with your notes (`barevalue_request_revision`)

## Tools

The list comes from the service, so `tools/list` is the authority. Today:

| Tool | What it does |
|---|---|
| `barevalue_register` | Create an account and get an API key in one call |
| `barevalue_upload` | Upload an audio file from this machine |
| `barevalue_submit_url` | Order editing, for an upload or for audio at a link |
| `barevalue_status` | Progress, time remaining, download links, what the edit changed |
| `barevalue_content` | Show notes, transcript and edit summary as text |
| `barevalue_feedback` | Say whether the edit was good |
| `barevalue_request_revision` | Have a finished order edited again with new instructions |
| `barevalue_updates` | Everything new on the account since the last call |
| `barevalue_list_orders` | Recent orders |
| `barevalue_account` | Minutes left this month and the pace limits |
| `barevalue_estimate` | Whether an order of a given length would be accepted |
| `barevalue_validate` | Pre-check audio at a link |
| `barevalue_pricing`, `barevalue_api_status` | Plans and current processing times |

## Limits

- Audio only. One file per order, with one audio track, up to 60 minutes and 750 MB
- MP3, WAV, M4A, FLAC, AAC, OGG, Opus, WMA and AIFF
- The free plan edits one order at a time and 120 minutes in any 5 hours
- An uploaded file can be ordered once, within 2 hours of the upload

## Changes in 1.4.0

- The tools now come from the hosted server. `barevalue_submit` (with `order_id`), the webhook tools and human editing are gone: the service retired them
- `barevalue_upload` uses the new upload flow and returns an `upload_id` for `barevalue_submit_url`
- `BAREVALUE_API_KEY` is optional
- `BAREVALUE_API_URL` is no longer read
- With `BAREVALUE_API_KEY` set, that key is the only one used: an `api_key` passed to a tool is ignored and `barevalue_register` does not replace it
- `barevalue_upload` sends audio files only (by the real file's extension) and no call follows a redirect

## Changes in 1.4.1

- A `BAREVALUE_API_KEY` that cannot be a key (empty quotes, two layers of quotes, a quote that is not closed) stops the server at startup with one line that says how to set it. Before, the first ran without a key and the others got a 401 on every call
- When the service refuses the key in `BAREVALUE_API_KEY` (revoked, expired, mistyped), the answer now says so and what to do: set a working key or remove the variable, then restart. That key is still the only one used. A key the session got from `barevalue_register` and that is later refused is dropped, so a working key can be passed as `api_key` (registering the same address again is refused: it has an account by then)
- `barevalue_upload` sends the file only to Barevalue's own storage host. Any other upload address is refused before a byte is sent
- A long upload reports progress to a client that asks for it (a progress token on the call), about once a second
- Cancelling the call stops the upload, and so does the client going away. The same file asked for again reuses the upload it had been given, so retries do not use up the account's unordered uploads
- A second `barevalue_upload` call for a file that is still on its way joins that upload and returns the same `upload_id`, in place of sending the file twice
- A streamed answer from the service is read correctly when it carries other messages or stays open after the answer
- `barevalue_upload` opens the file once and sends what it checked, so a file swapped in afterwards is not sent. A file with more than one name on disk (a hard link) is refused: copy it and upload the copy. A file the program may not read is refused in plain words

## Changes in 1.4.2

- An upload no longer waits for ever when storage sends the start of an answer and then drops the connection. The call is answered with the reason, the file is closed, and the same file asked for again goes to the upload it had been given. An upload that goes quiet for 120 seconds is stopped the same way. A yes from storage that comes before the whole file was sent no longer counts as an upload
- `barevalue_submit_url` sends an idempotency key. An order that got no answer (a timeout, a broken connection) and is asked for again with the same arguments within 30 minutes goes out with the same key, so it is not placed twice. The timeout message says so. When the answer is that earlier order, it says so and what became of it. If it failed, the same call once more places a new order. If it is being edited or done, the same call keeps giving that order, and a second order of the same recording takes an `idempotency_key` of your own. An `idempotency_key` you pass yourself is sent as given
- `barevalue_upload` lists `api_key` like the other tools while the session has no key. It always took one
- The texts about `barevalue_register` no longer promise a key to an address that already has an account: that call is refused, and the key comes from Settings, API Keys

## Development

```bash
npm install
npm run build
node test-mcp.js                                   # live read-only smoke test, then the local tests; no key needed
node test-mcp.js --offline                         # the local tests only, against a stub inside the test
BAREVALUE_API_KEY=... node test-mcp.js episode.mp3 # also uploads the file, places no order
```

## Support

support@barevalue.com, or the [API documentation](https://barevalue.com/docs/api-v1).

## License

MIT
