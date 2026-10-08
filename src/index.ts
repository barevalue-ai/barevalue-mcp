#!/usr/bin/env node

/**
 * Barevalue MCP server (stdio).
 *
 * Since 1.4.0 this package is a bridge to the hosted server at https://barevalue.com/mcp:
 * the tool list and every tool call come from there, so what an agent sees here is what
 * the service offers today and the two cannot drift apart. (Until 1.3.0 this package
 * carried its own copy of the tools and fell behind the service twice.)
 *
 * One tool is handled on this machine, because only this machine can read the file:
 * barevalue_upload takes a path, asks the service for an upload form, sends the file and
 * hands back the upload_id to order with.
 *
 * BAREVALUE_API_KEY is optional. Without it, call barevalue_register: the key it returns
 * is remembered for the rest of the session.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import { constants as fsConstants, promises as fsPromises, realpathSync } from 'fs';
import { basename, extname } from 'path';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const VERSION: string = require('../package.json').version;

const SERVICE_URL = 'https://barevalue.com/mcp';
let HOSTED_URL = SERVICE_URL;
// Where the service's upload form posts to: our bucket, by the two names S3 gives it (with
// its region, which is what the service returns today, and without). Nothing else: the
// file is the user's recording and goes nowhere but there.
const UPLOAD_HOSTS = ['barevalue-files.s3.us-east-2.amazonaws.com', 'barevalue-files.s3.amazonaws.com'];
const TOOLS_TTL_MS = 5 * 60 * 1000;
const CALL_TIMEOUT_MS = 60 * 1000;
const UPLOAD_IDLE_TIMEOUT_MS = 120 * 1000;
// How often a client that asked for progress hears how far an upload is.
const PROGRESS_EVERY_MS = 1000;
// An upload form left unused is tried again only while it has this long left to run.
const SPARE_FORM_MARGIN_MINUTES = 5;
const CANCELLED = 'The upload was stopped because the call was cancelled.';
const UPLOAD_TOOL = 'barevalue_upload';
// What the upload tool will read from this machine: recordings, by the name of the real file.
// The formats the service lists (GET /api/v1, supported_formats), and two other spellings.
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.wma', '.aiff', '.aif', '.opus'];

type Tool = {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
  [key: string]: unknown;
};

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
};

const KEY_HOW =
  'Set BAREVALUE_API_KEY to the key alone (bv_sk_...), with no quote marks inside the value, or remove it and let the agent call barevalue_register.';

/**
 * The key from the environment, or what is wrong with it. Trimmed, and without the one
 * layer of quotes a shell file or a JSON config sometimes leaves around it. A value that
 * cannot be a key is a problem to say at startup: sent as it is, it would get a 401 on
 * every call, and empty quotes would run without a key and without a word.
 * The value itself is never part of the message.
 */
