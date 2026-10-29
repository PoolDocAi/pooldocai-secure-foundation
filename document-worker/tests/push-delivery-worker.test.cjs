const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Import ES modules dynamically for testing
async function getPushService() {
  return await import('../src/push-service.js');
}

test('TASK-007 Part-3: Push Payload Minimization & Privacy Protection', async () => {
  const { buildNotificationPushPayload } = await getPushService();

  const serviceRequestItem = {
    queue_id: '11111111-1111-1111-1111-111111111111',
    notification_id: '22222222-2222-2222-2222-222222222222',
    company_id: '33333333-3333-3333-3333-333333333333',
    company_name: 'Clear Blue Waters LLC',
    user_id: '44444444-4444-4444-4444-444444444444',
    recipient_role: 'technician',
    event_type: 'service_request_created',
    title: 'New Service Request',
    body: 'Customer John Smith, 456 Elm St, 555-987-6543 reports pump motor smoking',
    event_data: {
      priority: 'high',
      customerName: 'John Smith',
      customerPhone: '555-987-6543',
      address: '456 Elm St'
    }
  };

  const payload = buildNotificationPushPayload(serviceRequestItem, { appBaseUrl: 'https://pooldocai.com' });

  // 1. Assert title and body are privacy-minimized
  assert.equal(payload.title, '[PoolDocAI] New Service Request');
  assert.equal(/John Smith/i.test(payload.body), false, 'Push body must not leak customer name');
  assert.equal(/555-987-6543/.test(payload.body), false, 'Push body must not leak customer phone');
  assert.equal(/456 Elm/i.test(payload.body), false, 'Push body must not leak customer address');
  assert.equal(/motor smoking/i.test(payload.body), false, 'Push body must not leak diagnostic details');

  // 2. Assert deep-link routes to technician portal
  assert.equal(payload.data.url, 'https://pooldocai.com/technician.html');
  assert.equal(payload.data.companyId, '33333333-3333-3333-3333-333333333333');
  assert.equal(payload.data.notificationId, '22222222-2222-2222-2222-222222222222');

  // 3. Test company_admin role routes to admin portal
  const adminItem = { ...serviceRequestItem, recipient_role: 'company_admin' };
  const adminPayload = buildNotificationPushPayload(adminItem, { appBaseUrl: 'https://pooldocai.com' });
  assert.equal(adminPayload.data.url, 'https://pooldocai.com/admin.html');
});

test('TASK-007 Part-3: Mock Push Adapter Dispatches & Records Idempotency Key', async () => {
  const { MockPushAdapter } = await getPushService();
  const adapter = new MockPushAdapter();

  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/fake_endpoint_123',
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QT9AcPP313T59P2O_AfWJUTTxlnBeQKE',
    auth: 'tBHItJI5svbpez7KI4CCXg'
  };

  const idempotencyKey = 'push-notif-uuid-1-user-uuid-1';
  const result = await adapter.send(subscription, { title: 'Test Alert', body: 'Test body' }, { idempotencyKey });

  assert.equal(result.success, true);
  assert.equal(result.status, 201);
  assert.match(result.messageId, /^mock_push_/);
  assert.equal(adapter.sentPushes.length, 1);
  assert.equal(adapter.sentPushes[0].endpoint, subscription.endpoint);
  assert.equal(adapter.sentPushes[0].idempotencyKey, idempotencyKey);
  assert.equal(adapter.recordedIdempotencyKeys.has(idempotencyKey), true);
});

