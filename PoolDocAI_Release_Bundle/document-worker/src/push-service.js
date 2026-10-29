import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';

/**
 * Builds privacy-minimized Web Push notification payloads.
 * Strictly avoids leaking customer PII (names, phone numbers, street addresses,
 * full diagnostic conversation transcripts) into cleartext push payloads dispatched
 * over push services (Google FCM, Apple APNs, Mozilla Push Service).
 */
export function buildNotificationPushPayload(item, options = {}) {
  const appBaseUrl = (options.appBaseUrl || process.env.APP_BASE_URL || 'https://app.pooldocai.com').replace(/\/+$/, '');
  const companyName = item.company_name || 'PoolDocAI';
  const eventType = item.event_type || 'notification';
  const role = item.recipient_role || 'technician';
  const isCompanyAdmin = role === 'company_admin';
  const portalUrl = isCompanyAdmin ? `${appBaseUrl}/admin.html` : `${appBaseUrl}/technician.html`;

  let headline = 'PoolDocAI Notification';
  let summary = 'You have a new company notification.';

  if (eventType === 'service_request_created') {
    headline = 'New Service Request';
    const priority = item.event_data?.priority || 'normal';
    summary = `New ${priority} priority service request received.`;
  } else if (eventType === 'service_request_assigned') {
    headline = 'Service Request Assigned';
    summary = 'You have been assigned to a service request.';
  } else if (eventType === 'member_invited') {
    headline = 'Workspace Invitation';
    summary = 'A new team member seat has been invited.';
  }

  return {
    title: `[PoolDocAI] ${headline}`,
    body: `${companyName}: ${summary}`,
    icon: '/pooldocai-app-icon-192.png',
    badge: '/technician-icon.svg',
    tag: `pooldocai-${eventType}`,
    renotify: true,
    data: {
      url: portalUrl,
      companyId: item.company_id,
      notificationId: item.notification_id,
      eventType
    }
  };
}

/**
 * Encrypts a push payload according to RFC 8291 (aes128gcm message encryption).
 * Uses pure Node standard library (node:crypto).
 */
export function encryptPushPayload(payloadString, p256dhBase64, authBase64) {
  if (!p256dhBase64 || !authBase64) {
    return { body: Buffer.alloc(0), headers: {} };
  }

  const clientPubKey = Buffer.from(p256dhBase64, 'base64url');
  const clientAuth = Buffer.from(authBase64, 'base64url');

  if (clientPubKey.length !== 65 || clientAuth.length < 16) {
    throw new Error('Invalid client push subscription public key or auth secret');
  }

  // Generate ephemeral ECDH keypair
  const serverEcdh = crypto.createECDH('prime256v1');
  serverEcdh.generateKeys();
  const serverPubKey = serverEcdh.getPublicKey();
  const sharedSecret = serverEcdh.computeSecret(clientPubKey);

  const salt = crypto.randomBytes(16);

  // Derive PRK: IKM = sharedSecret, salt = clientAuth, info = 'WebPush: info\0' || clientPubKey || serverPubKey
  const authInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    clientPubKey,
    serverPubKey
  ]);
  const prk = crypto.hkdfSync('sha256', sharedSecret, clientAuth, authInfo, 32);

  // Derive CEK (16 bytes) and Nonce (12 bytes)
  const cek = crypto.hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = crypto.hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  // Pad payload (0x02 indicates final record delimiter in RFC 8291)
  const plaintext = Buffer.from(payloadString, 'utf8');
  const padded = Buffer.concat([plaintext, Buffer.from([2])]);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  // Assemble aes128gcm body header: salt(16) + rs(4) + idlen(1) + serverPubKey(65) + ciphertext
  const header = Buffer.alloc(16 + 4 + 1 + serverPubKey.length);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(serverPubKey.length, 20);
  serverPubKey.copy(header, 21);

  const body = Buffer.concat([header, ciphertext]);

  return {
    body,
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.length)
    }
  };
}

/**
 * Creates an RFC 8292 VAPID Authorization header using ES256 (P-256 ECDSA).
 */
