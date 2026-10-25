# PoolDocAI — Source Manual Library

> **SOURCE MATERIAL — NOT APPLICATION CODE — NOT A DATABASE SEED**
>
> **Import status (2026-10-24): 56 originals verified in the supplied canonical ZIP; publication of the 56 document blobs to this GitHub branch remains to be verified.** Do not treat this source archive as an automatically active PoolDocAI knowledge base.

## Scope and owner authorization

The PoolDocAI repository/document owner explicitly authorized **public placement of the 56 identified source documents** in this repository on condition of appropriate citation and provenance. This later authorization supersedes the earlier no-publication restriction for **this collection only**. It does not apply to other sources and does not transfer manufacturer trademarks or copyrights.

The canonical source archive includes **50 PDFs** (manufacturer equipment manuals/guides) and **six treatment/support documents/images**, deduplicated from 65 discovered copies by SHA-256. Nine duplicate manufacturer-folder copies were omitted. The retained originals total **340,364,009 uncompressed bytes**, and no individual file exceeds GitHub's 100 MiB normal per-file limit.

The authoritative file inventory, original filenames, source metadata, file sizes, and checksums are in [MANIFEST.csv](MANIFEST.csv); the corresponding checksum list is in [SHA256SUMS.txt](SHA256SUMS.txt). The `documents/` directory is the expected destination for the **byte-for-byte original source files**; it must be validated against these manifests after publication.

## Citation and provenance requirements

When using a document as a factual reference, cite the **manufacturer/publisher**, **exact manual/document title**, **specific model/product**, **document/part number**, **revision/date** when discoverable, **printed page and/or PDF page number** (distinguish them when they differ), plus the original manufacturer URL where available or the repository path.

Example:

> Pentair, *SuperFlo High Performance Pump — Installation and User's Guide*, P/N 350096, Rev. P (2023-12-19), page [verify specific page], `source-manual-library/documents/Pentair Superflo VS.pdf`.

Document filenames are preserved exactly, even where the label is inaccurate:
- `Petair Easytouch.pdf` is cataloged under **Pentair EasyTouch**.
- `Pentair Superflo VS.pdf` contains the **SuperFlo High Performance Pump** guide, **not** the SuperFlo VS/VST drive manual; P/N **350096**, Rev. **P**, dated **2023-12-19**. Preserve filename.
- Unknown publication details should be marked **Not identified**, never guessed.

Public archive permission does **not** by itself establish rights for unrelated distribution, model training, extraction, embeddings, or database ingestion. Apply any source-specific conditions and obtain the appropriate further authorization for downstream uses.

## Strict separation from PoolDocAI production

This is a **source-only archive branch**. Nothing in this directory is application code, an executable deployment asset, a database seed, or an instruction to index the files. Do not import these sources to Supabase or any other database, run OCR/extraction/embedding/indexing/retrieval, or change production deployments as part of this operation.

Antigravity remains sole executor for application-code changes. Merge into `main` is **not** authorized by this archive task.

## Publication verification gate

Do **not** mark import complete until:
1. Every `MANIFEST.csv` `repository_path` resolves under `source-manual-library/` on this exact branch.
2. There are **exactly 56 original source blobs** with original filenames, plus this README, the manifest, and the checksum list.
3. Every remote original matches `SHA256SUMS.txt` by actual SHA-256 computed from the downloaded remote bytes, and file-size checks pass.
4. The full archive branch commit/URL is documented in [GitHub Issue #15](https://github.com/PoolDocAi/pooldocai-secure-foundation/issues/15).