export function readConfiguredKey(raw: string | undefined): { key: string | null; problem: string | null } {
  const given = (raw ?? '').trim();
  if (given === '') {
    return { key: null, problem: null };
  }

  const key = given.replace(/^(["'])(.*)\1$/, '$2').trim();
  if (key === '') {
    return { key: null, problem: `BAREVALUE_API_KEY is set to empty quotes, not to a key. ${KEY_HOW}` };
  }
  if (/["'`]/.test(key)) {
    return { key: null, problem: `BAREVALUE_API_KEY has quote marks inside its value (two layers of quotes, or one that is not closed). ${KEY_HOW}` };
  }
  if (!/^[\x21-\x7E]+$/.test(key)) {
    return { key: null, problem: `BAREVALUE_API_KEY holds a space, a line break or another character a key cannot have. ${KEY_HOW}` };
  }

  return { key, problem: null };
}

/** The key for this session: from the environment, or from barevalue_register. Never logged. */
let apiKey: string | null = null;
/** True when that key is the one the user configured. It is then the only key ever used. */
let keyFromConfig = false;

let toolsCache: { at: number; tools: Tool[] } | null = null;

/**
 * Where the service is. BAREVALUE_MCP_URL is for our own testing; anything that is not
 * https (or a local address) is refused, since the API key is sent there.
 */
export function hostedUrl(raw: string | undefined = process.env.BAREVALUE_MCP_URL): string {
  const override = (raw ?? '').trim();
  if (override === '') {
    return SERVICE_URL;
  }

  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new Error('BAREVALUE_MCP_URL is not an address. Remove it to use https://barevalue.com/mcp.');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.endsWith('.test');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('BAREVALUE_MCP_URL must be an https address. Remove it to use https://barevalue.com/mcp.');
  }

  return url.toString();
}

/**
 * Remove unpaired Unicode surrogates (U+D800-U+DFFF) from every string. They make the
 * client's JSON parser fail with "no low surrogate".
 */
function sanitize<T>(data: T): T {
  if (typeof data === 'string') {
    return data.replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      '�'
    ) as unknown as T;
  }
  if (Array.isArray(data)) {
    return data.map(sanitize) as unknown as T;
  }
  if (data !== null && typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[sanitize(key)] = sanitize(value);
    }
    return result as T;
  }
  return data;
}

type RpcAnswer = { id?: unknown; result?: Record<string, unknown>; error?: { message?: string } };

/**
 * The answer to call `id` in a streamed (text/event-stream) body, or null when it is not
 * there (yet). Events end at a blank line and only whole events are read; an event's
 * "data:" lines are one JSON message; lines may end in LF, CRLF or CR. Anything that is
 * not the answer to this call (a notification, a comment, another call's answer) is passed over.
 */
export function answerInStream(text: string, id: string): RpcAnswer | null {
  const events = text.split(/\r\n\r\n|\n\n|\r\r/);
  events.pop(); // what follows the last blank line is still arriving

  for (const event of events) {
    const data = event
      .split(/\r\n|\n|\r/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data === '') {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      if (message !== null && typeof message === 'object' && (message as RpcAnswer).id === id && ('result' in message || 'error' in message)) {
        return message as RpcAnswer;
      }
    }
  }

  return null;
}

/** One JSON-RPC call to the hosted server. Throws on a transport or protocol error. */
async function hosted(method: string, params?: Record<string, unknown>, cancel?: AbortSignal): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'User-Agent': `barevalue-mcp/${VERSION}`,
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  // One signal for the time limit and for the client's cancel (AbortSignal.any needs a
  // newer Node than this package asks for).
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), CALL_TIMEOUT_MS);
  const onCancel = () => stop.abort();
  if (cancel?.aborted) {
    stop.abort();
  }
  cancel?.addEventListener('abort', onCancel, { once: true });

  const id = randomUUID();
  let response: Response;
  let body: RpcAnswer | null = null;
  try {
    response = await fetch(HOSTED_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
      // Never followed: a redirect would send the call, and any key in it, somewhere else.
      redirect: 'error',
      signal: stop.signal,
    });

    if ((response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream') && response.body) {
      // A streamed answer: read until the answer to this call is in, and no longer. The
      // server may send other messages first and may leave the stream open afterwards.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (value) {
          text += decoder.decode(value, { stream: true });
        }
        // At the end, whatever is left counts as an event even with no blank line after it.
        body = answerInStream(done ? `${text}\n\n` : text, id);
        if (body || done) {
          if (!done) {
            reader.cancel().catch(() => undefined);
          }
          break;
        }
      }
    } else {
      const text = await response.text();
      try {
        body = JSON.parse(text);
      } catch {
        // A stream sent without saying so.
        body = answerInStream(`${text}\n\n`, id);
      }
    }
  } catch (error) {
    if (cancel?.aborted) {
      throw new Error('The call was cancelled.');
    }
    throw new Error(
      stop.signal.aborted
        ? `Barevalue did not answer within ${CALL_TIMEOUT_MS / 1000} seconds. Try again.`
        : `Barevalue could not be reached (${error instanceof Error ? error.message : 'network error'}).`
    );
  } finally {
    clearTimeout(timer);
    cancel?.removeEventListener('abort', onCancel);
  }

  if (body === null || typeof body !== 'object') {
    throw new Error(`Barevalue answered with HTTP ${response.status} and no readable body.`);
  }

  if (body.error || !body.result) {
    throw new Error(body.error?.message ?? `Barevalue answered with HTTP ${response.status}.`);
  }

  return body.result;
}

