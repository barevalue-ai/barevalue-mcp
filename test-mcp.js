#!/usr/bin/env node

/**
 * Tests for the bridge. Two parts:
 *
 *   1. Live: starts dist/index.js, speaks MCP to it over stdio and checks that the tool
 *      list and a tool call come back from the hosted server. Read-only, needs no key.
 *   2. Local: the same bridge against a stub of the hosted server and of the S3 form post,
 *      started inside this process. Nothing leaves this machine and no key is needed.
 *
 *   node test-mcp.js                 # both parts
 *   node test-mcp.js --offline       # the local part only
 *   BAREVALUE_API_KEY=... node test-mcp.js /path/to/audio.mp3
 *                                    # the live part also uploads the file (no order is placed)
 *
 * BAREVALUE_MCP_URL points the live part at another server (ours only: the key is sent there).
 * The bridge runs under the same node as this file: `npx -y node@18 test-mcp.js` tries Node 18.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const BRIDGE = path.join(__dirname, 'dist/index.js');
const offline = process.argv.includes('--offline');
const uploadPath = process.argv.slice(2).find((arg) => !arg.startsWith('--'));

const failures = [];
let checks = 0;
function check(name, ok, detail) {
  checks++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start the bridge and speak MCP to it. `env` replaces the two BAREVALUE_ variables. */
function startBridge(env = {}, { inheritStderr = false } = {}) {
  const base = { ...process.env };
  delete base.BAREVALUE_API_KEY;
  delete base.BAREVALUE_MCP_URL;
  const proc = spawn(process.execPath, [BRIDGE], { env: { ...base, ...env }, stdio: ['pipe', 'pipe', inheritStderr ? 'inherit' : 'pipe'] });

  const bridge = { proc, stderr: '', notifications: [], exitCode: undefined };
  bridge.exited = new Promise((resolve) => proc.on('exit', (code) => { bridge.exitCode = code; resolve(code); }));
  if (!inheritStderr) proc.stderr.on('data', (chunk) => { bridge.stderr += chunk.toString(); });

  let buffer = '';
  const waiting = new Map();
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === '') continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && waiting.has(message.id)) {
        waiting.get(message.id)(message);
        waiting.delete(message.id);
      } else if (message.method) {
        bridge.notifications.push(message);
      }
    }
  });

  let nextId = 1;
  bridge.notify = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n');
  /** Sends a request. The promise has the request's id on it, for a cancel. */
  bridge.rpc = (method, params, timeoutMs = 300000) => {
    const id = nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
    });
    promise.id = id;
    return promise;
  };
  bridge.call = (name, args = {}, meta) => bridge.rpc('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  bridge.init = async () => {
    const init = await bridge.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    bridge.notify('notifications/initialized');
    return init;
  };
  bridge.kill = () => proc.kill();
  return bridge;
}

/** The JSON a tool answered with. */
function payload(message) {
  try {
    return JSON.parse(message.result?.content?.[0]?.text ?? '');
  } catch {
    return null;
  }
}

// ───── Part 1: the live service ─────

async function live() {
  console.log('\n# Live: the hosted server\n');
  const env = {};
  if (process.env.BAREVALUE_API_KEY) env.BAREVALUE_API_KEY = process.env.BAREVALUE_API_KEY;
  if (process.env.BAREVALUE_MCP_URL) env.BAREVALUE_MCP_URL = process.env.BAREVALUE_MCP_URL;
  const bridge = startBridge(env, { inheritStderr: true });

  try {
    const init = await bridge.init();
    check('initialize', init.result?.serverInfo?.name === 'barevalue-mcp', init.result?.serverInfo?.version);

    const list = await bridge.rpc('tools/list');
    const tools = list.result?.tools ?? [];
    const names = tools.map((tool) => tool.name);
    check('tools come from the hosted server', names.includes('barevalue_submit_url') && names.includes('barevalue_status'), `${names.length} tools`);
    const keyed = Boolean((process.env.BAREVALUE_API_KEY ?? '').trim());
    const status = tools.find((tool) => tool.name === 'barevalue_status');
    check(
      keyed ? 'with a key, tools do not ask for api_key' : 'without a key, tools take api_key',
      Boolean(status) && ('api_key' in (status.inputSchema.properties ?? {})) === !keyed
    );
    const upload = tools.find((tool) => tool.name === 'barevalue_upload');
    if (upload) {
      check('the upload tool takes a path on this machine', upload.inputSchema.required?.[0] === 'file_path');
    } else {
      console.log('note uploads are not offered by the server right now');
    }

    const pricing = await bridge.call('barevalue_pricing');
    check('a public tool answers without a key', pricing.result && !pricing.result.isError);

    const missing = await bridge.call('barevalue_upload', { file_path: '/nonexistent/episode.mp3' });
    check('a missing file is refused here, before any call', missing.result?.isError === true && /file_not_found/.test(missing.result.content[0].text));

    const notAudio = await bridge.call('barevalue_upload', { file_path: path.join(__dirname, 'package.json'), filename: 'episode.mp3' });
    check('a file that is not audio is refused here, whatever name is given', notAudio.result?.isError === true && /not_an_audio_file/.test(notAudio.result.content[0].text));

    if (uploadPath) {
      const sent = await bridge.call('barevalue_upload', { file_path: uploadPath });
      const text = sent.result?.content?.[0]?.text ?? '';
      check('the file is uploaded and an upload_id comes back', !sent.result?.isError && /"upload_id": "up_/.test(text), text.replace(/\s+/g, ' ').slice(0, 160));
    }
  } finally {
    bridge.kill();
  }
}

// ───── Part 2: a stub of the hosted server and of the S3 form post ─────

const API_KEY_PROPERTY = { type: 'string', description: 'Barevalue API key (bv_sk_...). Get one with barevalue_register.' };
const TOOLS = [
  { name: 'barevalue_pricing', description: 'Prices', inputSchema: { type: 'object', properties: {} } },
  { name: 'barevalue_register', description: 'Sign up', inputSchema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] } },
  { name: 'barevalue_account', description: 'Account', inputSchema: { type: 'object', properties: { api_key: API_KEY_PROPERTY } } },
  { name: 'barevalue_upload', description: 'Upload', inputSchema: { type: 'object', properties: { filename: { type: 'string' }, size_bytes: { type: 'number' }, api_key: API_KEY_PROPERTY }, required: ['filename'] } },
  {
    name: 'barevalue_submit_url',
    description: 'Order',
    inputSchema: {
      type: 'object',
      properties: { file_url: { type: 'string' }, upload_id: { type: 'string' }, podcast_name: { type: 'string' }, episode_name: { type: 'string' }, host_names: { type: 'array' }, idempotency_key: { type: 'string' }, api_key: API_KEY_PROPERTY },
      required: ['podcast_name', 'episode_name'],
    },
  },
];

function toolAnswer(status, body) {
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 4) }], isError: status >= 400, structuredContent: body };
}

/**
 * The stub. `stub.tool(name, args, key, request)` answers a tool call with [status, body];
 * `stub.calls` and `stub.posts` record what arrived. Tests set the fields they need and
 * call stub.reset() between cases.
 */
