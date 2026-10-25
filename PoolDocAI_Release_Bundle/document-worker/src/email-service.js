import https from 'node:https';

/**
 * Generates privacy-minimized email content for company notifications.
 * Strictly avoids leaking customer PII (names, phone numbers, street addresses,
 * full troubleshooting conversation logs) into outbound email headers, subjects,
 * or bodies sent across third-party email providers.
 */
export function buildNotificationEmail(item, options = {}) {
  const appBaseUrl = (options.appBaseUrl || process.env.APP_BASE_URL || 'https://app.pooldocai.com').replace(/\/+$/, '');
  const companyName = item.company_name || 'Your Company';
  const eventType = item.event_type || 'notification';
  const role = item.recipient_role || 'technician';
  const isCompanyAdmin = role === 'company_admin';
  const portalUrl = isCompanyAdmin ? `${appBaseUrl}/admin` : `${appBaseUrl}/technician`;

  let subject = `[PoolDocAI] Notification — ${companyName}`;
  let headline = `New Notification for ${companyName}`;
  let summary = 'A new notification requires your attention.';

  if (eventType === 'service_request_created') {
    subject = `[PoolDocAI] New Customer Service Request — ${companyName}`;
    headline = `New Customer Service Request`;
    const priority = item.event_data?.priority || 'normal';
    const sourceType = item.event_data?.sourceType || 'customer_widget';
    summary = `A new service request (${priority} priority) has been received via the ${sourceType}.`;
  } else if (eventType === 'service_request_assigned') {
    subject = `[PoolDocAI] Service Request Assigned — ${companyName}`;
    headline = `Service Request Assignment`;
    summary = `You have been assigned to a service request.`;
  } else if (eventType === 'member_invited') {
    subject = `[PoolDocAI] Team Member Workspace Invitation — ${companyName}`;
    headline = `Workspace Invitation`;
    summary = `A new team member seat has been invited to your company workspace.`;
  }

  // Safe plaintext body without customer PII
  const text = [
    `Hello,`,
    ``,
    headline,
    `--------------------------------------------------`,
    summary,
    `Company: ${companyName}`,
    ``,
    `For customer privacy and security, detailed request data, contact info,`,
    `and equipment diagnostics are available exclusively within your authenticated portal.`,
    ``,
    `Sign in to view details:`,
    `${portalUrl}`,
    ``,
    `--`,
    `PoolDocAI Notification System`,
    `To adjust your email preferences, visit: ${portalUrl}#settings`
  ].join('\n');

  // HTML version
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #1e293b; background: #f8fafc; margin: 0; padding: 24px; }
    .card { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    .header { border-bottom: 2px solid #0284c7; padding-bottom: 16px; margin-bottom: 24px; }
    .title { color: #0369a1; margin: 0 0 8px 0; font-size: 20px; font-weight: 700; }
    .company { color: #64748b; font-size: 14px; margin: 0; }
    .content { margin-bottom: 24px; font-size: 15px; }
    .privacy-notice { background: #f0f9ff; border-left: 4px solid #0284c7; padding: 12px 16px; font-size: 13px; color: #0369a1; margin: 20px 0; border-radius: 0 4px 4px 0; }
    .button { display: inline-block; background: #0284c7; color: #ffffff !important; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; font-size: 14px; margin-top: 8px; }
    .footer { border-top: 1px solid #e2e8f0; padding-top: 16px; margin-top: 32px; font-size: 12px; color: #94a3b8; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1 class="title">${escapeHtml(headline)}</h1>
      <p class="company">${escapeHtml(companyName)}</p>
    </div>
    <div class="content">
      <p>Hello,</p>
      <p>${escapeHtml(summary)}</p>
      <div class="privacy-notice">
        <strong>Privacy Protected:</strong> Customer contact information, addresses, and diagnostic logs are protected and only accessible after authenticated sign-in.
      </div>
      <p>
        <a href="${escapeHtml(portalUrl)}" class="button" target="_blank" rel="noopener noreferrer">Sign In to Review</a>
      </p>
    </div>
    <div class="footer">
      <p>PoolDocAI Automated Notification System &bull; <a href="${escapeHtml(portalUrl)}#settings" style="color: #64748b;">Manage Notification Preferences</a></p>
    </div>
  </div>
</body>
</html>`;

  return { subject, text, html };
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Resend Email Provider Adapter
 */
export class ResendEmailAdapter {
  constructor(apiKey, defaultFrom = 'PoolDocAI <notifications@pooldocai.com>') {
    this.apiKey = apiKey;
    this.defaultFrom = defaultFrom;
  }

  async send({ to, from, subject, text, html, idempotencyKey }) {
    if (!this.apiKey) {
      return { success: false, retryable: false, error: 'RESEND_API_KEY_NOT_CONFIGURED' };
    }

    const payload = JSON.stringify({
      from: from || this.defaultFrom,
      to: Array.isArray(to) ? to : [to],
      subject,
      text,
      html
    });

    return new Promise((resolve) => {
      const options = {
        hostname: 'api.resend.com',
        port: 443,
        path: '/emails',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey) } : {})
        },
        timeout: 10000
      };

      const req = https.request(options, (res) => {
        let resBody = '';
        res.on('data', (chunk) => { resBody += chunk; });
        res.on('end', () => {
          const status = res.statusCode || 500;
          let parsed = {};
          try { parsed = JSON.parse(resBody); } catch { /* ignore */ }

          if (status >= 200 && status < 300) {
            resolve({ success: true, messageId: parsed.id || null, status });
          } else {
            const retryable = status === 429 || status >= 500;
            const errorMsg = parsed.message || `Resend HTTP ${status}`;
            resolve({ success: false, retryable, error: errorMsg, status });
          }
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error('Connection timed out'));
        resolve({ success: false, retryable: true, error: 'Connection timed out' });
      });

      req.on('error', (err) => {
        resolve({ success: false, retryable: true, error: String(err?.message || 'Network error') });
      });

      req.write(payload);
      req.end();
    });
  }
}

/**
 * Unconfigured Email Provider Adapter (Fail-closed default)
 * Used when no real provider API credentials exist in the environment.
 * Strictly prevents mock delivery, fake receipt IDs, or silent message loss.
 */
export class UnconfiguredEmailAdapter {
  constructor(reason = 'EMAIL_PROVIDER_UNCONFIGURED') {
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
 * Mock Email Provider Adapter (for test suites and isolated testing ONLY)
 * Strictly prohibited from running against real database queues in polling servers.
 */
export class MockEmailAdapter {
  constructor(options = {}) {
    this.sentEmails = [];
    this.nextOutcome = options.nextOutcome || null; // e.g. { success: false, retryable: true, error: '429 rate limit' }
    this.recordedIdempotencyKeys = new Set();
  }

  setOutcome(outcome) {
    this.nextOutcome = outcome;
  }

  async send({ to, from, subject, text, html, idempotencyKey }) {
    if (this.nextOutcome) {
      const outcome = { ...this.nextOutcome };
      this.nextOutcome = null; // one-shot
      return outcome;
    }

    const messageId = `mock_msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      messageId,
      to,
      from: from || 'notifications@pooldocai.com',
      subject,
      text,
      html,
      idempotencyKey,
      sentAt: new Date().toISOString()
    };

    this.sentEmails.push(record);
    if (idempotencyKey) {
      this.recordedIdempotencyKeys.add(idempotencyKey);
    }

    return { success: true, messageId, status: 200 };
  }
}

/**
 * Processes a batch of pending emails from notification_delivery_queue.
 */
export async function processEmailBatch(db, adapter, options = {}) {
  if (!adapter || adapter instanceof UnconfiguredEmailAdapter) {
    return {
      processed: 0,
      successes: 0,
      failures: 0,
      status: 'unconfigured',
      warning: 'Email provider unconfigured; queue polling paused to prevent fake deliveries.'
    };
  }

  const workerId = options.workerId || `worker_${process.pid}_${Math.random().toString(36).slice(2, 6)}`;
  const batchSize = Math.max(1, Math.min(Number(options.batchSize) || 10, 50));
  const leaseSeconds = Math.max(15, Math.min(Number(options.leaseSeconds) || 120, 600));

  const { data: items, error: claimError } = await db.rpc('pooldocai_claim_email_delivery_batch', {
    p_worker_id: workerId,
    p_batch_size: batchSize,
    p_lease_seconds: leaseSeconds
  });

  if (claimError) {
    console.error('Email queue claim failed', { code: claimError.code, message: claimError.message });
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
    try {
      const { subject, text, html } = buildNotificationEmail(item, options);
      const deliveryResult = await adapter.send({
        to: item.recipient_email,
        from: options.fromAddress || process.env.EMAIL_FROM_ADDRESS || 'PoolDocAI <notifications@pooldocai.com>',
        subject,
        text,
        html,
        idempotencyKey: item.idempotency_key
      });

      const { data: finished, error: finishError } = await db.rpc('pooldocai_finish_email_delivery', {
        p_queue_id: item.queue_id,
        p_lease_token: leaseToken,
        p_success: Boolean(deliveryResult.success),
        p_provider_message_id: deliveryResult.messageId || null,
        p_error: deliveryResult.error || null,
        p_retryable: Boolean(deliveryResult.retryable)
      });

      if (finishError) {
        console.error('Could not finalize email delivery', { queueId: item.queue_id, code: finishError.code });
        failures++;
      } else if (finished === false) {
        console.warn('Worker was fenced out during email finalization (lease expired or reclaimed)', { queueId: item.queue_id, leaseToken });
        failures++;
      } else if (deliveryResult.success) {
        successes++;
      } else {
        failures++;
      }
    } catch (err) {
      console.error('Unexpected error processing email delivery item', {
        queueId: item.queue_id,
        error: String(err?.message || 'unknown')
      });

      try {
        await db.rpc('pooldocai_finish_email_delivery', {
          p_queue_id: item.queue_id,
          p_lease_token: leaseToken,
          p_success: false,
          p_provider_message_id: null,
          p_error: String(err?.message || 'unexpected_worker_error').slice(0, 255),
          p_retryable: true
        });
      } catch { /* ignore secondary error */ }

      failures++;
    }
  }

  return { processed: batch.length, successes, failures };
}