/**
 * The service's tools, as this machine offers them: the upload tool takes a path here,
 * and tools stop asking for an api_key once this session has one.
 */
async function listTools(): Promise<Tool[]> {
  if (toolsCache && Date.now() - toolsCache.at < TOOLS_TTL_MS) {
    return present(toolsCache.tools);
  }

  try {
    const result = await hosted('tools/list');
    toolsCache = { at: Date.now(), tools: (result.tools as Tool[]) ?? [] };
  } catch (error) {
    // An older list is better than none while the service is briefly unreachable.
    if (!toolsCache) {
      throw new McpError(ErrorCode.InternalError, error instanceof Error ? error.message : 'Barevalue could not be reached.');
    }
  }

  return present(toolsCache!.tools);
}

function present(tools: Tool[]): Tool[] {
  return tools.map((tool) => {
    if (tool.name === UPLOAD_TOOL) {
      return {
        ...tool,
        description:
          'Upload an audio file from this machine, for a recording that has no link. Give the path to the file. ' +
          'Returns an upload_id: then call barevalue_submit_url with that upload_id in place of file_url. ' +
          'One audio file with one audio track, up to 750 MB and 60 minutes. An upload can be ordered once, within 2 hours.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            file_path: { type: 'string', description: 'Absolute path to the audio file on this machine' },
            filename: { type: 'string', description: 'Optional name to store it under. Defaults to the name of the file.' },
          },
          required: ['file_path'],
        },
      };
    }

    if (!apiKey || !tool.inputSchema?.properties?.api_key) {
      return tool;
    }

    const { api_key: _unused, ...properties } = tool.inputSchema.properties;
    return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
  });
}