async function startStub() {
  const stub = { calls: [], posts: [], sockets: new Set() };
  stub.reset = () => {
    stub.calls = [];
    stub.posts = [];
    stub.goodKeys = null; // null: any key is good. Otherwise a list of the keys that work.
    stub.tool = null;
    stub.uploadUrl = null; // the address handed out for the form post; default: this stub
    stub.uploadStatus = 204;
    stub.uploadBody = '';
    stub.drainBytesPerTick = 0; // 0: read the post as fast as it comes. Otherwise bytes per 50 ms.
    stub.answer = 'json'; // how /mcp answers: json, sse, sse-crlf, sse-progress, sse-open, sse-split
    stub.uploadsOpened = 0;
    stub.dropCalls = 0; // how many of the next tool calls get no answer: the connection is dropped
    stub.ordersPlaced = 0;
    // What storage does with a post: null answers it. Otherwise 'drop' (the connection goes
    // while the file is arriving), 'headers-then-drop' and 'headers-then-stall' (the answer's
    // headers, and then the connection goes or nothing more comes), 'stall' (no answer at all),
    // 'early-200' and 'early-403' (a whole answer while the file is still arriving).
    stub.uploadMode = null;
  };
  stub.reset();

  const server = http.createServer((req, res) => {
    if (req.url === '/mcp') {
      let text = '';
      req.on('data', (chunk) => { text += chunk; });
      req.on('end', () => {
        const message = JSON.parse(text);
        const key = (req.headers.authorization ?? '').replace(/^Bearer /, '') || null;
        let result;
        if (message.method === 'tools/list') {
          result = { tools: TOOLS };
        } else {
          const { name, arguments: args = {} } = message.params;
          stub.calls.push({ name, args, key, userAgent: req.headers['user-agent'] });
          const used = typeof args.api_key === 'string' && args.api_key !== '' ? args.api_key : key;
          let answer = stub.tool ? stub.tool(name, args, used) : undefined;
          if (!answer) {
            if (name === 'barevalue_pricing') {
              answer = [200, { price: 'free' }];
            } else if (name === 'barevalue_register') {
              answer = [201, { api_key: 'bv_sk_registered', email: args.email }];
            } else if (!used) {
              answer = [401, { error: 'api_key_required', message: 'This tool needs an API key.' }];
            } else if (stub.goodKeys && !stub.goodKeys.includes(used)) {
              answer = [401, { error: 'unauthorized', message: 'Invalid or revoked API key' }];
            } else if (name === 'barevalue_submit_url') {
              stub.ordersPlaced++;
              answer = [200, { order_id: 1000 + stub.ordersPlaced, status: 'queued' }];
            } else if (name === 'barevalue_upload') {
              stub.uploadsOpened++;
              const id = `up_${String(stub.uploadsOpened).padStart(4, '0')}`;
              answer = [201, {
                upload_id: id,
                upload_url: stub.uploadUrl ?? `${stub.origin}/upload`,
                upload_fields: { key: `_api_uploads/1/${id}/${args.filename}`, Policy: 'cG9saWN5', 'X-Amz-Signature': 'sig' },
                file_field: 'file',
                expires_in_minutes: 15,
                submit_within_minutes: 120,
              }];
            } else {
              answer = [200, { account: used }];
            }
          }
          result = toolAnswer(answer[0], answer[1]);
          if (stub.dropCalls > 0) {
            // The call arrived and was acted on, and no answer goes back: as when the
            // service is slow or the line breaks after the order was placed.
            stub.dropCalls--;
            req.socket.destroy();
            return;
          }
        }

        const rpc = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
        if (stub.answer === 'json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(rpc);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const progress = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 1 } });
        const other = JSON.stringify({ jsonrpc: '2.0', id: 'someone-else', result: { content: [{ type: 'text', text: '{"wrong":"answer"}' }] } });
        if (stub.answer === 'sse') {
          res.end(`event: message\ndata: ${rpc}\n\n`);
        } else if (stub.answer === 'sse-crlf') {
          res.end(`: hello\r\nevent: message\r\nid: 7\r\ndata: ${rpc}\r\n\r\n`);
        } else if (stub.answer === 'sse-progress') {
          // Other messages before the answer and after it, and the answer's JSON over two data lines.
          const cut = rpc.indexOf(',') + 1;
          res.end(`data: ${progress}\n\ndata: ${other}\n\nevent: message\ndata: ${rpc.slice(0, cut)}\ndata: ${rpc.slice(cut)}\n\ndata: ${progress}\n\n: bye\n\n`);
        } else if (stub.answer === 'sse-split') {
          // The answer arrives in pieces, cut in the middle of the JSON.
          const whole = `event: message\ndata: ${rpc}\n\n`;
          const half = Math.floor(whole.length / 2);
          res.write(whole.slice(0, half));
          setTimeout(() => res.end(whole.slice(half)), 150);
        } else if (stub.answer === 'sse-open') {
          // The answer, and then the stream is left open (closed here after 20 s).
          res.write(`event: message\ndata: ${rpc}\n\n`);
          const timer = setTimeout(() => res.end(), 20000);
          res.on('close', () => clearTimeout(timer));
        } else if (stub.answer === 'sse-empty') {
          res.end(`data: ${progress}\n\n`);
        }
      });
      return;
    }

    if (req.url.startsWith('/upload')) {
      const post = { url: req.url, bytes: 0, chunks: [], done: false, aborted: false, startedAt: Date.now() };
      stub.posts.push(post);
      const mode = stub.uploadMode;
      req.on('data', (chunk) => {
        post.bytes += chunk.length;
        post.chunks.push(chunk);
        if (mode === 'drop') {
          req.socket.destroy();
          return;
        }
        if (mode === 'early-200' || mode === 'early-403') {
          // An answer while the file is still arriving, and nothing more is read.
          if (!post.answeredEarly) {
            post.answeredEarly = true;
            post.bytesAtAnswer = post.bytes;
            const refusal = '<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>';
            res.writeHead(mode === 'early-200' ? 200 : 403, { 'Content-Type': 'application/xml' });
            res.end(mode === 'early-200' ? '' : refusal);
          }
          req.pause();
          return;
        }
        if (stub.drainBytesPerTick > 0) {
          post.window = (post.window ?? 0) + chunk.length;
          if (post.window >= stub.drainBytesPerTick) {
            post.window = 0;
            req.pause();
            setTimeout(() => req.resume(), 50);
          }
        }
      });
      req.socket.once('close', () => { post.socketClosed = true; });
      req.on('aborted', () => { post.aborted = true; });
      req.on('close', () => { if (!post.done) post.aborted = true; });
      req.on('end', () => {
        post.done = true;
        const body = Buffer.concat(post.chunks);
        post.chunks = [];
        const boundary = /boundary=(.+)$/.exec(req.headers['content-type'] ?? '')?.[1];
        const marker = Buffer.from('Content-Type: application/octet-stream\r\n\r\n');
        const start = body.indexOf(marker);
        const end = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--\r\n`));
        const file = start === -1 || end === -1 ? Buffer.alloc(0) : body.subarray(start + marker.length, end);
        post.fileBytes = file.length;
        post.sha = crypto.createHash('sha256').update(file).digest('hex');
        post.head = body.subarray(0, Math.max(0, start)).toString();
        if (mode === 'stall') {
          return; // the whole form is in and nothing is ever said
        }
        if (mode === 'headers-then-drop' || mode === 'headers-then-stall') {
          // The start of an answer: the status and headers that promise a body.
          res.writeHead(200, { 'Content-Type': 'application/xml', 'Content-Length': 500 });
          res.flushHeaders();
          if (mode === 'headers-then-drop') {
            setTimeout(() => req.socket.destroy(), 80);
          }
          return;
        }
        res.writeHead(stub.uploadStatus, stub.uploadBody ? { 'Content-Type': 'application/xml' } : {});
        res.end(stub.uploadBody);
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });
  server.on('connection', (socket) => {
    stub.sockets.add(socket);
    socket.on('close', () => stub.sockets.delete(socket));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  stub.origin = `http://127.0.0.1:${server.address().port}`;
  stub.url = `${stub.origin}/mcp`;
  stub.close = () => new Promise((resolve) => {
    for (const socket of stub.sockets) socket.destroy();
    server.close(resolve);
  });
  return stub;
}

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/** A folder of files to upload, removed at the end. */
function makeFixtures() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'barevalue-mcp-test-')));
  const write = (name, bytes) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    return file;
  };
  return { dir, write, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Start a bridge, see whether it exits by itself, and with what. */
async function startAndWatch(env, waitMs = 8000) {
  const bridge = startBridge(env);
  const code = await Promise.race([bridge.exited, sleep(waitMs).then(() => 'running')]);
  return { bridge, code };
}

// (5) The key in the environment
async function keyAtStartup(stub, lib) {
  console.log('\n# The key in the environment\n');
  const SECRET = 'bv_sk_secretvalue123';

  const refused = [
    ['empty double quotes', '""', /empty quotes/],
    ['empty single quotes', "''", /empty quotes/],
    ['two layers of quotes', `"'${SECRET}'"`, /quote marks/],
    ['the same quote twice', `""${SECRET}""`, /quote marks/],
    ['a quote that is not closed', `"${SECRET}`, /quote marks/],
    ['a space inside', 'bv_sk secret', /space/],
  ];
  for (const [name, value, pattern] of refused) {
    const { bridge, code } = await startAndWatch({ BAREVALUE_API_KEY: value, BAREVALUE_MCP_URL: stub.url });
    const lines = bridge.stderr.trim().split('\n');
    check(
      `a key with ${name} stops the start with one line that says how to set it`,
      code === 1 && lines.length === 1 && pattern.test(lines[0]) && /BAREVALUE_API_KEY/.test(lines[0]) && /bv_sk_\.\.\./.test(lines[0]) && !lines[0].includes('secret'),
      code === 1 ? lines[0].slice(0, 90) : `exit ${code}, ${bridge.stderr.slice(0, 120)}`
    );
    bridge.kill();
  }

  const accepted = [
    ['a bare key', SECRET, SECRET],
    ['a key in one layer of double quotes', `"${SECRET}"`, SECRET],
    ['a key in single quotes with spaces around', `  '${SECRET}'  `, SECRET],
    ['no key', undefined, null],
    ['an empty value', '', null],
    ['a value of spaces', '   ', null],
  ];
  for (const [name, value, expected] of accepted) {
    stub.reset();
    const bridge = startBridge({ ...(value === undefined ? {} : { BAREVALUE_API_KEY: value }), BAREVALUE_MCP_URL: stub.url });
    await bridge.init();
    await bridge.call('barevalue_pricing');
    const list = await bridge.rpc('tools/list');
    const account = list.result.tools.find((tool) => tool.name === 'barevalue_account');
    const asksForKey = 'api_key' in account.inputSchema.properties;
    check(
      `${name} starts, ${expected ? 'and that key is sent' : 'without a key'}`,
      bridge.exitCode === undefined && stub.calls[0]?.key === expected && asksForKey === (expected === null)
    );
    bridge.kill();
  }

  check('the check itself: a good key', lib.readConfiguredKey(` "${SECRET}" `).key === SECRET && lib.readConfiguredKey(SECRET).problem === null);
  check('the check itself: nothing set is no key and no problem', lib.readConfiguredKey(undefined).key === null && lib.readConfiguredKey('').problem === null);
  check('the check itself: a problem never carries the value', ['""x""', `'"${SECRET}"'`, `${SECRET} x`].every((value) => {
    const { key, problem } = lib.readConfiguredKey(value);
    return key === null && typeof problem === 'string' && !problem.includes('x"') && !problem.includes(SECRET);
  }));

  const bad = await startAndWatch({ BAREVALUE_MCP_URL: 'http://example.com/mcp' });
  check('an address that is not https stops the start with one line', bad.code === 1 && bad.bridge.stderr.trim().split('\n').length === 1 && /https/.test(bad.bridge.stderr));
  bad.bridge.kill();
}

// (3) A key the service refuses
async function refusedKey(stub, fixtures) {
  console.log('\n# A key the service refuses\n');
  const DEAD = 'bv_sk_deadconfigured';
  const GOOD = 'bv_sk_goodconfigured';
  const audio = fixtures.write('refused-key.mp3', Buffer.from('ID3 some audio'));

  // The configured key has been revoked.
  stub.reset();
  stub.goodKeys = [GOOD, 'bv_sk_registered', 'bv_sk_models'];
  let bridge = startBridge({ BAREVALUE_API_KEY: DEAD, BAREVALUE_MCP_URL: stub.url });
  await bridge.init();

  let answer = await bridge.call('barevalue_account');
  let body = payload(answer);
  check(
    'a refused configured key: the answer says which key, and what the user must do',
    answer.result.isError === true && body.error === 'unauthorized' && body.configured_key_refused === true &&
      /BAREVALUE_API_KEY/.test(body.what_to_do) && /restart/.test(body.what_to_do) && /remove BAREVALUE_API_KEY/.test(body.what_to_do) &&
      /no Barevalue account yet/.test(body.what_to_do) && /already has an account is refused/.test(body.what_to_do) && !/at once/.test(body.what_to_do) &&
      /Settings, API Keys/.test(body.what_to_do) && body.message === 'Invalid or revoked API key' && !answer.result.content[0].text.includes(DEAD),
    body.what_to_do?.slice(0, 70)
  );
  check('a refused configured key: the structured copy says the same', answer.result.structuredContent?.what_to_do === body.what_to_do);

  answer = await bridge.call('barevalue_account', { api_key: 'bv_sk_models' });
  body = payload(answer);
  const last = stub.calls[stub.calls.length - 1];
  check(
    'a refused configured key: a key from the model still does not take its place, and the answer says it was not used',
    answer.result.isError === true && last.key === DEAD && !('api_key' in last.args) && /api_key passed to this call was not used/.test(body.what_to_do)
  );

  answer = await bridge.call('barevalue_register', { email: 'someone@example.com' });
  body = payload(answer);
  check('a refused configured key: barevalue_register answers, with a note that its key is not used here', !answer.result.isError && body.api_key === 'bv_sk_registered' && /keeps using the key in BAREVALUE_API_KEY/.test(body.note));
  answer = await bridge.call('barevalue_account');
  check('a refused configured key: the registered key did not replace it', stub.calls[stub.calls.length - 1].key === DEAD && payload(answer).configured_key_refused === true);

  answer = await bridge.call('barevalue_upload', { file_path: audio });
  check('a refused configured key: an upload gets the same explanation and sends nothing', answer.result.isError === true && payload(answer).configured_key_refused === true && stub.posts.length === 0);
  bridge.kill();

  // A configured key that works: nothing is added.
  stub.reset();
  stub.goodKeys = [GOOD];
  bridge = startBridge({ BAREVALUE_API_KEY: GOOD, BAREVALUE_MCP_URL: stub.url });
  await bridge.init();
  answer = await bridge.call('barevalue_account');
  check('a working configured key: the answer is passed on as it came', !answer.result.isError && JSON.stringify(payload(answer)) === JSON.stringify({ account: GOOD }));
  answer = await bridge.call('barevalue_account', { api_key: 'bv_sk_models' });
  check('a working configured key: it is used, not the one a model passed', !answer.result.isError && payload(answer).account === GOOD && !('api_key' in stub.calls[1].args));
  stub.tool = () => [429, { error: 'window_limit_reached', message: 'Slow down', retry_after: 60 }];
  answer = await bridge.call('barevalue_account');
  check('a working configured key: another refusal is passed on as it came', answer.result.isError === true && JSON.stringify(payload(answer)) === JSON.stringify({ error: 'window_limit_reached', message: 'Slow down', retry_after: 60 }));
  bridge.kill();

  // No configured key: a key from barevalue_register that is later revoked can be replaced.
  stub.reset();
  bridge = startBridge({ BAREVALUE_MCP_URL: stub.url });
  await bridge.init();
  answer = await bridge.call('barevalue_account', { api_key: 'bv_sk_wrong' });
  stub.goodKeys = ['bv_sk_registered'];
  answer = await bridge.call('barevalue_account', { api_key: 'bv_sk_wrong' });
  check('no configured key: a wrong key from the model gets the service\'s own answer, untouched', answer.result.isError === true && JSON.stringify(payload(answer)) === JSON.stringify({ error: 'unauthorized', message: 'Invalid or revoked API key' }));
  await bridge.call('barevalue_register', { email: 'someone@example.com' });
  answer = await bridge.call('barevalue_account');
  check('no configured key: the key from barevalue_register is used from then on', !answer.result.isError && payload(answer).account === 'bv_sk_registered');

  stub.goodKeys = ['bv_sk_second'];
  stub.tool = (name) => (name === 'barevalue_register' ? [201, { api_key: 'bv_sk_second' }] : undefined);
  answer = await bridge.call('barevalue_account');
  body = payload(answer);
  check(
    'a session key that was revoked: the answer says it was dropped, that the same address cannot register twice, and to pass a working key',
    answer.result.isError === true && body.session_key_forgotten === true && /will not give the same email address another key/.test(body.what_to_do) &&
      /pass it as api_key/.test(body.what_to_do) && !/barevalue_register again/.test(body.what_to_do),
    body.what_to_do?.slice(0, 70)
  );
  const list = await bridge.rpc('tools/list');
  check('a session key that was revoked: the tools take api_key again', 'api_key' in list.result.tools.find((tool) => tool.name === 'barevalue_account').inputSchema.properties);
  answer = await bridge.call('barevalue_account', { api_key: 'bv_sk_second' });
  check('a session key that was revoked: a working key passed as api_key is used', !answer.result.isError && payload(answer).account === 'bv_sk_second');
  await bridge.call('barevalue_register', { email: 'someone@example.com' });
  answer = await bridge.call('barevalue_account');
  check('a session key that was revoked: a later barevalue_register that succeeds (another address) gives the session a key again', !answer.result.isError && payload(answer).account === 'bv_sk_second' && stub.calls[stub.calls.length - 1].key === 'bv_sk_second');
  bridge.kill();
}

// (2) Where the file may be sent
async function uploadAddress(stub, fixtures, lib) {
  console.log('\n# Where the file may be sent\n');
  const SERVICE = 'https://barevalue.com/mcp';
  const bytes = crypto.randomBytes(70000);
  const audio = fixtures.write('address.mp3', bytes);

  stub.reset();
  const bridge = startBridge({ BAREVALUE_API_KEY: 'bv_sk_good', BAREVALUE_MCP_URL: stub.url });
  await bridge.init();

  const refused = [
    ['another site', 'https://files.example.com/'],
    ['our host as the start of another', 'https://barevalue-files.s3.us-east-2.amazonaws.com.example.com/'],
    ['our host as a user name', 'https://barevalue-files.s3.us-east-2.amazonaws.com@example.com/'],
    ['another bucket', 'https://other-bucket.s3.us-east-2.amazonaws.com/'],
    ['the bucket as a path, which the service does not use', 'https://s3.us-east-2.amazonaws.com/barevalue-files'],
    ['a region the bucket is not in', 'https://barevalue-files.s3.eu-west-1.amazonaws.com/'],
    ['our host without https', 'http://barevalue-files.s3.us-east-2.amazonaws.com/'],
    ['our host on another port', 'https://barevalue-files.s3.us-east-2.amazonaws.com:8443/'],
    ['this machine on another port than the test server', 'http://127.0.0.1:9/upload'],
    ['no address at all', 'not an address'],
  ];
  for (const [name, address] of refused) {
    stub.uploadUrl = address;
    const before = stub.posts.length;
    const answer = await bridge.call('barevalue_upload', { file_path: audio });
    const body = payload(answer);
    check(
      `refused, nothing sent: ${name}`,
      answer.result.isError === true && body.error === 'unexpected_upload_address' && /barevalue-mcp@latest/.test(body.message) && stub.posts.length === before &&
        lib.uploadAddressProblem(address, SERVICE) !== null,
      body.message?.slice(0, 95)
    );
  }

  stub.uploadUrl = null;
  const sent = await bridge.call('barevalue_upload', { file_path: audio });
  const post = stub.posts[stub.posts.length - 1];
  check(
    'sent: the test server itself, when BAREVALUE_MCP_URL points at it',
    !sent.result.isError && payload(sent).upload_id?.startsWith('up_') && payload(sent).uploaded_bytes === bytes.length && post?.sha === sha(bytes),
    `${post?.fileBytes} bytes arrived`
  );
  check('sent: the form fields go first, as given, and the file last', /name="key"\r\n\r\n_api_uploads\/1\/up_\d+\/address\.mp3\r\n/.test(post.head) && /name="X-Amz-Signature"\r\n\r\nsig\r\n[^]*name="file"; filename="address\.mp3"/.test(post.head));
  bridge.kill();

  check('allowed: the address the service returns today', lib.uploadAddressProblem('https://barevalue-files.s3.us-east-2.amazonaws.com', SERVICE) === null && lib.uploadAddressProblem('https://barevalue-files.s3.us-east-2.amazonaws.com/', SERVICE) === null);
  check('allowed: the bucket by its name without a region', lib.uploadAddressProblem('https://barevalue-files.s3.amazonaws.com/', SERVICE) === null);
  check('allowed: the host in capitals is the same host', lib.uploadAddressProblem('https://Barevalue-Files.S3.us-east-2.amazonaws.com/', SERVICE) === null);
  check('refused: a local test server when BAREVALUE_MCP_URL is not set', lib.uploadAddressProblem(`${stub.origin}/upload`, SERVICE) !== null && lib.uploadAddressProblem(`${stub.origin}/upload`, stub.url) === null);
}

// (4) The file that is checked is the file that is sent
async function checkedFile(stub, fixtures) {
  console.log('\n# The file that is checked is the file that is sent\n');
  const posix = process.platform !== 'win32';
  const audioBytes = crypto.randomBytes(50000);
  const secretBytes = crypto.randomBytes(50000);
  const secret = fixtures.write('secret.txt', secretBytes);

  stub.reset();
  const bridge = startBridge({ BAREVALUE_API_KEY: 'bv_sk_good', BAREVALUE_MCP_URL: stub.url });
  await bridge.init();
  const upload = (file, extra = {}) => bridge.call('barevalue_upload', { file_path: file, ...extra });
  const refusedWith = (answer, code) => answer.result.isError === true && payload(answer)?.error === code && stub.calls.length === 0 && stub.posts.length === 0;

  // Refused, before the service is asked for anything.
  const hardToSecret = path.join(fixtures.dir, 'looks-like-audio.mp3');
  fs.linkSync(secret, hardToSecret);
  let answer = await upload(hardToSecret);
  check('refused: a hard link named .mp3 to a file that is not audio', refusedWith(answer, 'file_has_other_names') && /Copy it/.test(payload(answer).message), payload(answer)?.message?.slice(0, 80));
  fs.unlinkSync(hardToSecret);

  const softToSecret = path.join(fixtures.dir, 'soft.mp3');
  fs.symlinkSync(secret, softToSecret);
  answer = await upload(softToSecret);
  check('refused: a symbolic link named .mp3 to a file that is not audio', refusedWith(answer, 'not_an_audio_file'));

  const folder = path.join(fixtures.dir, 'folder.mp3');
  fs.mkdirSync(folder);
  answer = await upload(folder);
  check('refused: a folder named .mp3', refusedWith(answer, 'not_a_file'));

  answer = await upload(fixtures.write('empty.mp3', Buffer.alloc(0)));
  check('refused: an empty file', refusedWith(answer, 'empty_file'));

  if (posix) {
    const pipe = path.join(fixtures.dir, 'pipe.mp3');
    require('child_process').execFileSync('mkfifo', [pipe]);
    const started = Date.now();
    answer = await Promise.race([upload(pipe), sleep(5000).then(() => null)]);
    check('refused at once: a pipe named .mp3 (an open by name would wait on it for ever)', answer !== null && refusedWith(answer, 'not_a_file'), `${Date.now() - started} ms`);

    if (process.getuid() !== 0) {
      const locked = fixtures.write('locked.mp3', audioBytes);
      fs.chmodSync(locked, 0o000);
      answer = await upload(locked);
      check('refused: a file this program may not read, in plain words', refusedWith(answer, 'file_not_readable'));
      fs.chmodSync(locked, 0o600);
    }
  }

  // Swapped while the service is being asked for the form: what was checked is what goes.
  const swapped = fixtures.write('swapped.mp3', audioBytes);
  stub.tool = (name) => {
    if (name === 'barevalue_upload') {
      fs.renameSync(fixtures.write('other.bin', secretBytes), swapped);
    }
  };
  answer = await upload(swapped);
  check(
    'a file put in its place after the check is not what is sent',
    !answer.result.isError && stub.posts.length === 1 && stub.posts[0].sha === sha(audioBytes) && sha(fs.readFileSync(swapped)) === sha(secretBytes),
    stub.posts[0]?.sha === sha(secretBytes) ? 'the other file was sent' : undefined
  );

  stub.reset();
  const relinked = fixtures.write('relinked.mp3', audioBytes);
  stub.tool = (name) => {
    if (name === 'barevalue_upload') {
      fs.unlinkSync(relinked);
      fs.symlinkSync(secret, relinked);
    }
  };
  answer = await upload(relinked);
  check(
    'a link to another file put in its place after the check is not followed',
    !answer.result.isError && stub.posts.length === 1 && stub.posts[0].sha === sha(audioBytes),
    stub.posts[0]?.sha === sha(secretBytes) ? 'the linked file was sent' : undefined
  );

  // Sent as before.
  const sentWhole = async (name, file, bytes, storedAs, extra) => {
    stub.reset();
    const result = await upload(file, extra);
    const post = stub.posts[0];
    check(
      `sent: ${name}`,
      !result.result.isError && payload(result).uploaded_bytes === bytes.length && payload(result).filename === storedAs && post?.sha === sha(bytes) && stub.calls[0].args.filename === storedAs && stub.calls[0].args.size_bytes === bytes.length,
      result.result.isError ? result.result.content[0].text.replace(/\s+/g, ' ').slice(0, 120) : `${post?.fileBytes} bytes`
    );
  };
  await sentWhole('an ordinary recording', fixtures.write('Episode 12 (final).mp3', audioBytes), audioBytes, 'Episode 12 (final).mp3');
  await sentWhole('a recording whose extension is in capitals', fixtures.write('TAKE2.WAV', audioBytes), audioBytes, 'TAKE2.WAV');
  const real = fixtures.write('real.flac', audioBytes);
  const alias = path.join(fixtures.dir, 'latest');
  fs.symlinkSync(real, alias);
  await sentWhole('a symbolic link to a recording, under the real file\'s name', alias, audioBytes, 'real.flac');
  await sentWhole('a recording under a name given for it', real, audioBytes, 'renamed.flac', { filename: 'renamed.flac' });
  const big = fixtures.write('big.m4a', crypto.randomBytes(3 * 1024 * 1024 + 17));
  await sentWhole('a recording of a few megabytes, byte for byte', big, fs.readFileSync(big), 'big.m4a');

  stub.reset();
  answer = await upload(path.join(fixtures.dir, 'missing.mp3'));
  check('refused: a file that is not there', refusedWith(answer, 'file_not_found'));
  bridge.kill();
}

// (1) A long upload: progress, cancel, and a second call for the same file
async function longUpload(stub, fixtures) {
  console.log('\n# A long upload\n');
  const MB = 1024 * 1024;
  const sizeOf = 20 * MB;
  // How fast the stub takes a post: 256 KB a tick is about 5 MB a second.
  const slow = (bytesPerTick = 256 * 1024) => { stub.reset(); stub.drainBytesPerTick = bytesPerTick; };
  const makeBig = (name, size = sizeOf) => {
    const file = path.join(fixtures.dir, name);
    fs.writeFileSync(file, Buffer.alloc(0));
    fs.truncateSync(file, size);
    return file;
  };
  const zeros = sha(Buffer.alloc(sizeOf));
  const until = async (condition, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (condition()) return true;
      await sleep(25);
    }
    return false;
  };
  const progressOf = (bridge, token) => bridge.notifications.filter((n) => n.method === 'notifications/progress' && n.params.progressToken === token).map((n) => n.params);

  let bridge = startBridge({ BAREVALUE_API_KEY: 'bv_sk_good', BAREVALUE_MCP_URL: stub.url });
  await bridge.init();

  // Progress. Taken at half the pace: what the bridge reports is what it has read from
  // disk, and on a machine whose loopback buffers hold several megabytes the read is over
  // that much sooner. At 2.5 MB a second the reading still lasts for seconds there.
  slow(128 * 1024);
  let file = makeBig('progress.wav');
  let answer = await bridge.call('barevalue_upload', { file_path: file }, { progressToken: 'tok-1' });
  let seen = progressOf(bridge, 'tok-1');
  const rising = seen.every((p, i) => i === 0 || p.progress > seen[i - 1].progress);
  check(
    'with a progress token, the client hears how far the upload is, more than once and always further',
    !answer.result.isError && seen.length >= 3 && rising && seen.every((p) => p.total === sizeOf && typeof p.message === 'string'),
    `${seen.length} notifications, e.g. "${seen[1]?.message}"`
  );
  check('the whole file is only reported once storage has answered', seen[seen.length - 1]?.progress === sizeOf && seen.slice(0, -1).every((p) => p.progress < sizeOf) && /^Uploaded/.test(seen[seen.length - 1].message));
  check('the file arrived whole', stub.posts.length === 1 && stub.posts[0].sha === zeros);

  slow();
  bridge.notifications.length = 0;
  answer = await bridge.call('barevalue_upload', { file_path: makeBig('quiet.wav', 8 * MB) });
  check('without a progress token, nothing is sent but the answer', !answer.result.isError && bridge.notifications.length === 0 && stub.posts[0].fileBytes === 8 * MB);

  // Cancel
  slow();
  file = makeBig('cancelled.wav');
  let pending = bridge.call('barevalue_upload', { file_path: file }, { progressToken: 'tok-2' });
  let answered = false;
  pending.then(() => { answered = true; });
  await until(() => stub.posts[0]?.bytes > 2 * MB);
  bridge.notify('notifications/cancelled', { requestId: pending.id, reason: 'The client gave up waiting' });
  const stopped = await until(() => stub.posts[0].aborted, 10000);
  const bytesAtStop = stub.posts[0].bytes;
  await sleep(600);
  check(
    'a cancelled call stops the upload at once',
    stopped && !stub.posts[0].done && bytesAtStop < sizeOf && stub.posts[0].bytes === bytesAtStop && !answered,
    `${(bytesAtStop / MB).toFixed(1)} of ${sizeOf / MB} MB had arrived`
  );
  const afterCancel = progressOf(bridge, 'tok-2').length;
  await sleep(1200);
  check('a cancelled call sends no more progress', progressOf(bridge, 'tok-2').length === afterCancel);

  stub.drainBytesPerTick = 0;
  answer = await bridge.call('barevalue_upload', { file_path: file });
  check(
    'the same file again after a cancel goes through, to the form already asked for (no second upload on the account)',
    !answer.result.isError && payload(answer).upload_id === 'up_0001' && stub.uploadsOpened === 1 && stub.posts.length === 2 && stub.posts[1].sha === zeros,
    `${stub.uploadsOpened} form(s) asked for, ${stub.posts.length} posts`
  );
  answer = await bridge.call('barevalue_upload', { file_path: file });
  check('the same file again after it arrived is a new upload', !answer.result.isError && payload(answer).upload_id === 'up_0002' && stub.uploadsOpened === 2 && !payload(answer).note);

  // A second call while the first is on its way
  slow();
  file = makeBig('twice.wav');
  const first = bridge.call('barevalue_upload', { file_path: file });
  await until(() => stub.posts[0]?.bytes > 1 * MB);
  const second = bridge.call('barevalue_upload', { file_path: file }, { progressToken: 'tok-3' });
  const [one, two] = await Promise.all([first, second]);
  check(
    'a second call for a file still on its way joins it: one upload, one upload_id, and it says so',
    !one.result.isError && !two.result.isError && payload(one).upload_id === payload(two).upload_id && stub.posts.length === 1 && stub.uploadsOpened === 1 &&
      stub.posts[0].sha === zeros && /same upload/.test(payload(two).note) && !payload(one).note,
    `${stub.posts.length} post(s)`
  );
  check('the call that joined hears the progress too', progressOf(bridge, 'tok-3').length >= 1 && progressOf(bridge, 'tok-3').pop().progress === sizeOf);

  slow();
  file = makeBig('handed-over.wav');
  const leaver = bridge.call('barevalue_upload', { file_path: file });
  await until(() => stub.posts[0]?.bytes > 1 * MB);
  const stayer = bridge.call('barevalue_upload', { file_path: file });
  await sleep(200);
  bridge.notify('notifications/cancelled', { requestId: leaver.id, reason: 'timeout' });
  answer = await stayer;
  check('when the first call is cancelled and a second is waiting, the upload carries on for the second', !answer.result.isError && stub.posts.length === 1 && stub.posts[0].done && !stub.posts[0].aborted && stub.posts[0].sha === zeros);

  slow();
  const [a, b] = await Promise.all([
    bridge.call('barevalue_upload', { file_path: makeBig('side-a.wav', 4 * MB) }),
    bridge.call('barevalue_upload', { file_path: makeBig('side-b.wav', 4 * MB) }),
  ]);
  check('two different files at once are two uploads', !a.result.isError && !b.result.isError && payload(a).upload_id !== payload(b).upload_id && stub.posts.length === 2 && stub.posts.every((post) => post.fileBytes === 4 * MB));

  // Storage says no: that form is spent, the next call asks for a new one.
  stub.reset();
  stub.uploadStatus = 403;
  stub.uploadBody = '<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Policy expired</Message></Error>';
  file = makeBig('refused.wav', 1 * MB);
  answer = await bridge.call('barevalue_upload', { file_path: file });
  check('a refusal from storage is passed on', answer.result.isError === true && payload(answer).error === 'upload_failed' && /AccessDenied/.test(payload(answer).message));
  stub.uploadStatus = 204;
  stub.uploadBody = '';
  answer = await bridge.call('barevalue_upload', { file_path: file });
  check('after a refusal from storage the next call asks for a new form', !answer.result.isError && stub.uploadsOpened === 2 && payload(answer).upload_id === 'up_0002');

  // The file gets shorter while it is on its way.
  slow();
  // A file far larger than anything the connection can hold in its buffers, so that most
  // of it is still unread when it is cut. It costs no time: the upload ends at the cut.
  file = makeBig('shrinks.wav', 96 * MB);
  pending = bridge.call('barevalue_upload', { file_path: file });
  await until(() => stub.posts[0]?.bytes > 1 * MB);
  fs.truncateSync(file, 1000);
  answer = await pending;
  check('a file that shrinks on its way ends the upload with a plain reason', answer.result.isError === true && /changed while it was being sent/.test(payload(answer).message) && !stub.posts[0].done);

  // A cancelled call for another tool is simply let go.
  stub.reset();
  answer = await bridge.call('barevalue_pricing');
  check('an ordinary tool still answers', !answer.result.isError && payload(answer).price === 'free');
  bridge.kill();

  // The client goes away in the middle.
  slow();
  bridge = startBridge({ BAREVALUE_API_KEY: 'bv_sk_good', BAREVALUE_MCP_URL: stub.url });
  await bridge.init();
  bridge.call('barevalue_upload', { file_path: makeBig('abandoned.wav') }).catch(() => undefined);
  await until(() => stub.posts[0]?.bytes > 1 * MB);
  bridge.proc.stdin.end();
  const code = await Promise.race([bridge.exited, sleep(10000).then(() => 'still running')]);
  await until(() => stub.posts[0].aborted, 8000);
  check('when the client goes away the upload stops and the server exits', code === 0 && stub.posts[0].aborted && !stub.posts[0].done, `exit ${code}, ${(stub.posts[0].bytes / MB).toFixed(1)} of ${sizeOf / MB} MB had arrived`);
  bridge.kill();
}

// (6) A streamed answer from the hosted server, and Windows paths
async function streamedAnswers(stub, lib) {
  console.log('\n# A streamed answer from the hosted server\n');
  stub.reset();
  const bridge = startBridge({ BAREVALUE_API_KEY: 'bv_sk_good', BAREVALUE_MCP_URL: stub.url });
  await bridge.init();

  const modes = [
    ['one event', 'sse'],
    ['CRLF line ends, a comment and an id line', 'sse-crlf'],
    ['other messages before and after it, and its JSON over two data lines', 'sse-progress'],
    ['the answer arriving in two pieces', 'sse-split'],
  ];
  for (const [name, mode] of modes) {
    stub.answer = mode;
    const answer = await bridge.call('barevalue_account');
    check(`streamed, ${name}: the tool's answer comes through`, answer.result && !answer.result.isError && payload(answer)?.account === 'bv_sk_good', answer.result?.content?.[0]?.text.replace(/\s+/g, ' ').slice(0, 100));
  }

  stub.answer = 'sse-open';
  const started = Date.now();
  let answer = await bridge.call('barevalue_account');
  check('streamed, and the stream left open afterwards: the answer is not held back until it closes', !answer.result.isError && payload(answer)?.account === 'bv_sk_good' && Date.now() - started < 3000, `${Date.now() - started} ms`);

  stub.answer = 'sse-progress';
  stub.tool = () => [403, { error: 'email_verification_required', message: 'Confirm the address first' }];
  answer = await bridge.call('barevalue_account');
  check('streamed: a refusal from the service comes through as the service wrote it', answer.result.isError === true && payload(answer)?.error === 'email_verification_required');
  stub.tool = null;

  stub.answer = 'sse-empty';
  answer = await bridge.call('barevalue_account');
  check('a stream that ends with no answer to the call is an error, not somebody else\'s message', answer.result.isError === true && payload(answer)?.error === 'bridge_error' && /no readable body/.test(payload(answer).message) && !/wrong/.test(answer.result.content[0].text), payload(answer)?.message);

  stub.answer = 'json';
  answer = await bridge.call('barevalue_account');
  check('a plain JSON answer still comes through', !answer.result.isError && payload(answer)?.account === 'bv_sk_good');
  bridge.kill();

  // The tool list itself, streamed, at start.
  stub.reset();
  stub.answer = 'sse-progress';
  const second = startBridge({ BAREVALUE_MCP_URL: stub.url });
  await second.init();
  const list = await second.rpc('tools/list');
  check('the tool list comes through a stream too', list.result?.tools?.length === TOOLS.length && list.result.tools.some((tool) => tool.name === 'barevalue_upload' && tool.inputSchema.required[0] === 'file_path'));
  second.kill();

  const id = 'abc';
  const mine = JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } });
  const theirs = JSON.stringify({ jsonrpc: '2.0', id: 'other', result: { ok: false } });
  check('the reader itself: the answer with this call\'s id, wherever it stands', lib.answerInStream(`data: ${theirs}\n\ndata: ${mine}\n\ndata: ${theirs}\n\n`, id)?.result.ok === true);
  check('the reader itself: an event still arriving is not read yet', lib.answerInStream(`data: ${mine}`, id) === null && lib.answerInStream(`data: ${mine}\n`, id) === null && lib.answerInStream(`data: ${mine}\n\n`, id)?.result.ok === true);
  check('the reader itself: nothing for this id is nothing', lib.answerInStream(`data: ${theirs}\n\ndata: not json\n\n: comment\n\n`, id) === null);
  check('the reader itself: "data:" with no space, and CR line ends', lib.answerInStream(`event: message\rdata:${mine}\r\r`, id)?.result.ok === true);
}

