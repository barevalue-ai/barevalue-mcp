---
name: barevalue-podcast-editing
description: "Edit a podcast episode with Barevalue. Use when the user wants a raw recording turned into a finished episode, with noise and levels fixed, filler words and dead air removed, plus a transcript, show notes and highlight clips. Free for agents, no sign-in. Needs the audio file, as a link or as a file on this machine, and the user's email address."
---

# Editing a podcast episode with Barevalue

Barevalue is a done-for-you editing service. You hand over the raw recording, as a link or as a file, and get back the finished episode. You do not plan cuts or operate an editor.

It is free for agents: 600 minutes of editing a month once the user has confirmed their email address. Before that the account can use 30 minutes and place 2 orders. No payment details and no browser sign-in.

The free plan edits one order at a time, and 120 minutes in any 5 hours. Order episodes one after another, not all at once.

Connect to the hosted MCP server at `https://barevalue.com/mcp` (streamable HTTP, no key needed to connect). Every tool below also exists as a REST call under `https://barevalue.com/api/v1`; the reference is at `https://barevalue.com/docs/api-v1.md`.

## What you need from the user

1. **Their email address.** The account is theirs. They get one email asking them to confirm it.
2. **The audio file.** A file on this machine, or a link. A link must be a direct link to the file itself, reachable without a login. A signed link from S3, Google Cloud Storage, R2 or Azure works. A page that plays the file does not.
3. **The podcast name and the episode name.**
4. Optional: anything they want done or left alone ("remove the sponsor read", "keep the blooper at the end").

A file on the user's disk with no link works too: see "A file with no link" below. One file per order, audio only, one audio track, up to 60 minutes.

## The order of calls

1. `barevalue_register` with the email address, once per user. It returns `api_key`. Keep it for this user and pass it as `api_key` on every other call. If it answers `registration_failed`, either the address already has an account (ask the user for a key from Settings at barevalue.com) or it cannot receive mail (check it with the user).
2. `barevalue_submit_url` with `file_url`, `podcast_name`, `episode_name` and, if given, `special_instructions`. It returns `order_id`.
3. `barevalue_status` with the `order_id`, every 30 to 60 seconds, until `status` is `done` or `failed`. While it runs it gives `progress.estimated_seconds_remaining`. Tell the user roughly how long. Most episodes take 5 to 15 minutes. If an order is neither `done` nor `failed` after 45 minutes, stop polling and tell the user it is taking unusually long.
4. When `done`, read the result (next section) and give it to the user.
5. Ask the user whether they are happy with it, and send the answer with `barevalue_feedback`.

With several orders running, call `barevalue_updates` once a minute instead of polling each order. Pass the `cursor` from the last result as `since`, and it returns everything new. Skip any update `id` you have already handled.

## A file with no link

When the recording is a file on the machine you are running on:

1. `barevalue_upload` with `filename` (and `size_bytes` if you know it). It returns `upload_id` and a ready `curl` command.
2. Run that command with the path to the file. It answers `204` when the upload worked. The upload link works for 15 minutes.
3. `barevalue_submit_url` with `upload_id` in place of `file_url`, then carry on from step 3 of the order of calls.

One audio file, up to 750 MB. An upload can be ordered once. If the recording already has a direct link, skip this and pass the link. Through the npm package `barevalue-mcp`, `barevalue_upload` takes the path to the file and uploads it itself, so there is no command to run.

## Before ordering

You do not need `barevalue_validate` or `barevalue_estimate` before ordering. Submitting runs the same checks, and an order refused because of the file uses no minutes.

## Reading the result

`barevalue_status` on a finished order has:

- `downloads`: each file with a `kind` (`edited_audio`, `clip`, `show_notes`, `transcript`), a `format` and a `url` that works for 24 hours. A lossless upload comes back with two `edited_audio` files, one lossless and one MP3. Call `barevalue_status` again for fresh links.
- `summary`: what the edit changed, in plain sentences, and how the raw recording sounded. If `recording_tip` is set, pass it on.
- `not_included`: what this order does not have and why. Show notes come with episodes of 10 minutes or longer, clips with 5 minutes or longer. Say so instead of leaving the user wondering.
- `feedback`: whether the edit has been rated yet.

`barevalue_content` returns the show notes and the transcript as text, so you can show them or reuse them without downloading a PDF. Pass `include` to fetch only what you need: the transcript of a long episode is large.

## If the user wants it changed

`barevalue_request_revision` with the original `order_id` and `instructions` in plain language. Put everything that should be different in one request. It makes a new order from the original recording and returns its `order_id`: poll that one. It uses minutes from the allowance, as many as the original did, so confirm with the user first. A revision returns the audio; ask in the instructions if the show notes or clips should be made again.

## When something is refused or fails

A call that is refused answers with `error` and a `message` that says what to do. An order that failed has `failure.code`, `failure.message` and `failure.next_action`. Read them and do what they say. In particular:

| You see | What to do |
|---|---|
| `email_verification_required` | The account has used what it gets before the email address is confirmed (30 minutes or 2 orders). Ask the user to click the link in the email from Barevalue, then order again. |
| `allowance_used` | The month's 600 minutes are used. Minutes come back 30 days after the order that used them. Tell the user; do not retry. |
| `too_many_orders_in_progress` | An order is already being edited and the free plan takes one at a time. Wait for it to finish, then order the next. |
| `servers_full` | Our servers are busy with other orders. Nothing was created and nothing was counted. Wait `retry_after_seconds` (about five minutes) and send the same order again; tell the user it is a short wait. |
| `window_limit_reached` | 120 minutes were ordered in the last 5 hours. `retry_after` says when the next order will be taken. Tell the user; do not retry before then. |
| `invalid_url` | The link is not a direct, reachable link to a file. Ask for another. |
| `failure.retryable` is `false` | Do not submit the same file again. Tell the user why, in the words of `failure.message`. |
| `failure.code` is `instructions_out_of_scope` | The instructions asked for something the service does not do. Order again with instructions limited to editing, or with none. |
| `failure.code` is `edit_held_back` | Our own check rejected the edit, twice. Order again only with different or simpler instructions. If it is held back again, stop and tell the user. |
| `failure.code` is `processing_failed` | It broke on our side. Order again once. If it fails again, stop and tell the user. |

Never loop on a failing order. Each attempt counts, and several failures in a row pause the account for two hours.

## What it does not do

- Video, or more than one file per order.
- Human editing. That is ordered at barevalue.com.
- Generating new speech or changing what was said.

## Telling the user

Say what you did, in order: the episode is edited, here is the audio, here is what changed, here is what was not included and why. Then ask whether they are happy with it.