function textResult(payload: unknown, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** The JSON a tool answered with, when it did answer with JSON. */
function payloadOf(result: ToolResult): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(result.content?.[0]?.text ?? '');
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function callHostedTool(name: string, given: Record<string, unknown>, cancel?: AbortSignal): Promise<ToolResult> {
  // Once this session has a key, it is the only one used: the service prefers an api_key
  // argument over the header, and the arguments are written by a model that reads text
  // from anywhere. A key slipped in there would send this person's work to another account.
  const args = { ...given };
  const sentKey = apiKey;
  const droppedKey = sentKey !== null && typeof args.api_key === 'string' && args.api_key !== '';
  if (sentKey) {
    delete args.api_key;
  }

  const result = (await hosted('tools/call', { name, arguments: args }, cancel)) as unknown as ToolResult;
  const answer = payloadOf(result);

  // The service refused the key this server sent. Left as it is, every call from here on
  // gets the same refusal and nothing the agent can do changes it: an api_key argument is
  // dropped and barevalue_register does not replace a key. So say what happened and what
  // to do, in the result the agent reads.
  if (sentKey !== null && result.isError && answer?.error === 'unauthorized') {
    if (keyFromConfig) {
      // The user's own key stays the only key: no key from a model takes its place.
      return withFields(result, answer, {
        configured_key_refused: true,
        what_to_do:
          'Barevalue refused the API key in BAREVALUE_API_KEY, which is set in this MCP server\'s configuration: it is mistyped, revoked or expired. ' +
          'This server uses that key and no other' +
          (droppedKey ? ', so the api_key passed to this call was not used' : '') +
          ', and a key from barevalue_register will not be used either while it is set. Calling again will not help. ' +
          'Tell the user to do one of two things in the MCP configuration and then restart this server: ' +
          '(1) set BAREVALUE_API_KEY to a working key (barevalue.com, Settings, API Keys; it starts with bv_sk_), or ' +
          '(2) remove BAREVALUE_API_KEY, after which barevalue_register gives this session a key at once.',
      });
    }

    // A key this session got from barevalue_register: nobody configured it, so it can go.
    // The tools take api_key again and barevalue_register works again.
    if (apiKey === sentKey) {
      apiKey = null;
    }
    return withFields(result, answer, {
      session_key_forgotten: true,
      what_to_do:
        'Barevalue refused the key this session got from barevalue_register (it was revoked or has expired), so this server has dropped it. ' +
        'Call barevalue_register again for a new key, or pass a working key as api_key.',
    });
  }

  if (name === 'barevalue_register' && !result.isError && typeof answer?.api_key === 'string') {
    if (!apiKey) {
      // A new account's key is kept for this session, so the next tools need no key passed.
      // Never in place of a key this session already has.
      if (/^[\x21-\x7E]+$/.test(answer.api_key)) {
        apiKey = answer.api_key;
      }
    } else if (keyFromConfig) {
      return withFields(result, answer, {
        note: 'This MCP server keeps using the key in BAREVALUE_API_KEY from its configuration. The key above is not used by it: to use the new account, the user puts that key in BAREVALUE_API_KEY and restarts the server.',
      });
    }
  }

  return result;
}

/** The same tool result with fields added to its JSON, in the text and in the structured copy. */
function withFields(result: ToolResult, answer: Record<string, unknown>, fields: Record<string, unknown>): ToolResult {
  const body = { ...answer, ...fields };
  return {
    ...result,
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    ...(result.structuredContent !== undefined ? { structuredContent: body } : {}),
  };
}

/**
 * What is wrong with the upload address the service returned, or null when the file may
 * be sent there: https, our bucket's own host, the default port, no user name.
 * With BAREVALUE_MCP_URL set (our own testing) the test server itself may take the upload too.
 */
export function uploadAddressProblem(address: string, hostedAddress: string = HOSTED_URL): string | null {
  let target: URL;
  try {
    target = new URL(address);
  } catch {
    return 'it is not an address';
  }
  if (target.username !== '' || target.password !== '') {
    return 'it carries a user name';
  }

  if (hostedAddress !== SERVICE_URL) {
    const hosted = new URL(hostedAddress);
    if (target.protocol === hosted.protocol && target.host === hosted.host) {
      return null;
    }
  }

  if (target.protocol !== 'https:') {
    return 'it is not https';
  }
  if (target.port !== '') {
    return 'it names a port';
  }
  if (!UPLOAD_HOSTS.includes(target.hostname)) {
    return 'its host is not Barevalue storage';
  }

  return null;
}

/**
 * Send the file to the upload form as multipart/form-data, streamed: the form's fields
 * first, exactly as given, then the file, last. Resolves with the HTTP status.
 */
function postForm(
  url: string,
  fields: Record<string, string>,
  fileField: string,
  handle: fsPromises.FileHandle,
  filename: string,
  size: number,
  cancel: AbortSignal,
  onSent: (bytes: number) => void
): Promise<{ status: number; body: string }> {
  if (cancel.aborted) {
    return Promise.reject(new Error(CANCELLED));
  }

  const target = new URL(url);
  // Plain http only ever passes uploadAddressProblem() for our own test server.
  const request = target.protocol === 'http:' ? httpRequest : httpsRequest;

  const boundary = `----barevalue-${randomUUID()}`;
  const quoted = (value: string) => value.replace(/["\r\n]/g, '_');
  let head = '';
  for (const [name, value] of Object.entries(fields)) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(name)}"\r\n\r\n${value}\r\n`;
  }
  head += `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(fileField)}"; filename="${quoted(filename)}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;

  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          // S3 takes no chunked form posts: the whole length is stated up front.
          'Content-Length': Buffer.byteLength(head) + size + Buffer.byteLength(tail),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (body.length < 2000) {
            body += chunk;
          }
        });
        res.on('end', () => {
          settled();
          resolve({ status: res.statusCode ?? 0, body });
        });
      }
    );

    // From the handle that was checked, never from the name again. No further than the
    // size already stated, should the file grow meanwhile.
    const file = handle.createReadStream({ start: 0, end: size - 1, autoClose: false });

    // The client cancelled the call (or went away): stop sending at once. What was sent
    // so far is dropped by the other side, which never got the whole form.
    const onCancel = () => req.destroy(new Error(CANCELLED));
    const settled = () => {
      cancel.removeEventListener('abort', onCancel);
      file.destroy();
    };
    cancel.addEventListener('abort', onCancel, { once: true });

    req.setTimeout(UPLOAD_IDLE_TIMEOUT_MS, () => req.destroy(new Error('The upload stalled.')));
    req.on('error', (error) => {
      settled();
      reject(error);
    });
    req.write(head);

    let sent = 0;
    file.on('data', (chunk) => {
      sent += chunk.length;
      onSent(sent);
    });
    file.on('error', (error) => req.destroy(error));
    file.on('end', () => {
      // A file that got shorter meanwhile: fewer bytes than the length stated, which the
      // other side would wait for until the idle limit.
      if (file.bytesRead < size) {
        req.destroy(new Error('The file changed while it was being sent. Try again.'));
        return;
      }
      req.end(tail);
    });
    file.pipe(req, { end: false });
  });
}

/** `identity` is the file itself as it was when opened: which file, how long, last written when. */
type Recording = { handle: fsPromises.FileHandle; size: number; identity: string };

/** What a tool call brought with it: the client's cancel, and where to report progress if it asked. */
type CallContext = {
  signal?: AbortSignal;
  progress?: (sent: number, total: number, message: string) => void;
};

/** One upload on its way, and the calls waiting for it. */
type Transfer = {
  key: string;
  filename: string;
  size: number;
  sent: number;
  waiting: number;
  watchers: Set<(force: boolean) => void>;
  stop: AbortController;
  result: Promise<ToolResult> | null;
};

const transfers = new Map<string, Transfer>();
/** Upload forms that were asked for and not used up, by the same key as `transfers`. */
const spareForms = new Map<string, { details: Record<string, unknown>; until: number }>();

/**
 * Open the recording once and check what was opened, not what a name pointed at a moment
 * ago: a file checked by name and opened by name afterwards can be swapped in between by
 * anyone who can write to its folder. Everything after this reads from the handle.
 *
 *   - no link is followed at the last step (the name was already resolved by realpath), and
 *     the open does not wait on a pipe that happens to be named like a recording;
 *   - it must be a regular file, with something in it;
 *   - it must have one name only: a hard link named episode.mp3 is some other file under an
 *     audio name, and realpath cannot see through it the way it does a symbolic link.
 */
async function openRecording(realPath: string, asGiven: string): Promise<Recording | ToolResult> {
  const refuse = (error: string, message: string) => textResult({ error, message }, true);

  let handle: fsPromises.FileHandle;
  try {
    // The two extra flags do not exist on Windows, where they count as 0.
    handle = await fsPromises.open(realPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return refuse('file_not_found', `No file at ${asGiven}.`);
    }
    if (code === 'ELOOP' || code === 'EMLINK') {
      return refuse('file_changed', `${asGiven} was replaced by a link while it was being checked. Nothing was sent.`);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return refuse('file_not_readable', `${asGiven} cannot be read: this program has no permission to open it.`);
    }
    return refuse('not_a_file', `${asGiven} is not a file that can be read${code ? ` (${code})` : ''}.`);
  }

  const changed = () => refuse('file_changed', `${asGiven} changed while it was being checked. Nothing was sent. Try again.`);
  let refusal: ToolResult | null = null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      refusal = refuse('not_a_file', `${asGiven} is not a file.`);
    } else if (stat.nlink > 1) {
      refusal = refuse(
        'file_has_other_names',
        `${asGiven} has more than one name on this disk (a hard link), so its name does not say what it is. Copy it to a new file and upload the copy.`
      );
    } else {
      // The name must still be this very file and not a link. Where a link cannot be
      // refused at the open (Windows), this is what notices one put there meanwhile.
      const named = await fsPromises.lstat(realPath);
      const same =
        !named.isSymbolicLink() &&
        named.size === stat.size &&
        (process.platform === 'win32' || (named.dev === stat.dev && named.ino === stat.ino));
      if (!same) {
        refusal = changed();
      } else if (stat.size === 0) {
        refusal = refuse('empty_file', `${asGiven} is empty.`);
      } else {
        return { handle, size: stat.size, identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` };
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      await handle.close().catch(() => undefined);
      throw error;
    }
    refusal = changed();
  }

  await handle.close().catch(() => undefined);
  return refusal;
}