function windowsPaths(lib) {
  console.log('\n# Paths as Windows writes them (the name rules only: not run on Windows)\n');
  const win = path.win32;
  const accepted = [
    ['a drive path with spaces and capitals', 'C:\\Users\\Ross Plotkin\\Recordings\\Episode 12.MP3', 'Episode 12.MP3'],
    ['a network share', '\\\\nas\\podcasts\\season 2\\ep04.flac', 'ep04.flac'],
    ['forward and back slashes mixed', 'D:/shows/raw\\take 3.wav', 'take 3.wav'],
    ['several dots in the name', 'C:\\x\\ep.12.final.m4a', 'ep.12.final.m4a'],
    ['a long-path prefix', '\\\\?\\C:\\very\\long\\path\\ep.ogg', 'ep.ogg'],
  ];
  for (const [name, given, stored] of accepted) {
    const named = lib.audioName(given, win);
    check(`taken as audio: ${name}`, named.audio === true && named.name === stored, `${named.name} (${named.extension})`);
  }
  const refused = [
    ['a text file', 'C:\\Users\\Ross\\notes.txt'],
    ['a program with an audio word in its name', 'C:\\x\\episode.mp3.exe'],
    ['no extension at all', 'C:\\x\\mp3'],
    ['a folder path whose parent is named like audio', 'C:\\shows.mp3\\secret.docx'],
    ['the main stream of another file, written the long way', 'C:\\x\\secret.txt::$DATA'],
    ['a trailing dot, which Windows drops when it opens the file', 'C:\\x\\secret.mp3.'],
  ];
  for (const [name, given] of refused) {
    const named = lib.audioName(given, win);
    check(`not taken as audio: ${name}`, named.audio === false, named.extension || '(none)');
  }
  // On this machine's own rules a backslash is part of a name, not a separator.
  check('the same check by this machine\'s rules', lib.audioName('/Users/ross/Episode 12.MP3').audio === true && lib.audioName('/Users/ross/Episode 12.MP3').name === 'Episode 12.MP3' && lib.audioName('/Users/ross/notes.txt').audio === false);
}