export function createVapidAuthHeader(endpoint, vapidPublicKey, vapidPrivateKey, vapidSubject) {
  const url = new URL(endpoint);
  const aud = `${url.protocol}//${url.host}`;
  const exp = Math.floor(Date.now() / 1000) + 43200; // 12 hours

  const headerB64 = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify({
    aud,
    exp,
    sub: vapidSubject || 'mailto:security@pooldocai.com'
  })).toString('base64url');

  const unsignedToken = `${headerB64}.${payloadB64}`;

  // Sign with ES256 (raw 64-byte IEEE P1363 format required by RFC 7518)
  const signer = crypto.createSign('SHA256');
  signer.update(unsignedToken);
  const signatureB64 = signer.sign({
    key: vapidPrivateKey,
    dsaEncoding: 'ieee-p1363'
  }).toString('base64url');

  const jwt = `${unsignedToken}.${signatureB64}`;

  let pubKeyB64 = vapidPublicKey;
  if (typeof vapidPublicKey === 'string' && (vapidPublicKey.startsWith('-----BEGIN') || vapidPublicKey.includes('\n'))) {
    // If PEM format, convert to base64url uncompressed P-256 public key
    try {
      const keyObj = crypto.createPublicKey(vapidPublicKey);
      const jwk = keyObj.export({ format: 'jwk' });
      pubKeyB64 = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
    } catch {
      pubKeyB64 = vapidPublicKey.trim();
    }
  }

  return `vapid t=${jwt}, k=${pubKeyB64}`;
}

/**
 * Unconfigured Push Provider Adapter (Fail-closed default)
 * Used when no real VAPID provider signing credentials exist in the environment.
 * Strictly prevents mock delivery, fake receipt IDs, or silent push loss.
 */
export class UnconfiguredPushAdapter {
  constructor(reason = 'PUSH_PROVIDER_UNCONFIGURED') {
    this.reason = reason;
  }

  async send() {
    return {
      success: false,
      retryable: false,
      error: this.reason
    };
  }
}

/**
 * Mock Push Provider Adapter (for test suites and isolated testing ONLY)
 * Strictly prohibited from running against real database queues in polling servers.
 */
export class MockPushAdapter {
  constructor(options = {}) {
    this.sentPushes = [];
    this.nextOutcome = options.nextOutcome || null;
    this.recordedIdempotencyKeys = new Set();
  }

  setOutcome(outcome) {
    this.nextOutcome = outcome;
  }

