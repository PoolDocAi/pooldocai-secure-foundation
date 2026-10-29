const test = require('node:test');
const assert = require('node:assert/strict');

// Import ES modules dynamically for testing
async function getEmailService() {
  return await import('../src/email-service.js');
}

test('TASK-007 Part-2: Email Content Minimization & Privacy Protection', async () => {
  const { buildNotificationEmail } = await getEmailService();

  const serviceRequestItem = {
    queue_id: '11111111-1111-1111-1111-111111111111',
    notification_id: '22222222-2222-2222-2222-222222222222',
    company_id: '33333333-3333-3333-3333-333333333333',
    company_name: 'Blue Wave Pool Service',
    user_id: '44444444-4444-4444-4444-444444444444',
    recipient_email: 'admin@bluewave.com',
    recipient_role: 'company_admin',
    event_type: 'service_request_created',
    title: 'New Customer Service Request',
    body: 'Service requested: Heater leaking water near heat exchanger. Customer: Jane Doe, 123 Main St, 555-123-4567',
    event_data: {
      priority: 'high',
      sourceType: 'customer_widget',
      customerName: 'Jane Doe',
      customerPhone: '555-123-4567',
      customerAddress: '123 Main St, Austin TX'
    }
  };

  const email = buildNotificationEmail(serviceRequestItem, { appBaseUrl: 'https://app.pooldocai.com' });

  // 1. Assert subject is non-sensitive
  assert.equal(email.subject, '[PoolDocAI] New Customer Service Request — Blue Wave Pool Service');
  assert.equal(/Jane Doe/i.test(email.subject), false, 'Subject must not leak customer name');
  assert.equal(/555-123-4567/.test(email.subject), false, 'Subject must not leak phone number');
  assert.equal(/123 Main St/i.test(email.subject), false, 'Subject must not leak address');

  // 2. Assert plaintext body excludes raw customer PII and includes authenticated portal deep link
  assert.equal(/Jane Doe/i.test(email.text), false, 'Plaintext body must not leak customer name');
  assert.equal(/555-123-4567/.test(email.text), false, 'Plaintext body must not leak phone number');
  assert.equal(/123 Main St/i.test(email.text), false, 'Plaintext body must not leak address');
  assert.equal(/heater leaking/i.test(email.text), false, 'Plaintext body must not leak specific diagnosis details');
  assert.match(email.text, /https:\/\/app\.pooldocai\.com\/admin/, 'Admin recipient must receive admin portal URL');
  assert.match(email.text, /For customer privacy and security/, 'Must include privacy statement');

  // 3. Assert HTML body excludes PII and escapes company name
  assert.equal(/Jane Doe/i.test(email.html), false, 'HTML body must not leak customer name');
  assert.equal(/555-123-4567/.test(email.html), false, 'HTML body must not leak phone number');
  assert.match(email.html, /Blue Wave Pool Service/, 'Must render company name');
  assert.match(email.html, /href="https:\/\/app\.pooldocai\.com\/admin"/, 'Must link to secure authenticated portal');

  // 4. Test technician recipient role routes to technician portal
  const techItem = { ...serviceRequestItem, recipient_role: 'technician' };
  const techEmail = buildNotificationEmail(techItem, { appBaseUrl: 'https://app.pooldocai.com' });
  assert.match(techEmail.text, /https:\/\/app\.pooldocai\.com\/technician/, 'Tech recipient must receive technician portal URL');
});

test('TASK-007 Part-2: Mock Email Adapter Dispatches & Records Idempotency Key', async () => {
  const { MockEmailAdapter } = await getEmailService();
  const adapter = new MockEmailAdapter();

  const idempotencyKey = 'email-notif-uuid-1-user-uuid-1';
  const result = await adapter.send({
    to: 'tech@example.com',
    subject: 'Test Notification',
    text: 'Test message',
    html: '<p>Test message</p>',
    idempotencyKey
  });

  assert.equal(result.success, true);
  assert.equal(result.status, 200);
  assert.match(result.messageId, /^mock_msg_/);
  assert.equal(adapter.sentEmails.length, 1);
  assert.equal(adapter.sentEmails[0].to, 'tech@example.com');
  assert.equal(adapter.sentEmails[0].idempotencyKey, idempotencyKey);
  assert.equal(adapter.recordedIdempotencyKeys.has(idempotencyKey), true);
});