test('TASK-007 Part-3: Provider Error Classifications (404/410 Revocation vs 429/500 Retries)', async () => {
  const { MockPushAdapter } = await getPushService();
  const adapter = new MockPushAdapter();
  const subscription = { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/dead_token' };

  // 1. Expired subscription (410 Gone) -> Non-retryable + Revocation
  adapter.setOutcome({
    success: false,
    retryable: false,
    error: 'SUBSCRIPTION_EXPIRED_410',
    status: 410,
    revokedEndpoint: subscription.endpoint
  });
  const r410 = await adapter.send(subscription, { title: 'Test' });
  assert.equal(r410.success, false);
  assert.equal(r410.retryable, false);
  assert.equal(r410.revokedEndpoint, subscription.endpoint);

  // 2. Rate limit (429) -> Retryable
  adapter.setOutcome({
    success: false,
    retryable: true,
    error: 'PUSH_GATEWAY_TEMPORARY_429',
    status: 429
  });
  const r429 = await adapter.send(subscription, { title: 'Test' });
  assert.equal(r429.success, false);
  assert.equal(r429.retryable, true);

  // 3. Server error (503) -> Retryable
  adapter.setOutcome({
    success: false,
    retryable: true,
    error: 'PUSH_GATEWAY_TEMPORARY_503',
    status: 503
  });
  const r503 = await adapter.send(subscription, { title: 'Test' });
  assert.equal(r503.success, false);
  assert.equal(r503.retryable, true);
});

test('TASK-007 Part-3: Push Queue Lifecycle & 404/410 Auto-Revocation', async () => {
  const { MockPushAdapter, processPushBatch } = await getPushService();
  const adapter = new MockPushAdapter();

  const claimedQueueItem = {
    queue_id: 'q-push-001',
    notification_id: 'n-push-001',
    company_id: 'c-push-001',
    company_name: 'Crystal Clean Pools',
    user_id: 'u-push-001',
    recipient_role: 'technician',
    event_type: 'service_request_created',
    title: 'New Service Request',
    body: 'A customer submitted a new service request',
    event_data: { priority: 'normal' },
    subscriptions: [
      {
        id: 'sub-live-1',
        endpoint: 'https://fcm.googleapis.com/fcm/send/live_device',
        p256dh: 'test_p256dh',
        auth: 'test_auth'
      },
      {
        id: 'sub-dead-2',
        endpoint: 'https://fcm.googleapis.com/fcm/send/expired_device',
        p256dh: 'dead_p256dh',
        auth: 'dead_auth'
      }
    ],
    attempts: 1,
    idempotency_key: 'push-n-push-001-u-push-001',
    lease_token: 'claim_uuid_valid_token'
  };

  // First sub succeeds, second sub returns 410 Gone
  let callCount = 0;
  adapter.send = async (sub, payload, options) => {
    callCount++;
    if (sub.endpoint.includes('expired_device')) {
      return {
        success: false,
        retryable: false,
        error: 'SUBSCRIPTION_EXPIRED_410',
        status: 410,
        revokedEndpoint: sub.endpoint
      };
    }
    return { success: true, status: 201, messageId: 'push_live_msg_123' };
  };

  let finishedParams = null;
  const mockDb = {
    rpc: async (name, params) => {
      if (name === 'pooldocai_claim_push_delivery_batch') {
        return { data: [claimedQueueItem], error: null };
      }
      if (name === 'pooldocai_finish_push_delivery') {
        finishedParams = params;
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC call: ${name}`);
    }
  };

  const summary = await processPushBatch(mockDb, adapter, { batchSize: 5 });
  assert.equal(summary.processed, 1);
  assert.equal(summary.successes, 1);
  assert.equal(summary.failures, 0);

  // Verify finish RPC received the revoked endpoint
  assert.ok(finishedParams);
  assert.equal(finishedParams.p_queue_id, 'q-push-001');
  assert.equal(finishedParams.p_lease_token, 'claim_uuid_valid_token');
  assert.equal(finishedParams.p_success, true);
  assert.deepEqual(finishedParams.p_revoked_endpoints, ['https://fcm.googleapis.com/fcm/send/expired_device']);
});

test('TASK-007 Part-3: Stale Worker Lease Fencing Detection', async () => {
  const { MockPushAdapter, processPushBatch } = await getPushService();
  const adapter = new MockPushAdapter();

  const claimedQueueItem = {
    queue_id: 'q-push-stale',
    notification_id: 'n-push-stale',
    company_id: 'c-push-stale',
    company_name: 'Safe Pool Co',
    user_id: 'u-push-stale',
    recipient_role: 'technician',
    event_type: 'service_request_created',
    title: 'Test',
    body: 'Test',
    subscriptions: [{ endpoint: 'https://fcm.googleapis.com/fcm/send/stale_sub' }],
    attempts: 1,
    idempotency_key: 'push-stale-key',
    lease_token: 'claim_stale_uuid'
  };

  const mockDb = {
    rpc: async (name) => {
      if (name === 'pooldocai_claim_push_delivery_batch') {
        return { data: [claimedQueueItem], error: null };
      }
      if (name === 'pooldocai_finish_push_delivery') {
        // Fenced out by DB: lease expired or reclaimed
        return { data: false, error: null };
      }
      throw new Error(`Unexpected RPC call: ${name}`);
    }
  };

  const summary = await processPushBatch(mockDb, adapter);
  assert.equal(summary.processed, 1);
  assert.equal(summary.successes, 0);
  assert.equal(summary.failures, 1);
});

test('TASK-007 Part-3: Fail-Closed Default When Push Provider Unconfigured', async () => {
  const { UnconfiguredPushAdapter, processPushBatch } = await getPushService();
  const adapter = new UnconfiguredPushAdapter();

  let dbCalled = false;
  const mockDb = {
    rpc: async () => {
      dbCalled = true;
      return { data: [], error: null };
    }
  };

  const summary = await processPushBatch(mockDb, adapter);
  assert.equal(summary.processed, 0);
  assert.equal(summary.successes, 0);
  assert.equal(summary.failures, 0);
  assert.equal(summary.status, 'unconfigured');
  assert.equal(dbCalled, false, 'Queue claim RPC must not be called when push provider is unconfigured');

  // Verify direct send also fails closed
  const sendRes = await adapter.send({ endpoint: 'https://fcm.googleapis.com/test' }, {});
  assert.equal(sendRes.success, false);
  assert.equal(sendRes.retryable, false);
  assert.equal(sendRes.error, 'PUSH_PROVIDER_UNCONFIGURED');
});

test('TASK-007 Part-3: RFC 8291 aes128gcm Payload Encryption & Decryption Roundtrip', async () => {
  const { encryptPushPayload } = await getPushService();

  // 1. Client simulates generating P-256 ECDH keys + auth secret
  const clientEcdh = crypto.createECDH('prime256v1');
  clientEcdh.generateKeys();
  const clientPubKeyB64 = clientEcdh.getPublicKey().toString('base64url');
  const clientAuthB64 = crypto.randomBytes(16).toString('base64url');

  const testPayload = JSON.stringify({
    title: '[PoolDocAI] Service Request Assigned',
    body: 'Clear Blue Waters: You have been assigned to a service request.',
    data: { url: '/technician.html', companyId: 'c-123' }
  });

  // 2. Server encrypts payload
  const encrypted = encryptPushPayload(testPayload, clientPubKeyB64, clientAuthB64);
  assert.equal(encrypted.headers['Content-Encoding'], 'aes128gcm');
  assert.ok(encrypted.body.length > 86, 'Body must contain 86-byte header + ciphertext');

  // 3. Client decrypts body to verify RFC 8291 compliance
  const body = encrypted.body;
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body.readUInt8(20);
  const serverPubKey = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);

  assert.equal(idlen, 65, 'P-256 uncompressed key must be 65 bytes');
  assert.equal(rs, 4096);

  const clientShared = clientEcdh.computeSecret(serverPubKey);
  const authInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    Buffer.from(clientPubKeyB64, 'base64url'),
    serverPubKey
  ]);
  const prk = crypto.hkdfSync('sha256', clientShared, Buffer.from(clientAuthB64, 'base64url'), authInfo, 32);
  const cek = crypto.hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = crypto.hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const cipherdata = ciphertext.subarray(0, ciphertext.length - 16);

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(authTag);
  const decryptedPadded = Buffer.concat([decipher.update(cipherdata), decipher.final()]);
  const decryptedText = decryptedPadded.subarray(0, decryptedPadded.length - 1).toString('utf8');

  assert.equal(decryptedText, testPayload, 'Decrypted text must match original payload exactly');
});

test('TASK-007 Part-3: RFC 8292 ES256 VAPID Authorization Header Generation', async () => {
  const { createVapidAuthHeader } = await getPushService();

  // Generate test P-256 VAPID keypair
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const endpoint = 'https://fcm.googleapis.com/fcm/send/device_token_xyz';
  const header = createVapidAuthHeader(endpoint, publicKey, privateKey, 'mailto:admin@pooldocai.com');

  assert.match(header, /^vapid t=[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+, k=[a-zA-Z0-9_-]+$/);

  // Validate JWT payload
  const token = header.match(/^vapid t=([^,]+),/)[1];
  const [hB64, pB64, sigB64] = token.split('.');
  const parsedPayload = JSON.parse(Buffer.from(pB64, 'base64url').toString('utf8'));

  assert.equal(parsedPayload.aud, 'https://fcm.googleapis.com');
  assert.equal(parsedPayload.sub, 'mailto:admin@pooldocai.com');
  assert.ok(parsedPayload.exp > Date.now() / 1000);

  // Validate signature with public key
  const verifier = crypto.createVerify('SHA256');
  verifier.update(`${hB64}.${pB64}`);
  const verified = verifier.verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sigB64, 'base64url'));
  assert.equal(verified, true, 'ES256 signature must verify against VAPID public key');
});
