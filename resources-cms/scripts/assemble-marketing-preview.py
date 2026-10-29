#!/usr/bin/env python3
"""Assemble a private CMS delivery preview from the exact owner-approved ZIP.

No deployment, network call, production target, or publication is performed.
The ZIP remains private and MUST NOT be committed to the public repository.
"""
import argparse
import hashlib
import json
import os
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

EXPECTED_SHA256 = '022c53062ef305df8a78a600603f3d1209ca4376d7c3d6e76a81c0790ff71634'
EXPECTED_FILES = 79
EXPECTED_HOMEPAGE_SHA256 = '36268fd6dba19649c5cc255d2ae52ed4bf0de2e6bb9a33eb8426375bf9f10110'
MAX_SIZE = 12_000_000
OVERLAYS = (
    'api/cms-public.mjs',
    'src/production/public-delivery.mjs',
    'src/production/public-target.mjs',
    'scripts/footer-navigation.mjs',
    'scripts/prune-static-publications.mjs',
    'scripts/build-review.mjs',
    'scripts/build-cms-preview.mjs',
    'legal-footer.css', 'privacy.html', 'terms.html',
    'tests/cms-public-delivery.test.mjs',
    'tests/public-target.test.mjs',
    'tests/prune-static-publications.test.mjs',
    'vercel.cms-preview.json',
)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def safe_entries(archive):
    seen = set()
    total = 0
    for item in archive.infolist():
        p = PurePosixPath(item.filename)
        parts = p.parts
        if (not item.filename or item.filename.startswith('/') or '\\' in item.filename
                or ':' in item.filename or not parts or any(t in ('', '.', '..') for t in parts)
                or item.filename.endswith('/') or item.is_dir()):
            raise ValueError('Unexpected archive entry path')
        if (item.external_attr >> 16) & 0o170000 == stat.S_IFLNK:
            raise ValueError('Symlink entry is forbidden')
        if p.as_posix().lower() in seen:
            raise ValueError('Duplicate/ambiguous source filename')
        seen.add(p.as_posix().lower())
        total += item.file_size
        if item.file_size > MAX_SIZE or total > MAX_SIZE:
            raise ValueError('Oversized archive entry')
        if item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise ValueError('Unsupported archive compression')
        yield item


def assemble(archive_path, overlay_root, dest, verify_only=False):
    archive_path = Path(archive_path)
    overlay_root = Path(overlay_root)
    dest = Path(dest)
    actual_sha = sha(archive_path.read_bytes())
    if actual_sha != EXPECTED_SHA256:
        raise ValueError('Owner-approved source ZIP checksum mismatch')
    if dest.exists() and not verify_only:
        raise FileExistsError('Refusing to overwrite existing staged source')
    if not verify_only:
        for rel in OVERLAYS:
            p = overlay_root / rel
            if not p.is_file() or p.is_symlink():
                raise FileNotFoundError(f'Missing trusted CMS overlay file: {rel}')
    with zipfile.ZipFile(archive_path) as z:
        entries = list(safe_entries(z))
        if len(entries) != EXPECTED_FILES:
            raise ValueError('Source member count does not match approved archive')
        checksums = {i.filename: sha(z.read(i)) for i in entries}
        if checksums.get('index.html') != EXPECTED_HOMEPAGE_SHA256:
            raise ValueError('Original homepage fingerprint mismatch')
        if not verify_only:
            dest.mkdir(parents=True, exist_ok=False)
            for item in entries:
                target = dest / item.filename
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(z.read(item))
    if verify_only:
        return {'verified': True, 'files': len(entries), 'sha256': actual_sha}
    # Keep the owner's original review route config separate for provenance.
    (dest / 'vercel.original-protected-review.json').write_bytes((dest / 'vercel.json').read_bytes())
    original = checksums['index.html']
    for rel in OVERLAYS:
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(overlay_root / rel, target)
    # Preview-only dynamic rewrite config; production config is never selected here.
    shutil.copyfile(dest / 'vercel.cms-preview.json', dest / 'vercel.json')
    if sha((dest / 'index.html').read_bytes()) != original:
        raise RuntimeError('Assembly changed the owner-approved homepage')
    # Include a private provenance record in staged package, no secrets or bytes.
    manifest = {'kind':'pooldocai-private-cms-preview-source-v1',
        'originalArchiveSha256':actual_sha,'sourceFileCount':len(entries),
        'originalHomepageSha256':original,'previewOnly':True,
        'cmsPublishedDeliveryRequired':True,'geminiGenerationEnabled':False,
        'productionRoutingChanged':False,
        'overlays':{p:sha((dest / p).read_bytes()) for p in OVERLAYS}}
    (dest / 'CMS-STAGING-SOURCE-MANIFEST.json').write_text(json.dumps(manifest,indent=2)+'\n')
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True)
    parser.add_argument('--overlay-root', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    result = assemble(args.archive,args.overlay_root,args.output,args.verify_only)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