/**
 * Whether the real file's name is a recording's, and the name to store it under. By the
 * rules for paths of the machine this runs on; the tests pass Windows' rules by hand.
 */
export function audioName(
  realPath: string,
  paths: { basename(path: string): string; extname(path: string): string } = { basename, extname }
): { audio: boolean; extension: string; name: string } {
  const extension = paths.extname(realPath).toLowerCase();
  return { audio: AUDIO_EXTENSIONS.includes(extension), extension, name: paths.basename(realPath) };
}

/** barevalue_upload on this machine: ask for a form, send the file, hand back the upload_id. */
async function uploadLocalFile(args: Record<string, unknown>, context: CallContext = {}): Promise<ToolResult> {
  const filePath = typeof args.file_path === 'string' ? args.file_path : '';
  if (filePath === '') {
    return textResult({ error: 'file_path_required', message: 'Give file_path, the path to the audio file on this machine.' }, true);
  }

  // By the real file's name, after any symbolic link: the path is chosen by a model, and
  // this tool must not be a way to send some other file from this machine.
  let realPath: string;
  try {
    realPath = realpathSync(filePath);
  } catch {
    return textResult({ error: 'file_not_found', message: `No file at ${filePath}.` }, true);
  }
  const named = audioName(realPath);
  if (!named.audio) {
    return textResult(
      { error: 'not_an_audio_file', message: `Only audio files are uploaded (${AUDIO_EXTENSIONS.join(', ')}). ${filePath} is not one.` },
      true
    );
  }

  if (context.signal?.aborted) {
    return uploadCancelled();
  }

  const recording = await openRecording(realPath, filePath);
  if ('content' in recording) {
    return recording;
  }

  const filename = typeof args.filename === 'string' && args.filename !== '' ? args.filename : named.name;
  // One upload at a time for one file, under one name, for one account.
  const account = apiKey ?? (typeof args.api_key === 'string' ? args.api_key : '');
  const key = `${recording.identity}\n${filename}\n${account}`;

  // A second call for a file that is still on its way (a client that gave up waiting and
  // asked again) does not start a second upload beside the first: it waits for the first
  // one and gets the same upload_id.
  let transfer = transfers.get(key);
  const joined = transfer !== undefined;
  if (transfer) {
    await recording.handle.close().catch(() => undefined);
  } else {
    const started: Transfer = { key, filename, size: recording.size, sent: 0, waiting: 0, watchers: new Set(), stop: new AbortController(), result: null };
    started.result = sendRecording(recording, started, args)
      // Whoever is still waiting gets what went wrong as an answer, in the handler's own words.
      .catch((error): ToolResult => (started.stop.signal.aborted ? uploadCancelled() : bridgeError(error)))
      .finally(async () => {
        if (transfers.get(key) === started) {
          transfers.delete(key);
        }
        await recording.handle.close().catch(() => undefined);
      });
    transfers.set(key, started);
    transfer = started;
  }

  return attend(transfer, context, joined);
}

