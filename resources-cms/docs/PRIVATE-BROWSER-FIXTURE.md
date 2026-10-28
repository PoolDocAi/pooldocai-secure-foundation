# Private broad-browser input

`tests/browser.mjs` requires the approved original `examples/existing-resources.json`.
It is absent from this checkout and every other local workspace copy/archive inspected
on October 28, 2026. Do not reconstruct it from owner articles or substitute synthetic
content and label that as completion of the original harness.

Obtain the approved private package through its owner-controlled source process,
plus its independently recorded SHA-256. From `resources-cms`, run:

```
node scripts/install-private-browser-fixture.mjs <approved-private-json> <owner-supplied-sha256>
npm run test:browser
```

The installer preserves exact bytes, rejects mismatched hashes and malformed/duplicate
slugs, refuses overwrite, and does not print content. The destination is Git-ignored.
This verifies package integrity, not editorial approval or a secret scan; the owner
must identify the approved artifact. Do not stage private files with `git add -f`.
Never put passwords, cookies or tokens into the fixture.

The required destination filename is `existing-resources.json`; the original source
filename may differ. No approved SHA-256 value is pinned in source or available in
the inspected evidence. The installer accepts a 64-character hexadecimal digest
supplied separately; hashing an unverified file now does not establish provenance.
Have the custodian place the original JSON outside the checkout in an access-restricted
local folder (or transfer via an existing owner-approved encrypted channel), and
provide its previously recorded digest through an independent trusted channel.
Share only the local source path and digest for installation, never the content,
credentials, raw browser evidence or archive in GitHub/chat. On Windows, confirm
the private folder's access controls; the file mode alone does not establish NTFS privacy.
Malformed JSON errors are sanitized so parser diagnostics cannot echo source content.

The existing broad harness uses Chromium only. Firefox/WebKit runs require a separately
reviewed compatible harness; running this command does not establish that coverage.
It uses an isolated temporary local database; its local publishing checks do not
authorize or establish hosted publication. Hosted authorization and network acceptance
remain separate gates.