/**
 * Whether the bridge process still holds the file open, or null where that cannot be seen.
 * Linux: the links in /proc. macOS: lsof.
 */
function heldOpenBy(pid, file) {
  try {
    if (process.platform === 'linux') {
      return fs.readdirSync(`/proc/${pid}/fd`).some((fd) => {
        try {
          return fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === file;
        } catch {
          return false;
        }
      });
    }
    if (process.platform === 'darwin') {
      const listed = require('child_process').spawnSync('lsof', ['-p', String(pid), '-Fn'], { encoding: 'utf8' });
      return listed.error || !listed.stdout ? null : listed.stdout.split('\n').includes(`n${file}`);
    }
  } catch {
    // not visible here
  }
  return null;
}

// (7) Storage that drops the connection or goes quiet
async function storageGoesAway(stub, fixtures, lib) {
  console.log('\n# Storage that drops the connection or goes quiet\n');
  const MB = 1024 * 1024;
  const bytes = crypto.randomBytes(300000);
  const until = async (condition, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (condition()) return true;
      await sleep(25);
    }
    return false;
  };
  // A call that is never answered is the fault looked for: wait a few seconds, not for ever.
  const within = (promise, ms = 15000) => Promise.race([promise, sleep(ms).then(() => null)]);

  stub.reset();
  const bridge = startBridge({ BAREVALUE_API_KEY: 'bv_sk_good', BAREVALUE_MCP_URL: stub.url });
  await bridge.init();
  const pid = bridge.proc.pid;

  // The control for the open-file check: while a file is on its way, the bridge holds it.
  stub.drainBytesPerTick = 256 * 1024;
  const slowFile = path.join(fixtures.dir, 'held.wav');
  fs.writeFileSync(slowFile, Buffer.alloc(0));
  fs.truncateSync(slowFile, 12 * MB);
  const slow = bridge.call('barevalue_upload', { file_path: slowFile });
  await until(() => stub.posts[0]?.bytes > 1 * MB);
  const heldDuring = heldOpenBy(pid, slowFile);
  await slow;
  const canSee = heldDuring === true && heldOpenBy(pid, slowFile) === false;
  if (heldDuring === null) {
    console.log('note open files of another process cannot be listed here: the "file is closed" checks are left out');
  } else {
    check('the control: a file is held open while it is on its way and closed once it has arrived', canSee);
  }
  const closed = (file) => !canSee || heldOpenBy(pid, file) === false;

  // Real storage: 204, no body at all.
  stub.reset();
  let file = fixtures.write('plain-204.mp3', bytes);
  let answer = await within(bridge.call('barevalue_upload', { file_path: file }));
  check(
    'storage answers 204 with no body: the upload succeeded',
    answer !== null && !answer.result.isError && payload(answer).upload_id === 'up_0001' && payload(answer).uploaded_bytes === bytes.length && stub.posts[0]?.sha === sha(bytes) && closed(file)
  );

  // Headers, and then the connection is dropped.
  stub.reset();
  stub.uploadMode = 'headers-then-drop';
  file = fixtures.write('dropped-after-headers.mp3', bytes);
  const started = Date.now();
  answer = await within(bridge.call('barevalue_upload', { file_path: file }));
  const body = answer && payload(answer);
  check(
    'storage sends headers and then drops the connection: the call is answered, with a plain reason',
    answer !== null && answer.result.isError === true && body.error === 'bridge_error' && /dropped the connection before it finished answering \(HTTP 200\)/.test(body.message) && /barevalue_upload again/.test(body.message),
    answer === null ? 'no answer after 15 s' : `${Date.now() - started} ms: ${body.message?.slice(0, 80)}`
  );
  await sleep(100);
  check('storage sends headers and then drops the connection: the file is closed', answer !== null && closed(file), heldOpenBy(pid, file) === true ? 'still open' : undefined);

  stub.uploadMode = null;
  answer = await within(bridge.call('barevalue_upload', { file_path: file }));
  check(
    'the same file again after that is a new post to the form already asked for, not a call waiting on the dead one',
    answer !== null && !answer.result.isError && payload(answer).upload_id === 'up_0001' && !payload(answer).note && stub.uploadsOpened === 1 && stub.posts.length === 2 && stub.posts[1].sha === sha(bytes) && closed(file),
    answer === null ? 'no answer after 15 s' : `${stub.uploadsOpened} form(s) asked for, ${stub.posts.length} posts`
  );

  // The connection goes while the file is still arriving.
  stub.reset();
  stub.uploadMode = 'drop';
  file = fixtures.write('dropped-midway.mp3', crypto.randomBytes(4 * MB));
  answer = await within(bridge.call('barevalue_upload', { file_path: file }));
  await sleep(100);
  check(
    'storage drops the connection while the file is arriving: the call is answered and the file is closed',
    answer !== null && answer.result.isError === true && payload(answer).error === 'bridge_error' && /connection to storage failed/.test(payload(answer).message) && /barevalue_upload again/.test(payload(answer).message) && closed(file),
    answer === null ? 'no answer after 15 s' : payload(answer).message?.slice(0, 80)
  );

  // A yes that comes while the file is still being sent is not a stored file. The file is
  // far larger than the connection's buffers and the stub stops reading, so most of it
  // cannot have left this machine when the answer comes.
  const bigFile = (name) => {
    const made = path.join(fixtures.dir, name);
    fs.writeFileSync(made, Buffer.alloc(0));
    fs.truncateSync(made, 96 * MB);
    return made;
  };
  stub.reset();
  stub.uploadMode = 'early-200';
  file = bigFile('early-yes.wav');
  answer = await within(bridge.call('barevalue_upload', { file_path: file }));
  let said = answer && payload(answer);
  const hungUp = await until(() => stub.posts[0]?.socketClosed, 10000);
  check(
    'storage says 200 while the file is still being sent: not counted as an upload, with a plain reason',
    answer !== null && answer.result.isError === true && said.error === 'bridge_error' && !said.upload_id && !said.uploaded_bytes &&
      /answered HTTP 200 before the whole file had been sent/.test(said.message) && /barevalue_upload again/.test(said.message) && stub.posts[0].bytes < 96 * MB,
    answer === null ? 'no answer after 15 s' : `${(stub.posts[0].bytes / MB).toFixed(1)} of 96 MB had arrived: ${said.message?.slice(0, 70)}`
  );
  check('and the connection is closed and the file too', hungUp && closed(file), `connection ${hungUp ? 'closed' : 'still open'}, file ${closed(file) ? 'closed' : 'still open'}`);

  stub.reset();
  stub.uploadMode = 'early-403';
  file = bigFile('early-no.wav');
  answer = await within(bridge.call('barevalue_upload', { file_path: file }));
  said = answer && payload(answer);
  const hungUpToo = await until(() => stub.posts[0]?.socketClosed, 10000);
  check(
    'storage refuses while the file is still being sent: the refusal is passed on, and nothing more is sent',
    answer !== null && answer.result.isError === true && said.error === 'upload_failed' && /HTTP 403, AccessDenied/.test(said.message) && hungUpToo && closed(file),
    answer === null ? 'no answer after 15 s' : said.message?.slice(0, 80)
  );
  bridge.kill();

  // The idle limit, on the sending function itself with a short limit (the bridge's is 120 s).
  const send = (name, handle, idleMs) =>
    lib.postForm(`${stub.origin}/upload`, { key: 'k' }, 'file', handle, name, bytes.length, new AbortController().signal, () => undefined, idleMs);
  const quiet = async (name, mode) => {
    stub.reset();
    stub.uploadMode = mode;
    const handle = await fs.promises.open(fixtures.write(`${mode}.mp3`, bytes), 'r');
    const begun = Date.now();
    let outcome;
    try {
      outcome = await within(send(`${mode}.mp3`, handle, 400));
    } catch (error) {
      outcome = error;
    }
    const took = Date.now() - begun;
    // Once it has settled nothing reads the handle any more, so the caller can close it.
    const closes = await handle.close().then(() => true, () => false);
    check(
      name,
      outcome instanceof Error && /stalled: nothing moved for [\d.]+ seconds/.test(outcome.message) && /barevalue_upload again/.test(outcome.message) && took >= 350 && took < 10000 && closes,
      outcome === null ? 'never settled' : `${took} ms: ${outcome instanceof Error ? outcome.message.slice(0, 70) : JSON.stringify(outcome)}`
    );
  };
  await quiet('storage sends headers and then nothing: the upload is stopped at the idle limit', 'headers-then-stall');
  await quiet('storage takes the file and never answers: the upload is stopped at the idle limit', 'stall');

  stub.reset();
  const handle = await fs.promises.open(fixtures.write('direct-204.mp3', bytes), 'r');
  const direct = await within(send('direct-204.mp3', handle, 400));
  await handle.close();
  check('the sending function itself: 204 with no body resolves with the status and an empty body', direct !== null && direct.status === 204 && direct.body === '' && stub.posts[0].sha === sha(bytes));
}