/**
 * Wait for an upload on behalf of one call: pass its progress on, and leave when the
 * client cancels that call. The upload itself stops once nobody is waiting for it.
 */
async function attend(transfer: Transfer, context: CallContext, joined: boolean): Promise<ToolResult> {
  let lastAt = 0;
  let lastSent = -1;
  const megabytes = (bytes: number) => (bytes / 1048576).toFixed(1);
  const watcher = (force: boolean) => {
    const now = Date.now();
    if (!context.progress || transfer.sent <= lastSent || (!force && now - lastAt < PROGRESS_EVERY_MS)) {
      return;
    }
    lastAt = now;
    lastSent = transfer.sent;
    context.progress(
      transfer.sent,
      transfer.size,
      transfer.sent >= transfer.size
        ? `Uploaded ${transfer.filename} (${megabytes(transfer.size)} MB)`
        : `Uploading ${transfer.filename}: ${megabytes(transfer.sent)} of ${megabytes(transfer.size)} MB`
    );
  };

  let onCancel: (() => void) | undefined;
  const cancelled = new Promise<null>((resolve) => {
    onCancel = () => resolve(null);
    if (context.signal?.aborted) {
      onCancel();
    }
    context.signal?.addEventListener('abort', onCancel, { once: true });
  });

  transfer.waiting++;
  transfer.watchers.add(watcher);
  let outcome: ToolResult | null = null;
  try {
    outcome = await Promise.race([transfer.result as Promise<ToolResult>, cancelled]);
  } finally {
    transfer.watchers.delete(watcher);
    if (onCancel) {
      context.signal?.removeEventListener('abort', onCancel);
    }
    transfer.waiting--;
  }

  if (outcome === null) {
    // This call was cancelled. With no other call waiting for the same upload, it stops,
    // and the next call for this file starts over (with the same form while it is good).
    if (transfer.waiting === 0) {
      if (transfers.get(transfer.key) === transfer) {
        transfers.delete(transfer.key);
      }
      transfer.stop.abort();
    }
    return uploadCancelled();
  }

  if (joined && !outcome.isError) {
    const answer = payloadOf(outcome);
    if (answer) {
      return withFields(outcome, answer, {
        note: 'An earlier call was already uploading this file: this is that same upload, not a second one. Order it once.',
      });
    }
  }

  return outcome;
}

