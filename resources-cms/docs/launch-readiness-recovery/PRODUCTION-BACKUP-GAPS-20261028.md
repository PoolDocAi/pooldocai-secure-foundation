# Production recovery: completed work and exact remaining inputs

No Production export, migration, mutation, restore or Staging backup rerun occurred.

## Existing evidence

`docs/owner-publishing/FAST-LAUNCH-CUTOVER-GATES.md` records the owner-reported
October 27 Production custom PostgreSQL archive: 738,886 bytes, SHA-256
`6E715820DB8C13C9350074A86E5651D623A4A97C0EABD1870E8393F2332F35C7`.
Prior checksum, required metadata and decompression checks passed. Those checks
are not a restore, encryption or complete platform backup. The actual dump was
not found at the inspected workspace/private-backups or Downloads locations;
no unrelated private folder was searched. No new dump validation is claimed.

Read-only Production aggregate SQL on October 28 returned **one private bucket,
zero Storage object metadata rows and zero metadata bytes**. No object paths,
customer data, credentials or file bytes were retrieved. This establishes the
current registered-object inventory only; it cannot prove the October 27 state,
physical orphan absence, deleted-object recovery or successful Storage service
recovery. The query executed in `BEGIN READ ONLY` and ended with `ROLLBACK`.

The local revised Staging scripts and offline verifier documentation were read.
Downloads contains the encrypted Staging archive and VeraCrypt script revisions;
the mounted `X:\Output` is inaccessible in this session. The coordinator records
the prior owner's successful full and CMS offline restore and matching encrypted
cloud-copy checksum. This is preserved as prior evidence, not independently
rerun here. Do not repeat Staging backup to compensate for evidence access.

## Concrete reusable implementation

`scripts/launch-readiness-recovery/storage-recovery.mjs` provides a memory-only
byte-inventory integrity helper: captures every supplied object across buckets, with no filtering of
archived, unreferenced or zero-byte objects; requires stable object version and
size metadata; compares complete before/after inventories; hashes bytes; and
verifies every decoded byte and hash after decryption. Its returned JSON is private
plaintext and must be handled only within the already approved encrypted workflow.
There is no new encryption framework or Production export CLI.

Run the synthetic tests from `resources-cms`:

```powershell
node --test tests/launch-readiness-recovery/storage-recovery.test.mjs
```

Four passing tests cover exact archived/orphan/zero-byte recovery, changed inventories,
duplicate and missing identities, short reads, configured size limits, and byte
tampering. Thin test glue invokes the installed 7-Zip AES-256/header-encrypted flow
with public synthetic data/password, tests the archive, restores the bytes, checks
hashes, and rejects a wrong password and truncated archive. No tests were skipped.
No remote services or real records are used. This is synthetic Storage
byte recovery proof, **not** a Production DB or Supabase-service restore.

The helper intentionally has no network adapter, credential acquisition, encryption
implementation, disk export CLI or remote restore operation. Do not wire it to Production until the
owner approves the capture mechanism, encryption custody and restricted location.
The 64 MiB default bounds raw byte payload, not total process memory (base64/JSON
require additional memory). JavaScript copies, strings and host memory/paging
cannot be reliably erased; a trusted secure offline environment remains required.

## Minimal owner/operator handoff

1. Provide **only the existing Production dump's restricted local path** and the
   matching prior Staging verification report path/digest, without sending files,
   passwords or keys to chat. Keep the original independently recorded dump hash.
2. Name the owner-managed encryption key custodian and approved private encrypted
   workspace plus off-device destination. Reuse the reviewed Staging protections
   and pinned compatible offline recovery image; do not simply retarget its
   hardcoded source/cluster checks. Review a separate Production wrapper before
   any full sensitive export. No Supabase upgrade is needed for this preparation.
3. For a complete Storage capture, the approved privileged operator must supply
   fully paginated per-bucket object inventory from the actual Storage service,
   including unreferenced objects and retained versions required by the recovery
   policy, and reconcile it against DB metadata plus CMS historical references.
   A metadata query alone cannot list physical orphans. Define a write-quiescent
   boundary; conditional reads must bind each byte read to its inventoried version.
   The adapter must fail on incomplete pages, permission failures or missing bytes.
   Empty registered metadata must not be substituted for a byte inventory.
4. Reuse the reviewed v3 script's interactive archive passphrase flow and encrypted
   private workspace. Keep real passphrases out of arguments and source (the test
   harness's public password is synthetic only). Independently retrieve the off-device copy,
   compare SHA-256, decrypt and verify every object. Review bucket policies, Auth
   settings, roles, extensions, Edge Functions and external integrations separately.
5. Rehearse the DB dump in an independently empty, quarantined compatible recovery
   environment. Compare required row/content fingerprints and actual application
   permission behavior; record excluded ownership/ACL transformations. No Production
   write, occupied-Staging restore or publication is authorized by this handoff.

Recovery remains open until the actual approved Production archive and independently
retrieved encrypted copy are restored and checked. Synthetic passes do not close it.
