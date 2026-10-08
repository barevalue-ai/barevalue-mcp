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

const TOOLS = [
  { name: 'barevalue_pricing', description: 'Prices', inputSchema: { type: 'object', properties: {} } },
  { name: 'barevalue_register', description: 'Sign up', inputSchema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] } },
  { name: 'barevalue_account', description: 'Account', inputSchema: { type: 'object', properties: { api_key: { type: 'string' } } } },
  { name: 'barevalue_upload', description: 'Upload', inputSchema: { type: 'object', properties: { filename: { type: 'string' }, size_bytes: { type: 'number' }, api_key: { type: 'string' } }, required: ['filename'] } },
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
      req.on('data', (chunk) => {
        post.bytes += chunk.length;
        post.chunks.push(chunk);
        if (stub.drainBytesPerTick > 0) {
          post.window = (post.window ?? 0) + chunk.length;
          if (post.window >= stub.drainBytesPerTick) {
            post.window = 0;
            req.pause();
            setTimeout(() => req.resume(), 50);
          }
        }
      });
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
async function startAndWatch(env, waitMs = 1500) {
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
  check('a session key that was revoked: the answer says it was dropped and what to call', answer.result.isError === true && body.session_key_forgotten === true && /barevalue_register again/.test(body.what_to_do));
  const list = await bridge.rpc('tools/list');
  check('a session key that was revoked: the tools take api_key again', 'api_key' in list.result.tools.find((tool) => tool.name === 'barevalue_account').inputSchema.properties);
  answer = await bridge.call('barevalue_account', { api_key: 'bv_sk_second' });
  check('a session key that was revoked: a working key passed as api_key is used', !answer.result.isError && payload(answer).account === 'bv_sk_second');
  await bridge.call('barevalue_register', { email: 'someone@example.com' });
  answer = await bridge.call('barevalue_account');
  check('a session key that was revoked: barevalue_register gives the session a key again', !answer.result.isError && payload(answer).account === 'bv_sk_second' && stub.calls[stub.calls.length - 1].key === 'bv_sk_second');
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
  const slow = () => { stub.reset(); stub.drainBytesPerTick = 256 * 1024; }; // about 5 MB a second
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

  // Progress
  slow();
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
  const stopped = await until(() => stub.posts[0].aborted, 3000);
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
  file = makeBig('shrinks.wav');
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
  const code = await Promise.race([bridge.exited, sleep(4000).then(() => 'still running')]);
  await until(() => stub.posts[0].aborted, 2000);
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
