#!/usr/bin/env node

/**
 * MCP Server Test Script
 * Tests all tools against the real Barevalue API
 */

const { spawn } = require('child_process');
const path = require('path');

const API_KEY = process.env.BAREVALUE_API_KEY;
if (!API_KEY) {
  console.error('Error: BAREVALUE_API_KEY environment variable required');
  process.exit(1);
}

// Test results tracking
const results = {
  passed: [],
  failed: [],
};

// Start MCP server
function startServer() {
  return spawn('node', [path.join(__dirname, 'dist/index.js')], {
    env: { ...process.env, BAREVALUE_API_KEY: API_KEY },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// Send JSON-RPC request and get response
function sendRequest(proc, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Date.now();
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    }) + '\n';

    let buffer = '';
    const onData = (data) => {
      buffer += data.toString();
      // Try to parse complete JSON objects
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === id) {
            proc.stdout.off('data', onData);
            resolve(parsed);
          }
        } catch (e) {
          // Not complete JSON yet
        }
      }
    };

    proc.stdout.on('data', onData);
    proc.stdin.write(request);

    // Timeout after 30 seconds
    setTimeout(() => {
      proc.stdout.off('data', onData);
      reject(new Error('Request timed out'));
    }, 30000);
  });
}

// Run a test
async function runTest(proc, name, toolName, args, validator) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TEST: ${name}`);
  console.log(`Tool: ${toolName}`);
  console.log(`Args: ${JSON.stringify(args)}`);
  console.log('='.repeat(60));

  try {
    const response = await sendRequest(proc, 'tools/call', {
      name: toolName,
      arguments: args,
    });

    if (response.error) {
      throw new Error(`MCP Error: ${response.error.message}`);
    }

    const content = response.result?.content?.[0]?.text;
    if (!content) {
      throw new Error('No content in response');
    }

    const data = JSON.parse(content);
    console.log('\nResponse:');
    console.log(JSON.stringify(data, null, 2));

    // Check for API error in response
    if (data.error) {
      throw new Error(`API Error: ${data.error} - ${data.message}`);
    }

    // Run custom validator if provided
    if (validator) {
      validator(data);
    }

    console.log('\n✅ PASSED');
    results.passed.push(name);
    return data;
  } catch (error) {
    console.log(`\n❌ FAILED: ${error.message}`);
    results.failed.push({ name, error: error.message });
    return null;
  }
}

// Main test suite
async function runTests() {
  console.log('Starting MCP Server...');
  const proc = startServer();

  // Wait for server to start
  await new Promise((resolve) => {
    proc.stderr.once('data', (data) => {
      console.log('Server:', data.toString().trim());
      resolve();
    });
  });

  // Initialize
  console.log('\nInitializing MCP connection...');
  const initResponse = await sendRequest(proc, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' },
  });
  console.log('Protocol version:', initResponse.result?.protocolVersion);

  // List tools
  const toolsResponse = await sendRequest(proc, 'tools/list', {});
  console.log(`\nRegistered tools: ${toolsResponse.result?.tools?.length}`);

  // ============================================
  // Test 1: Account Info
  // ============================================
  await runTest(
    proc,
    'Get Account Info',
    'barevalue_account',
    {},
    (data) => {
      if (!data.id) throw new Error('Missing id');
      if (typeof data.credit_balance !== 'number') throw new Error('Missing credit_balance');
    }
  );

  // ============================================
  // Test 2: Estimate Cost
  // ============================================
  await runTest(
    proc,
    'Estimate Order Cost (5 minutes)',
    'barevalue_estimate',
    { duration_minutes: 5 },
    (data) => {
      if (typeof data.gross_cost !== 'number') throw new Error('Missing gross_cost');
      // 5 min * $0.07 = $0.35
      if (data.gross_cost !== 0.35) throw new Error(`Expected gross_cost 0.35, got ${data.gross_cost}`);
    }
  );

  // ============================================
  // Test 3: List Orders
  // ============================================
  const ordersData = await runTest(
    proc,
    'List Orders',
    'barevalue_list_orders',
    { per_page: 5 },
    (data) => {
      if (!Array.isArray(data.orders)) throw new Error('Missing orders array');
      if (!data.pagination) throw new Error('Missing pagination');
    }
  );

  // ============================================
  // Test 4: List Webhooks
  // ============================================
  await runTest(
    proc,
    'List Webhooks',
    'barevalue_webhooks_list',
    {},
    (data) => {
      if (!Array.isArray(data.webhooks)) throw new Error('Missing webhooks array');
    }
  );

  // ============================================
  // Test 5: Get Order Status (use existing order if available)
  // ============================================
  if (ordersData?.orders?.length > 0) {
    const testOrderId = ordersData.orders[0].order_id;
    await runTest(
      proc,
      `Get Order Status (order ${testOrderId})`,
      'barevalue_status',
      { order_id: testOrderId },
      (data) => {
        if (!data.order_id) throw new Error('Missing order_id');
        if (!data.status) throw new Error('Missing status');
      }
    );
  } else {
    console.log('\n⏭️  SKIPPED: Get Order Status (no existing orders)');
  }

  // ============================================
  // Test 6: Upload File (costs nothing until submit)
  // ============================================
  const TEST_FILE = '/tmp/test_audio_10sec.mp3';
  let uploadResult = null;

  // Check if test file exists
  const fs = require('fs');
  if (fs.existsSync(TEST_FILE)) {
    uploadResult = await runTest(
      proc,
      'Upload Audio File',
      'barevalue_upload',
      { file_path: TEST_FILE },
      (data) => {
        if (!data.order_id) throw new Error('Missing order_id');
        if (!data.s3_key) throw new Error('Missing s3_key');
      }
    );

    // ============================================
    // Test 7: Validate Uploaded File (costs nothing)
    // ============================================
    if (uploadResult) {
      await runTest(
        proc,
        'Validate Uploaded File',
        'barevalue_validate',
        { order_id: uploadResult.order_id, s3_key: uploadResult.s3_key },
        (data) => {
          // Validation may pass or fail, but should have these fields
          if (typeof data.valid !== 'boolean' && !data.error) {
            throw new Error('Missing valid field');
          }
        }
      );
    }
  } else {
    console.log(`\n⏭️  SKIPPED: Upload tests (no test file at ${TEST_FILE})`);
  }

  // ============================================
  // Summary
  // ============================================
  console.log('\n' + '='.repeat(60));
  console.log('TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`✅ Passed: ${results.passed.length}`);
  console.log(`❌ Failed: ${results.failed.length}`);

  if (results.failed.length > 0) {
    console.log('\nFailed tests:');
    results.failed.forEach((f) => {
      console.log(`  - ${f.name}: ${f.error}`);
    });
  }

  // Cleanup
  proc.kill();
  process.exit(results.failed.length > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Test suite error:', err);
  process.exit(1);
});