test('TASK-007 Part-2: Provider Error Classifications (Retryable vs Terminal)', async () => {
  const { MockEmailAdapter } = await getEmailService();
  const adapter = new MockEmailAdapter();

  // Test 429 Rate Limit (Retryable)
  adapter.setOutcome({ success: false, retryable: true, error: 'Resend HTTP 429: Rate limit exceeded', status: 429 });
  const r429 = await adapter.send({ to: 'admin@example.com', subject: 'Test' });
  assert.equal(r429.success, false);
  assert.equal(r429.retryable, true);
  assert.equal(r429.status, 429);

  // Test 500 Server Error (Retryable)
  adapter.setOutcome({ success: false, retryable: true, error: 'Resend HTTP 500: Internal server error', status: 500 });
  const r500 = await adapter.send({ to: 'admin@example.com', subject: 'Test' });
  assert.equal(r500.success, false);
  assert.equal(r500.retryable, true);

  // Test 400 Client Error / Invalid Recipient (Terminal / Non-retryable)
  adapter.setOutcome({ success: false, retryable: false, error: 'Resend HTTP 422: The recipient email address is invalid', status: 422 });
  const r422 = await adapter.send({ to: 'invalid@', subject: 'Test' });
  assert.equal(r422.success, false);
  assert.equal(r422.retryable, false);

  // Test Network Timeout (Retryable)
  adapter.setOutcome({ success: false, retryable: true, error: 'Connection timed out' });
  const rTimeout = await adapter.send({ to: 'admin@example.com', subject: 'Test' });
  assert.equal(rTimeout.success, false);
  assert.equal(rTimeout.retryable, true);
});

test('TASK-007 Part-2: Queue Processing Lifecycle with Lease Fencing', async () => {
  const { processEmailBatch, MockEmailAdapter } = await getEmailService();
  const adapter = new MockEmailAdapter();

  // Simulated Supabase DB with claiming and finishing RPCs
  let queueState = [
    {
      queue_id: 'q-1',
      notification_id: 'n-1',
      company_id: 'co-a',
      company_name: 'Company A',
      user_id: 'u-1',
      recipient_email: 'user1@example.com',
      recipient_role: 'company_admin',
      event_type: 'service_request_created',
      title: 'New Service Request',
      body: 'Service requested: Filter replacement',
      event_data: { priority: 'normal' },
      attempts: 1,
      idempotency_key: 'email-n-1-u-1'
    }
  ];

  const finishedCalls = [];

  const mockDb = {
    rpc: async (fnName, params) => {
      if (fnName === 'pooldocai_claim_email_delivery_batch') {
        const batch = queueState.splice(0, params.p_batch_size || 10);
        return { data: batch, error: null };
      }
      if (fnName === 'pooldocai_finish_email_delivery') {
        finishedCalls.push(params);
        return { data: true, error: null };
      }
      return { data: null, error: { message: `Unknown RPC: ${fnName}` } };
    }
  };

  const summary = await processEmailBatch(mockDb, adapter, { workerId: 'test_worker_1' });

  assert.equal(summary.processed, 1);
  assert.equal(summary.successes, 1);
  assert.equal(summary.failures, 0);

  assert.equal(finishedCalls.length, 1);
  assert.equal(finishedCalls[0].p_queue_id, 'q-1');
  assert.equal(finishedCalls[0].p_lease_token, 'test_worker_1');
  assert.equal(finishedCalls[0].p_success, true);
  assert.match(finishedCalls[0].p_provider_message_id, /^mock_msg_/);
});