  async send(subscription, payload, options = {}) {
    if (this.nextOutcome) {
      const outcome = { ...this.nextOutcome };
      this.nextOutcome = null; // one-shot
      return outcome;
    }

    const messageId = `mock_push_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      messageId,
      endpoint: subscription.endpoint,
      payload,
      idempotencyKey: options.idempotencyKey,
      sentAt: new Date().toISOString()
    };

    this.sentPushes.push(record);
    if (options.idempotencyKey) {
      this.recordedIdempotencyKeys.add(options.idempotencyKey);
    }

    return { success: true, messageId, status: 201 };
  }
}

/**
 * Production Web Push Provider Adapter
 * Delivers encrypted notifications directly to browser Push Services (FCM, APNs, Mozilla).
 */
export class WebPushAdapter {
  constructor(config = {}) {
    this.vapidPublicKey = config.vapidPublicKey || process.env.VAPID_PUBLIC_KEY;
    this.vapidPrivateKey = config.vapidPrivateKey || process.env.VAPID_PRIVATE_KEY;
    this.vapidSubject = config.vapidSubject || process.env.VAPID_SUBJECT || 'mailto:security@pooldocai.com';
  }

  async send(subscription, payload, options = {}) {
    if (!this.vapidPrivateKey || !this.vapidPublicKey) {
      return { success: false, retryable: false, error: 'VAPID_KEYS_NOT_CONFIGURED' };
    }

    if (!subscription?.endpoint) {
      return { success: false, retryable: false, error: 'MISSING_PUSH_ENDPOINT' };
    }

    try {
      const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
      const encrypted = encryptPushPayload(payloadString, subscription.p256dh, subscription.auth);
      const vapidAuth = createVapidAuthHeader(subscription.endpoint, this.vapidPublicKey, this.vapidPrivateKey, this.vapidSubject);

      const targetUrl = new URL(subscription.endpoint);
      const client = targetUrl.protocol === 'https:' ? https : http;

      const headers = {
        'Authorization': vapidAuth,
        'TTL': String(options.ttl || 86400),
        'Urgency': options.urgency || 'normal',
        ...encrypted.headers
      };

      if (options.idempotencyKey) {
        headers['Topic'] = crypto.createHash('sha256').update(String(options.idempotencyKey)).digest('hex').slice(0, 32);
      }

      return await new Promise((resolve) => {
        const req = client.request(targetUrl, {
          method: 'POST',
          headers,
          timeout: 10000
        }, (res) => {
          let resBody = '';
          res.on('data', (chunk) => { resBody += chunk; });
          res.on('end', () => {
            const status = res.statusCode || 500;
            if (status >= 200 && status < 300) {
              resolve({ success: true, status, messageId: res.headers['location'] || `push_${Date.now()}` });
            } else if (status === 404 || status === 410) {
              // Endpoint is dead / unsubscribed -> trigger automatic revocation
              resolve({
                success: false,
                retryable: false,
                error: `SUBSCRIPTION_EXPIRED_${status}`,
                status,
                revokedEndpoint: subscription.endpoint
              });
            } else if (status === 429 || status >= 500) {
              resolve({ success: false, retryable: true, error: `PUSH_GATEWAY_TEMPORARY_${status}`, status });
            } else {
              resolve({ success: false, retryable: false, error: `PUSH_REJECTED_${status}`, status });
            }
          });
        });

        req.on('timeout', () => {
          req.destroy(new Error('Push request timed out'));
          resolve({ success: false, retryable: true, error: 'Push service request timed out' });
        });

        req.on('error', (err) => {
          resolve({ success: false, retryable: true, error: String(err?.message || 'Network error') });
        });

        req.write(encrypted.body);
        req.end();
      });
    } catch (err) {
      return { success: false, retryable: false, error: String(err?.message || 'Push encryption failed') };
    }
  }
}

/**
 * Processes a batch of pending Web Push items from notification_delivery_queue.
 */
export async function processPushBatch(db, adapter, options = {}) {
  if (!adapter || adapter instanceof UnconfiguredPushAdapter) {
    return {
      processed: 0,
      successes: 0,
      failures: 0,
      status: 'unconfigured',
      warning: 'Push provider unconfigured; queue polling paused to prevent fake deliveries.'
    };
  }

  const workerId = options.workerId || `worker_push_${process.pid}_${Math.random().toString(36).slice(2, 6)}`;
  const batchSize = Math.max(1, Math.min(Number(options.batchSize) || 10, 50));
  const leaseSeconds = Math.max(15, Math.min(Number(options.leaseSeconds) || 120, 600));

  const { data: items, error: claimError } = await db.rpc('pooldocai_claim_push_delivery_batch', {
    p_worker_id: workerId,
    p_batch_size: batchSize,
    p_lease_seconds: leaseSeconds
  });

  if (claimError) {
    console.error('Push queue claim failed', { code: claimError.code, message: claimError.message });
    return { processed: 0, successes: 0, failures: 0, error: claimError.message };
  }

  const batch = Array.isArray(items) ? items : (items ? [items] : []);
  if (!batch.length) {
    return { processed: 0, successes: 0, failures: 0 };
  }

  let successes = 0;
  let failures = 0;

  for (const item of batch) {
    const leaseToken = item.lease_token || workerId;
    const subscriptions = Array.isArray(item.subscriptions)
      ? item.subscriptions
      : (typeof item.subscriptions === 'string' ? JSON.parse(item.subscriptions || '[]') : []);

    const revokedEndpoints = [];
    let anyDelivered = false;
    let lastError = null;
    let anyRetryable = false;

    try {
      const payload = buildNotificationPushPayload(item, options);

      for (const sub of subscriptions) {
        const result = await adapter.send(sub, payload, {
          idempotencyKey: item.idempotency_key
        });

        if (result.success) {
          anyDelivered = true;
        } else {
          lastError = result.error || 'Delivery failed';
          if (result.retryable) anyRetryable = true;
          if (result.revokedEndpoint) {
            revokedEndpoints.push(result.revokedEndpoint);
          }
        }
      }

      // If at least one active subscription succeeded, mark queue item delivered
      // (or if all endpoints were revoked, mark non-retryable)
      const overallSuccess = anyDelivered || (subscriptions.length === 0);
      const isRetryable = !anyDelivered && anyRetryable && (subscriptions.length > revokedEndpoints.length);

      const { data: finished, error: finishError } = await db.rpc('pooldocai_finish_push_delivery', {
        p_queue_id: item.queue_id,
        p_lease_token: leaseToken,
        p_success: overallSuccess,
        p_provider_message_id: anyDelivered ? `push_${Date.now()}` : null,
        p_error: overallSuccess ? null : (lastError || 'all_device_deliveries_failed'),
        p_retryable: isRetryable,
        p_revoked_endpoints: revokedEndpoints
      });

      if (finishError) {
        console.error('Could not finalize push delivery', { queueId: item.queue_id, code: finishError.code });
        failures++;
      } else if (finished === false) {
        console.warn('Worker fenced out during push finalization', { queueId: item.queue_id, leaseToken });
        failures++;
      } else if (overallSuccess) {
        successes++;
      } else {
        failures++;
      }
    } catch (err) {
      console.error('Unexpected error processing push item', {
        queueId: item.queue_id,
        error: String(err?.message || 'unknown')
      });

      try {
        await db.rpc('pooldocai_finish_push_delivery', {
          p_queue_id: item.queue_id,
          p_lease_token: leaseToken,
          p_success: false,
          p_provider_message_id: null,
          p_error: String(err?.message || 'unexpected_push_worker_error').slice(0, 255),
          p_retryable: true,
          p_revoked_endpoints: revokedEndpoints
        });
      } catch { /* ignore secondary error */ }

      failures++;
    }
  }

  return { processed: batch.length, successes, failures };
}
