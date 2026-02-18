#!/usr/bin/env node

/**
 * Webhook Operations Test Script
 */

const { spawn } = require('child_process');

const API_KEY = process.env.BAREVALUE_API_KEY;
if (!API_KEY) {
  console.error('Error: BAREVALUE_API_KEY required');
  process.exit(1);
}

const proc = spawn('node', ['dist/index.js'], {
  env: { ...process.env, BAREVALUE_API_KEY: API_KEY },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let msgId = 1;

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    let buffer = '';

    const onData = (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === id) {
            proc.stdout.off('data', onData);
            resolve(parsed);
          }
        } catch(e) {
          // Not complete JSON yet
        }
      }
    };

    proc.stdout.on('data', onData);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');

    setTimeout(() => {
      proc.stdout.off('data', onData);
      reject(new Error('Timeout'));
    }, 60000);
  });
}

async function callTool(name, args = {}) {
  const res = await send('tools/call', { name, arguments: args });
  const content = res.result?.content?.[0]?.text;
  return JSON.parse(content);
}

async function test(name, fn) {
  process.stdout.write(name + '... ');
  try {
    const result = await fn();
    console.log('✅');
    return { success: true, result };
  } catch (e) {
    console.log('❌', e.message);
    return { success: false, error: e.message };
  }
}

async function run() {
  // Wait for server start
  await new Promise(r => proc.stderr.once('data', () => r()));

  // Initialize
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' }
  });

  console.log('\n=== Webhook Operations Test Suite ===\n');

  let passed = 0, failed = 0;
  let createdWebhookId = null;
  let webhookSecret = null;

  // Test 1: Create webhook
  const createResult = await test('1. Create Webhook', async () => {
    const data = await callTool('barevalue_webhook_create', {
      url: 'https://httpbin.org/post',
      events: ['order.completed', 'order.failed']
    });
    console.log('\n   Response:', JSON.stringify(data, null, 2).split('\n').join('\n   '));
    if (data.error) throw new Error(data.message);
    if (!data.id) throw new Error('No webhook id returned');
    if (!data.secret) throw new Error('No secret returned');
    createdWebhookId = data.id;
    webhookSecret = data.secret;
    return data;
  });
  if (createResult.success) passed++; else failed++;

  await new Promise(r => setTimeout(r, 2000));

  // Test 2: Update webhook
  if (createdWebhookId) {
    const updateResult = await test('2. Update Webhook', async () => {
      const data = await callTool('barevalue_webhook_update', {
        webhook_id: createdWebhookId,
        events: ['order.completed', 'order.failed', 'order.refunded'],
        is_active: true
      });
      console.log('\n   Response:', JSON.stringify(data, null, 2).split('\n').join('\n   '));
      if (data.error) throw new Error(data.message);
      if (!data.events || data.events.length !== 3) throw new Error('Events not updated');
      return data;
    });
    if (updateResult.success) passed++; else failed++;
  } else {
    console.log('2. Update Webhook... ⏭️  SKIPPED');
  }

  await new Promise(r => setTimeout(r, 2000));

  // Test 3: Rotate secret
  if (createdWebhookId) {
    const rotateResult = await test('3. Rotate Webhook Secret', async () => {
      const data = await callTool('barevalue_webhook_rotate_secret', {
        webhook_id: createdWebhookId
      });
      console.log('\n   Response:', JSON.stringify(data, null, 2).split('\n').join('\n   '));
      if (data.error) throw new Error(data.message);
      if (!data.secret) throw new Error('No new secret returned');
      if (data.secret === webhookSecret) throw new Error('Secret was not rotated');
      return data;
    });
    if (rotateResult.success) passed++; else failed++;
  } else {
    console.log('3. Rotate Webhook Secret... ⏭️  SKIPPED');
  }

  await new Promise(r => setTimeout(r, 2000));

  // Test 4: Delete webhook (cleanup)
  if (createdWebhookId) {
    const deleteResult = await test('4. Delete Webhook', async () => {
      const data = await callTool('barevalue_webhook_delete', {
        webhook_id: createdWebhookId
      });
      console.log('\n   Response:', JSON.stringify(data, null, 2).split('\n').join('\n   '));
      if (data.error) throw new Error(data.message);
      return data;
    });
    if (deleteResult.success) passed++; else failed++;
  } else {
    console.log('4. Delete Webhook... ⏭️  SKIPPED');
  }

  console.log('\n=== Results ===');
  console.log('Passed:', passed);
  console.log('Failed:', failed);
  console.log('Webhook operations:', passed === 4 ? '100% verified ✅' : 'Issues found ⚠️');

  proc.kill();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Test error:', e);
  proc.kill();
  process.exit(1);
});
