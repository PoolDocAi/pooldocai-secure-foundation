# PoolDocAI Source Manual Library

> **SOURCE MATERIAL — NOT APPLICATION CODE — NOT A DATABASE SEED**
>
> **ARCHIVE STATUS: INCOMPLETE — ORIGINAL FILE BYTES NOT YET TRANSFERRED**

This **separate source-document branch** exists to archive manufacturer manuals and treatment/support references furnished by the PoolDocAI project owner. It is **not** an application feature, and nothing here should be consumed by runtime ingestion, extraction, vector embedding, indexing, retrieval, or automatic database seeding.

## Authorization and permitted scope

The repository/document owner expressly authorized publication of **56 original source documents** (50 PDFs in the source folder root plus 6 treatment/support files) in this public GitHub repository, on condition that original sources are properly cited. That owner authorization supersedes the earlier instruction against publication *for these 56 designated files only*. It does not establish permission to publish additional content or imply ownership of manufacturer trademarks. Rights are represented by the owner; this repository has not independently verified licensing terms for each document.

**No source PDF, DOC, DOCX, PNG, or JPG has yet been committed to this branch.** The original cloud-browser download archive from the prior task is not accessible in this current execution environment. Do not represent this placeholder as a completed import.

## Archive structure (planned)

```
source-manual-library/
  README.md
  MANIFEST.csv                       # created ONLY after byte-verified import
  MANIFEST_PENDING.csv               # provisional filename inventory (no checksums)
  manufacturers/
    hayward/
    jandy/
    pentair/
    polaris/
    other/
  treatment-guides/
```

A document filename will remain **byte-for-byte unchanged as a filename and source file**. Catalog metadata may correctly identify manufacturer or product when a filename is inaccurate.

## Acceptance checks for completing the import

1. Obtain the owner-approved, original downloaded ZIP/archive from the earlier cloud-browser session. Do not execute anything inside it.
2. Inspect the archive format and entries first; reject archive paths with traversal, absolute paths, links, or unexpected executables. Extract to a temporary workspace.
3. Enumerate all candidate source files from root, manufacturer folders, and `Treatment Guides`. Compute SHA-256 on raw bytes and identify **exact** duplicates by checksum.
4. Verify the owner's stated count of **56 unique** source documents (50 root PDFs and 6 support assets). The prior inventory identified **nine manufacturer-folder duplicate copies**; do not assume identical bytes without cryptographic checks.
5. Confirm each file is below the ordinary GitHub per-file size limit; choose normal Git only if this is satisfied. Do not activate paid hosting or Git LFS without explicit approval.
6. Store one canonical original for each unique SHA-256 under a manufacturer or treatment folder; maintain a complete manifest with the **original filename, manufacturer/publisher, model/product, document type, revision/date if actually verified, file size in bytes, SHA-256 and saved path**. Never fabricate checksum, date or page metadata. Use `Not identified` for unknown document versions.
7. Validate repository blobs after pushing: **56 original archive files**, manifest with **56 unique SHA-256 values**, sizes and checksums matching source bytes, and any duplicates excluded and logged. Do not merge into application branches automatically.
8. Post the final commit URL, folder URL, exact unique/duplicate counts, full SHA-256 verification results and restrictions to [GitHub Issue #15](https://github.com/PoolDocAi/pooldocai-secure-foundation/issues/15).

## Known source metadata exceptions

- `Petair Easytouch.pdf`: catalog manufacturer as **Pentair**; preserve original misspelled filename.
- `Pentair Superflo VS.pdf`: source audit says the contents are **SuperFlo High Performance Pump — Installation and User's Guide, P/N 350096, Rev. P, 2023-12-19**, not a SuperFlo VS/VST drive manual. Preserve filename and use OEM-confirmed product metadata.
- An `SP-523892` component in `intellichlor-ltplus-manual-sp-523892.pdf` is an identifier from the filename, not independently verified as a revision.

## How to cite an archived document

Cite **manufacturer or publisher; exact document title; model/product; document number; revision and publication date (if identified); printed page (and physical PDF page, if different); archive path or official manufacturer source URL**.

Example format only (not a quotation):

`Pentair, SuperFlo High Performance Pump — Installation and User's Guide, P/N 350096, Rev. P, 2023-12-19, p. [verified page], source-manual-library/manufacturers/pentair/Pentair Superflo VS.pdf.`

Do not claim rights for general model training or reproduce lengthy copyrighted text solely because it was divided into smaller chunks. This archive preserves original sources and citations; use beyond the owner's authorization remains subject to applicable terms.

## Separation guarantee

This branch must remain isolated from application code. **No database or Supabase project, production deployment, ingestion/extraction/indexing pipeline, or knowledge store was modified by preparing this archive branch.**