// (8) An order asked for again after no answer
async function orderAskedAgain(stub) {
  console.log('\n# An order asked for again after no answer\n');
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const order = { file_url: 'https://example.com/ep.mp3', podcast_name: 'Show', episode_name: 'One', host_names: ['Ann', 'Bo'] };
  const sentKeys = () => stub.calls.filter((call) => call.name === 'barevalue_submit_url').map((call) => call.args.idempotency_key);

  stub.reset();
  let bridge = startBridge({ BAREVALUE_API_KEY: 'bv_sk_good', BAREVALUE_MCP_URL: stub.url });
  await bridge.init();

  let answer = await bridge.call('barevalue_submit_url', order);
  check('an order goes out with an idempotency key of its own', !answer.result.isError && payload(answer).order_id === 1001 && UUID.test(sentKeys()[0]), sentKeys()[0]);
  answer = await bridge.call('barevalue_submit_url', order);
  check('the same order after an answer is a new order with a new key', !answer.result.isError && payload(answer).order_id === 1002 && UUID.test(sentKeys()[1]) && sentKeys()[1] !== sentKeys()[0]);

  // No answer comes back. The call did arrive, so the order may have been placed.
  stub.reset();
  stub.dropCalls = 2;
  answer = await bridge.call('barevalue_submit_url', order);
  const body = payload(answer);
  check(
    'an order that gets no answer: the result says it may have been placed and how to ask again safely',
    answer.result.isError === true && body.error === 'bridge_error' && /not known whether the order was placed/.test(body.message) &&
      /exactly the same arguments/.test(body.message) && /not placed twice/.test(body.message) && /barevalue_list_orders/.test(body.message),
    body.message?.slice(0, 90)
  );
  await bridge.call('barevalue_submit_url', { ...order, episode_name: 'Two' });
  // The same order, its fields in another order.
  answer = await bridge.call('barevalue_submit_url', { host_names: ['Ann', 'Bo'], episode_name: 'One', podcast_name: 'Show', file_url: 'https://example.com/ep.mp3' });
  const [first, other, again] = sentKeys();
  check('the same order asked for again goes out with the same idempotency key', !answer.result.isError && UUID.test(first) && again === first, `${first} / ${again}`);
  check('another order meanwhile has a key of its own', UUID.test(other) && other !== first);
  await bridge.call('barevalue_submit_url', order);
  check('once it has been answered, the same order again is a new one', sentKeys()[3] !== first && UUID.test(sentKeys()[3]));

  // A fault on the service's side leaves it open too.
  stub.reset();
  stub.tool = (name) => (name === 'barevalue_submit_url' && stub.calls.length === 1 ? [500, { error: 'internal_error', message: 'Failed to submit order' }] : undefined);
  answer = await bridge.call('barevalue_submit_url', order);
  await bridge.call('barevalue_submit_url', order);
  check('after a fault on the service\'s side the same order keeps its key', payload(answer).error === 'internal_error' && sentKeys()[0] === sentKeys()[1] && UUID.test(sentKeys()[0]));

  // A refusal is an answer: nothing was placed, the next try is its own order.
  stub.reset();
  stub.tool = (name) => (name === 'barevalue_submit_url' && stub.calls.length === 1 ? [429, { error: 'too_many_orders_in_progress', message: 'One at a time' }] : undefined);
  answer = await bridge.call('barevalue_submit_url', order);
  await bridge.call('barevalue_submit_url', order);
  check('a refusal is passed on as it came, and the next try has a new key', JSON.stringify(payload(answer)) === JSON.stringify({ error: 'too_many_orders_in_progress', message: 'One at a time' }) && sentKeys()[0] !== sentKeys()[1]);

  // The caller's own key is the caller's.
  stub.reset();
  stub.dropCalls = 1;
  const own = '11111111-2222-4333-8444-555555555555';
  answer = await bridge.call('barevalue_submit_url', { ...order, idempotency_key: own });
  check('an idempotency_key the caller gives is sent as given, and the advice names it', sentKeys()[0] === own && /same idempotency_key/.test(payload(answer).message));
  await bridge.call('barevalue_submit_url', order);
  check('and it is not kept for a later call without one', sentKeys()[1] !== own && UUID.test(sentKeys()[1]));

  // The service as it is: one order per key. The second time it sees a key it answers
  // with the order that key placed, whatever has become of it since.
  const placed = new Map();
  const service = (name, args) => {
    if (name !== 'barevalue_submit_url') return undefined;
    const earlier = placed.get(args.idempotency_key);
    if (earlier) return [200, { order_id: earlier.id, status: earlier.state, message: 'Order already submitted (idempotency)' }];
    const made = { id: 2001 + placed.size, state: 'new' };
    placed.set(args.idempotency_key, made);
    return [200, { order_id: made.id, status: 'queued', message: 'File download queued. Order will be submitted automatically when download completes.' }];
  };
  const lostThenAgain = async (becomes, extra = {}) => {
    stub.reset();
    placed.clear();
    stub.tool = service;
    stub.dropCalls = 1;
    const lost = await bridge.call('barevalue_submit_url', { ...order, ...extra });
    [...placed.values()][0].state = becomes; // the order was placed all the same, and this became of it
    const replay = await bridge.call('barevalue_submit_url', { ...order, ...extra });
    return { lost, replay, said: payload(replay) };
  };

  // The order was placed, its answer was lost, and it failed. The agent orders again.
  let seen = await lostThenAgain('failed');
  check(
    'an order whose answer was lost and which then failed: asked for again, the answer says it is that earlier order and that it failed',
    seen.lost.result.isError === true && !seen.replay.result.isError && seen.said.order_id === 2001 && seen.said.status === 'failed' && seen.said.earlier_order === true &&
      /not a new one: order 2001/.test(seen.said.note) && /Nothing new was ordered/.test(seen.said.note) && /has failed/.test(seen.said.note) &&
      /again with the same arguments now places a new order/.test(seen.said.note) && !/of your own/.test(seen.said.note) &&
      sentKeys()[1] === sentKeys()[0] && seen.replay.result.structuredContent?.note === seen.said.note,
    seen.said.note
  );
  answer = await bridge.call('barevalue_submit_url', order);
  check(
    'and the same call once more is a new order with a new key, as the note said',
    !answer.result.isError && payload(answer).order_id === 2002 && payload(answer).status === 'queued' && !payload(answer).earlier_order && !payload(answer).note &&
      sentKeys()[2] !== sentKeys()[0] && UUID.test(sentKeys()[2]) && placed.size === 2
  );

  seen = await lostThenAgain('canceled', { episode_name: 'Cancelled' });
  await bridge.call('barevalue_submit_url', { ...order, episode_name: 'Cancelled' });
  check('the same for an order that was cancelled', /has been cancelled/.test(seen.said.note) && /now places a new order/.test(seen.said.note) && sentKeys()[2] !== sentKeys()[0] && placed.size === 2);

  // Being worked on, or done: the same call again must stay that order, or the same
  // episode would be ordered twice.
  for (const [state, name, saysState] of [
    ['submitted', 'being edited', /still being worked on: poll barevalue_status/],
    ['new', 'still downloading', /still being worked on: poll barevalue_status/],
    ['done', 'done', /It is done: barevalue_status has the downloads/],
  ]) {
    const asked = { ...order, episode_name: `Kept ${state}` };
    seen = await lostThenAgain(state, { episode_name: asked.episode_name });
    check(
      `an order whose answer was lost and which is ${name}: the answer says it is the order already placed, its state, and that nothing new was ordered`,
      !seen.replay.result.isError && seen.said.order_id === 2001 && seen.said.status === state && seen.said.earlier_order === true && /not a new one: order 2001/.test(seen.said.note) &&
        /Nothing new was ordered/.test(seen.said.note) && saysState.test(seen.said.note) && /idempotency_key of your own/.test(seen.said.note) && !/places a new order/.test(seen.said.note),
      seen.said.note
    );
    answer = await bridge.call('barevalue_submit_url', asked);
    check(
      `and the same call once more is still that order (${name}): the same key, no second order`,
      !answer.result.isError && payload(answer).order_id === 2001 && payload(answer).earlier_order === true && sentKeys()[2] === sentKeys()[0] && placed.size === 1
    );
    const mine = '99999999-2222-4333-8444-555555555555';
    answer = await bridge.call('barevalue_submit_url', { ...asked, idempotency_key: mine });
    check(`and with a key of the caller's own it is a new order, on purpose (${name})`, !answer.result.isError && payload(answer).order_id === 2002 && !payload(answer).earlier_order && sentKeys()[3] === mine && placed.size === 2);
  }

  // The caller's own key: this server cannot know why it came twice, and does not guess.
  for (const [state, saysNext] of [
    ['failed', /To order again, call barevalue_submit_url with a new idempotency_key/],
    ['submitted', /To order the same recording again on purpose, pass a new idempotency_key/],
    ['done', /To order the same recording again on purpose, pass a new idempotency_key/],
  ]) {
    seen = await lostThenAgain(state, { idempotency_key: own });
    check(
      `with the caller's own key and an order that is ${state}: the note says only that the key was already used for that order`,
      seen.said.earlier_order === true && /This idempotency_key was already used for order 2001/.test(seen.said.note) && /nothing new was ordered/.test(seen.said.note) && saysNext.test(seen.said.note) &&
        !/did not arrive/.test(seen.said.note) && !/same arguments/.test(seen.said.note) && sentKeys()[0] === own && sentKeys()[1] === own,
      seen.said.note
    );
  }

  stub.reset();
  stub.dropCalls = 1;
  answer = await bridge.call('barevalue_account');
  check('another tool that gets no answer says only that', answer.result.isError === true && !/order/.test(payload(answer).message) && !('idempotency_key' in stub.calls[0].args), payload(answer).message);
  bridge.kill();

  // Without a session key the account is the api_key in the arguments.
  stub.reset();
  bridge = startBridge({ BAREVALUE_MCP_URL: stub.url });
  await bridge.init();
  stub.dropCalls = 2;
  await bridge.call('barevalue_submit_url', { ...order, api_key: 'bv_sk_one' });
  await bridge.call('barevalue_submit_url', { ...order, api_key: 'bv_sk_two' });
  await bridge.call('barevalue_submit_url', { ...order, api_key: 'bv_sk_one' });
  check('the same order for two accounts is two orders', sentKeys()[0] !== sentKeys()[1] && sentKeys()[2] === sentKeys()[0] && stub.calls[2].args.api_key === 'bv_sk_one');
  bridge.kill();
}

