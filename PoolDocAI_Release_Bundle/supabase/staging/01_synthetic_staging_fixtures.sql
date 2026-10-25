-- ============================================================================
-- POOLDOCAI SYNTHETIC STAGING SEED FIXTURES
-- Target: Staging Project rzkgmvyyeclrpomrlyft ONLY
-- STRICT NOTICE: ZERO REAL CUSTOMER/BUSINESS PII. ALL DATA SYNTHETIC.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- 1. Synthetic Auth Users (auth.users)
-- Passwords set to a synthetic bcrypt hash for 'PoolDocStaging2026!'
-- ($2a$10$wT8K4cQZq7N9.fJ6dC5hkeFz7b4q0A3c6a4f2b1d0e9c8a7b6c5d)
INSERT INTO auth.users (
  id,
  instance_id,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  role,
  aud
) VALUES
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '00000000-0000-0000-0000-000000000000',
    'staging_admin_aquapure@pooldocai.test',
    '$2a$10$wT8K4cQZq7N9.fJ6dC5hkeFz7b4q0A3c6a4f2b1d0e9c8a7b6c5d',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"AquaPure Admin (Synthetic)"}'::jsonb,
    now(),
    now(),
    'authenticated',
    'authenticated'
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '00000000-0000-0000-0000-000000000000',
    'staging_tech_aquapure@pooldocai.test',
    '$2a$10$wT8K4cQZq7N9.fJ6dC5hkeFz7b4q0A3c6a4f2b1d0e9c8a7b6c5d',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"AquaPure Technician (Synthetic)"}'::jsonb,
    now(),
    now(),
    'authenticated',
    'authenticated'
  ),
  (
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '00000000-0000-0000-0000-000000000000',
    'staging_admin_bluewave@pooldocai.test',
    '$2a$10$wT8K4cQZq7N9.fJ6dC5hkeFz7b4q0A3c6a4f2b1d0e9c8a7b6c5d',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"BlueWave Admin (Synthetic)"}'::jsonb,
    now(),
    now(),
    'authenticated',
    'authenticated'
  ),
  (
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    '00000000-0000-0000-0000-000000000000',
    'staging_tech_bluewave@pooldocai.test',
    '$2a$10$wT8K4cQZq7N9.fJ6dC5hkeFz7b4q0A3c6a4f2b1d0e9c8a7b6c5d',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"BlueWave Technician (Synthetic)"}'::jsonb,
    now(),
    now(),
    'authenticated',
    'authenticated'
  )
ON CONFLICT (id) DO UPDATE SET
  email = EXCLUDED.email,
  updated_at = now();

-- 2. Synthetic Companies (public.companies)
INSERT INTO public.companies (
  id,
  name,
  status,
  plan_name,
  seat_limit,
  billing_email,
  billing_status,
  created_at,
  updated_at
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'AquaPure Commercial Pool Care',
    'active',
    'Founders Tier',
    5,
    'billing_aquapure@pooldocai.test',
    'active',
    now(),
    now()
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'BlueWave Residential Pool Services',
    'active',
    'Founders Tier',
    5,
    'billing_bluewave@pooldocai.test',
    'active',
    now(),
    now()
  )
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  status = EXCLUDED.status,
  updated_at = now();

-- 3. Synthetic Company Members (public.company_members)
INSERT INTO public.company_members (
  id,
  company_id,
  user_id,
  role,
  status,
  display_name,
  can_view_job_notes,
  can_edit_job_notes,
  created_at
) VALUES
  (
    '11111111-aaaa-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'company_admin',
    'active',
    'AquaPure Admin (Synthetic)',
    true,
    true,
    now()
  ),
  (
    '11111111-bbbb-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'technician',
    'active',
    'AquaPure Technician (Synthetic)',
    true,
    true,
    now()
  ),
  (
    '22222222-cccc-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222222',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'company_admin',
    'active',
    'BlueWave Admin (Synthetic)',
    true,
    true,
    now()
  ),
  (
    '22222222-dddd-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222222',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'technician',
    'active',
    'BlueWave Technician (Synthetic)',
    true,
    true,
    now()
  )
ON CONFLICT (company_id, user_id) DO UPDATE SET
  role = EXCLUDED.role,
  status = EXCLUDED.status,
  display_name = EXCLUDED.display_name;

-- 4. Synthetic Service Customers
INSERT INTO public.service_customers (
  id,
  company_id,
  customer_name,
  phone,
  email,
  service_address,
  notes,
  created_at,
  updated_at
) VALUES
  (
    '11111111-1000-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    'Grand Vista Resort (Synthetic)',
    '555-0191',
    'facilities@grandvista-fake.test',
    '100 Resort Way, Orlando, FL',
    'Gate code 4821; pool pump room located behind recreation pavilion',
    now(),
    now()
  ),
  (
    '22222222-1000-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222222',
    'Sarah Connor Residence (Synthetic)',
    '555-0192',
    'sarah.c@residential-fake.test',
    '404 Evergreen Terrace, Tampa, FL',
    'Backyard dog gate unlocked; salt system in shed',
    now(),
    now()
  )
ON CONFLICT (id) DO UPDATE SET
  customer_name = EXCLUDED.customer_name,
  updated_at = now();

-- 5. Synthetic Service Requests
INSERT INTO public.service_requests (
  id,
  company_id,
  created_by,
  status,
  priority,
  request_summary,
  assigned_technician,
  created_at,
  updated_at
) VALUES
  (
    '11111111-2000-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'assigned',
    'high',
    'Commercial pump shaft seal leak - Pentair IntelliFlo VS 3HP',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    now(),
    now()
  ),
  (
    '22222222-2000-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222222',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'open',
    'normal',
    'Salt chlorinator cell inspection - low output warning',
    NULL,
    now(),
    now()
  )
ON CONFLICT (id) DO UPDATE SET
  request_summary = EXCLUDED.request_summary,
  status = EXCLUDED.status,
  updated_at = now();

-- 6. Synthetic Push Subscriptions
INSERT INTO public.user_push_subscriptions (
  id,
  user_id,
  company_id,
  endpoint,
  p256dh,
  auth,
  user_agent,
  status,
  created_at,
  updated_at
) VALUES
  (
    '11111111-3000-4111-8111-111111111111',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '11111111-1111-4111-8111-111111111111',
    'https://fcm.googleapis.com/fcm/send/staging_aquapure_tech_pixel9',
    'BFN5kXQzM1x4L1p9rT3vY6w8zK2mN4pQ7sU0wX2zM1x4L1p9rT3vY6w8zK2mN4pQ7sU0wX2zM1x4L1p9',
    'dGVzdF9hdXRoX3NlY3JldDE',
    'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro PWA)',
    'active',
    now(),
    now()
  ),
  (
    '22222222-3000-4222-8222-222222222222',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    '22222222-2222-4222-8222-222222222222',
    'https://fcm.googleapis.com/fcm/send/staging_bluewave_tech_galaxy24',
    'BGm6lYR0N2y5M2q0sU4wZ7x9aL3nO5qR8tV1xY3aN2y5M2q0sU4wZ7x9aL3nO5qR8tV1xY3aN2y5M2q0',
    'dGVzdF9hdXRoX3NlY3JldDI',
    'Mozilla/5.0 (Linux; Android 14; Samsung Galaxy S24 PWA)',
    'active',
    now(),
    now()
  )
ON CONFLICT (user_id, endpoint) DO UPDATE SET
  status = EXCLUDED.status,
  updated_at = now();

COMMIT;
