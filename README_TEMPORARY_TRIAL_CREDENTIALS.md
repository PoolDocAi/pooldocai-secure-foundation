# Temporary full-experience trial credentials

## Check migration history first
In Supabase SQL Editor for project `owfeebydlyacssqpnmkq`, run:

```sql
select version, name
from supabase_migrations.schema_migrations
order by version;
```

If that schema/table is unavailable in SQL Editor, use the dashboard's migration history or run `supabase migration list` from a linked Supabase CLI project. Never rerun a migration just because it is absent from one dashboard view. Compare versions 001–014 with the applied list, then apply only missing migrations in order.

## Apply migration 015
Run `supabase/migrations/202610210015_temporary_platform_trial_credentials.sql` once in the correct project. It creates an expiry registry and adds a restrictive RLS expiry gate to RLS-enabled public tables. It does not delete existing records.

## Use the platform admin panel
Sign in as the user already registered in `public.platform_admins`, open Admin Portal → Platform analytics → Temporary full-experience credentials, choose 30 minutes through 24 hours, and create credentials. The generated account receives a separate pilot company workspace. Copy the password immediately; it is not retrievable later. You can revoke active trials early from the same panel.

## Security notes
Only `platform_admins` can invoke creation/list/revocation actions; service credentials remain in the Edge Function. The database grant table is not readable by browser users. Expiry is enforced by a restrictive RLS policy and checked on authenticated Edge Function calls; revoked accounts are also banned and their membership/company suspended. Test with a non-platform-admin account and verify it receives HTTP 403. Configure a reasonable auth password policy and never share credentials in public chat.