// (9) The upload tool takes a key like the other tools
async function uploadToolKey(stub, fixtures) {
  console.log('\n# The upload tool and api_key\n');
  const bytes = crypto.randomBytes(20000);
  const file = fixtures.write('keyed.mp3', bytes);
  const uploadTool = async (bridge) => (await bridge.rpc('tools/list')).result.tools.find((tool) => tool.name === 'barevalue_upload');

  stub.reset();
  let bridge = startBridge({ BAREVALUE_MCP_URL: stub.url });
  await bridge.init();
  let tool = await uploadTool(bridge);
  check(
    'without a session key the upload tool lists api_key, in the words the other tools use',
    JSON.stringify(tool.inputSchema.properties.api_key) === JSON.stringify(API_KEY_PROPERTY) && JSON.stringify(tool.inputSchema.required) === '["file_path"]' &&
      'file_path' in tool.inputSchema.properties && !('size_bytes' in tool.inputSchema.properties)
  );
  const answer = await bridge.call('barevalue_upload', { file_path: file, api_key: 'bv_sk_passed' });
  check('and a key passed to it is the key the upload is made with', !answer.result.isError && stub.calls[0].args.api_key === 'bv_sk_passed' && stub.calls[0].key === null && stub.posts[0]?.sha === sha(bytes));
  bridge.kill();

  stub.reset();
  bridge = startBridge({ BAREVALUE_API_KEY: 'bv_sk_good', BAREVALUE_MCP_URL: stub.url });
  await bridge.init();
  tool = await uploadTool(bridge);
  check('with a session key the upload tool does not ask for one, like the other tools', !('api_key' in tool.inputSchema.properties));
  bridge.kill();
}

async function local() {
  const lib = require(BRIDGE);
  const stub = await startStub();
  const fixtures = makeFixtures();
  try {
    await keyAtStartup(stub, lib);
    await refusedKey(stub, fixtures);
    await uploadAddress(stub, fixtures, lib);
    await checkedFile(stub, fixtures);
    await longUpload(stub, fixtures);
    await storageGoesAway(stub, fixtures, lib);
    await orderAskedAgain(stub);
    await uploadToolKey(stub, fixtures);
    await streamedAnswers(stub, lib);
    windowsPaths(lib);
  } finally {
    fixtures.remove();
    await stub.close();
  }
}

(async () => {
  if (!offline) await live();
  await local();
  console.log(failures.length === 0 ? `\nAll ${checks} checks passed.` : `\n${failures.length} of ${checks} check(s) failed: ${failures.join(', ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((error) => {
  console.error('Test run crashed:', error);
  process.exit(1);
});