function uploadCancelled(): ToolResult {
  return textResult({ error: 'upload_cancelled', message: `${CANCELLED} Nothing was ordered. Call barevalue_upload again to send the file.` }, true);
}

/** What went wrong on this side (the network, a local file), as a tool result. */
function bridgeError(error: unknown): ToolResult {
  return textResult({ error: 'bridge_error', message: error instanceof Error ? error.message : 'The call could not be made.' }, true);
}

/** Forget forms that can no longer be used, and all but the newest few. */
function tidySpareForms(): void {
  const now = Date.now();
  for (const [key, spare] of spareForms) {
    if (spare.until <= now || spareForms.size > 8) {
      spareForms.delete(key);
    }
  }
}

/** The opened recording goes to the service: a form is asked for, the file is posted to it. */
async function sendRecording(recording: Recording, transfer: Transfer, args: Record<string, unknown>): Promise<ToolResult> {
  const { handle, size } = recording;
  const { filename, key } = transfer;
  const cancel = transfer.stop.signal;

  // An upload that was stopped part-way (cancelled, a dropped connection) left its form
  // unused, and the form stays good for some minutes. The same file, asked for again, goes
  // to that form: the account holds only a few uploads that have not been ordered, and a
  // new form for every attempt would use them up on one file.
  tidySpareForms();
  const spare = spareForms.get(key);
  spareForms.delete(key);

  let details: Record<string, unknown> | null;
  let until: number;
  if (spare) {
    ({ details, until } = spare);
  } else {
    const asked = Date.now();
    const form = await callHostedTool(
      UPLOAD_TOOL,
      { filename, size_bytes: size, ...(typeof args.api_key === 'string' ? { api_key: args.api_key } : {}) },
      cancel
    );
    if (form.isError) {
      return form;
    }
    details = payloadOf(form);
    const minutes = typeof details?.expires_in_minutes === 'number' ? details.expires_in_minutes : 0;
    until = asked + (minutes - SPARE_FORM_MARGIN_MINUTES) * 60 * 1000;
  }

  const url = details?.upload_url;
  const fields = details?.upload_fields;
  const uploadId = details?.upload_id;
  if (typeof url !== 'string' || typeof uploadId !== 'string' || fields === null || typeof fields !== 'object') {
    return textResult({ error: 'unexpected_answer', message: 'Barevalue did not return an upload form.' }, true);
  }

  const problem = uploadAddressProblem(url);
  if (problem !== null) {
    return textResult(
      {
        error: 'unexpected_upload_address',
        message:
          `The upload address Barevalue returned is not one this version sends files to (${problem}), so nothing was sent. ` +
          'Update the package (npx -y barevalue-mcp@latest) and try again. If it still happens, write to support@barevalue.com.',
      },
      true
    );
  }

  const tell = (force: boolean) => {
    for (const watcher of transfer.watchers) {
      watcher(force);
    }
  };

  let sent: { status: number; body: string };
  try {
    sent = await postForm(
      url,
      fields as Record<string, string>,
      typeof details?.file_field === 'string' ? details.file_field : 'file',
      handle,
      filename,
      size,
      cancel,
      (bytes) => {
        // Not the whole of it until storage has answered: read from disk is not yet stored.
        transfer.sent = Math.min(bytes, size - 1);
        tell(false);
      }
    );
  } catch (error) {
    // Storage never answered, so the form was not used up.
    if (details && until > Date.now()) {
      spareForms.set(key, { details, until });
    }
    throw error;
  }

  if (sent.status < 200 || sent.status >= 300) {
    const reason = /<Code>([^<]+)<\/Code>/.exec(sent.body)?.[1];
    return textResult(
      {
        error: 'upload_failed',
        message:
          reason === 'EntityTooLarge'
            ? 'The file is larger than the 750 MB limit. Send a smaller file, for example an MP3.'
            : `Storage refused the upload (HTTP ${sent.status}${reason ? `, ${reason}` : ''}). Ask for a new upload and try again.`,
      },
      true
    );
  }

  transfer.sent = size;
  tell(true);

  return textResult({
    upload_id: uploadId,
    uploaded_bytes: size,
    filename,
    next: 'Call barevalue_submit_url with this upload_id (in place of file_url), podcast_name and episode_name.',
    submit_within_minutes: details?.submit_within_minutes,
  });
}