test('TASK-007 Part-2: Stale Worker Lease Fencing Detection', async () => {
  const { processEmailBatch, MockEmailAdapter } = await getEmailService();
  const adapter = new MockEmailAdapter();

  const mockDbFenced = {
    rpc: async (fnName, params) => {
      if (fnName === 'pooldocai_claim_email_delivery_batch') {
        return {
          data: [{
            queue_id: 'q-stale',
            notification_id: 'n-2',
            company_id: 'co-b',
            company_name: 'Company B',
            user_id: 'u-2',
            recipient_email: 'user2@example.com',
            recipient_role: 'technician',
            event_type: 'service_request_assigned',
            title: 'Assigned',
            body: 'Job assigned',
            event_data: {},
            attempts: 2,
            idempotency_key: 'email-n-2-u-2',
            lease_token: 'claim_stale_uuid'
          }],
          error: null
        };
      }
      if (fnName === 'pooldocai_finish_email_delivery') {
        // Return false to simulate stale worker fenced out (row lease reclaimed)
        return { data: false, error: null };
      }
      return { data: null, error: null };
    }
  };

  const summary = await processEmailBatch(mockDbFenced, adapter, { workerId: 'stale_worker' });

  assert.equal(summary.processed, 1);
  assert.equal(summary.successes, 0);
  assert.equal(summary.failures, 1, 'Fenced-out worker must be counted as failure');
});

test('TASK-007 Part-2: Fail-Closed Default When Email Provider Unconfigured', async () => {
  const { UnconfiguredEmailAdapter, processEmailBatch } = await getEmailService();
  const unconfiguredAdapter = new UnconfiguredEmailAdapter();

  // 1. Unconfigured adapter must fail closed with explicit reason and zero receipt
  const sendResult = await unconfiguredAdapter.send({
    to: 'tech@example.com',
    subject: 'Unconfigured Test',
    text: 'Body text'
  });

  assert.equal(sendResult.success, false, 'Unconfigured adapter must not report success');
  assert.equal(sendResult.retryable, false, 'Unconfigured adapter is non-retryable without config');
  assert.equal(sendResult.error, 'EMAIL_PROVIDER_UNCONFIGURED');
  assert.equal(sendResult.messageId, undefined, 'Must never produce a fake provider message ID');

  // 2. processEmailBatch must fail closed and refuse to claim/process queue rows
  let rpcClaimCalled = false;
  const mockDb = {
    rpc: async (fnName) => {
      if (fnName === 'pooldocai_claim_email_delivery_batch') {
        rpcClaimCalled = true;
      }
      return { data: [], error: null };
    }
  };

  const summary = await processEmailBatch(mockDb, unconfiguredAdapter);
  assert.equal(rpcClaimCalled, false, 'Must never claim real queue items when provider unconfigured');
  assert.equal(summary.processed, 0);
  assert.equal(summary.status, 'unconfigured');
  assert.match(summary.warning, /Email provider unconfigured/);
});

test('TASK-007 Part-2: Per-Claim Unique Lease Token & ABA Prevention', async () => {
  const { processEmailBatch, MockEmailAdapter } = await getEmailService();
  const adapter = new MockEmailAdapter();

  let capturedFinishToken = null;
  const mockDb = {
    rpc: async (fnName, params) => {
      if (fnName === 'pooldocai_claim_email_delivery_batch') {
        return {
          data: [{
            queue_id: 'q-aba-test',
            notification_id: 'n-aba',
            company_id: 'co-aba',
            company_name: 'ABA Co',
            user_id: 'u-aba',
            recipient_email: 'aba@example.com',
            recipient_role: 'technician',
            event_type: 'service_request_created',
            title: 'ABA Test',
            body: 'Checking ABA lease tokens',
            event_data: {},
            attempts: 1,
            idempotency_key: 'email-n-aba-u-aba',
            lease_token: 'claim_unique_per_attempt_777'
          }],
          error: null
        };
      }
      if (fnName === 'pooldocai_finish_email_delivery') {
        capturedFinishToken = params.p_lease_token;
        return { data: true, error: null };
      }
      return { data: null, error: null };
    }
  };

  await processEmailBatch(mockDb, adapter, { workerId: 'worker_static_pid' });

  // Assert finish was invoked with the unique DB-generated per-claim token, NOT the static worker ID
  assert.equal(capturedFinishToken, 'claim_unique_per_attempt_777', 'Must pass per-claim lease token to prevent ABA');
  assert.notEqual(capturedFinishToken, 'worker_static_pid', 'Must not rely on static worker ID for lease fencing');
});