/** One line to stderr and out: a configuration this server cannot start with. */
function refuseToStart(message: string): never {
  console.error(`barevalue-mcp did not start: ${message}`);
  process.exit(1);
}

async function main() {
  const configured = readConfiguredKey(process.env.BAREVALUE_API_KEY);
  if (configured.problem !== null) {
    refuseToStart(configured.problem);
  }
  apiKey = configured.key;
  keyFromConfig = apiKey !== null;

  try {
    HOSTED_URL = hostedUrl();
  } catch (error) {
    refuseToStart(error instanceof Error ? error.message : 'BAREVALUE_MCP_URL is not usable.');
  }

  const server = new Server({ name: 'barevalue-mcp', version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: sanitize(await listTools()) }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const given = (args ?? {}) as Record<string, unknown>;

    // A client that wants to hear how far a long call is sends a progress token with it.
    const token = request.params._meta?.progressToken;
    const context: CallContext = {
      signal: extra?.signal,
      progress:
        token === undefined || typeof extra?.sendNotification !== 'function'
          ? undefined
          : (sent, total, message) => {
              extra
                .sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: sent, total, message } })
                .catch(() => undefined);
            },
    };

    try {
      return sanitize(name === UPLOAD_TOOL ? await uploadLocalFile(given, context) : await callHostedTool(name, given, context.signal));
    } catch (error) {
      // What is thrown here is ours (the network, a local file): the service's own
      // refusals come back as tool results and are passed on untouched.
      return bridgeError(error);
    }
  });

  // The client went away: nobody is left to hand an upload_id to, so no upload carries on.
  process.stdin.on('end', () => {
    for (const transfer of transfers.values()) {
      transfer.stop.abort();
    }
  });

  await server.connect(new StdioServerTransport());

  // To stderr, so it does not interfere with the protocol on stdout.
  console.error(`Barevalue MCP server ${VERSION} started (${HOSTED_URL})`);
}

// Run as the program (node dist/index.js, npx barevalue-mcp); the tests load it for its checks.
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
