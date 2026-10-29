"""Synthetic, non-production regression tests for private preview assembly."""
import hashlib
import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'scripts' / 'assemble-marketing-preview.py'
SPEC = importlib.util.spec_from_file_location('private_assembler', MODULE)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class MarketingAssemblerTests(unittest.TestCase):
    def test_extraction_preserves_owner_homepage_and_selects_preview_only(self):
        with tempfile.TemporaryDirectory() as t:
            base = Path(t)
            original = b'approved homepage cannot change'
            a = base / 'source.zip'
            with zipfile.ZipFile(a, 'w') as z:
                z.writestr('index.html', original)
                z.writestr('vercel.json', b'{"preview_review_only":true}')
                z.writestr('assets/original.webp', b'original bytes')
            overlay = base / 'overlay'
            overlay.mkdir()
            (overlay / 'vercel.cms-preview.json').write_text('{"preview_dynamic_cms":true}')
            (overlay / 'privacy.html').write_text('Private synthetic footer test')
            o = base / 'staged'
            with patch.object(mod,'EXPECTED_SHA256',mod.sha(a.read_bytes())),\
                 patch.object(mod,'EXPECTED_FILES',3),\
                 patch.object(mod,'EXPECTED_HOMEPAGE_SHA256',mod.sha(original)),\
                 patch.object(mod,'OVERLAYS',('vercel.cms-preview.json','privacy.html')):
                result = mod.assemble(a,overlay,o)
                self.assertTrue(result['previewOnly'])
                self.assertEqual((o / 'index.html').read_bytes(),original)
                self.assertEqual((o / 'assets/original.webp').read_bytes(),b'original bytes')
                self.assertIn(b'preview_dynamic_cms',(o/'vercel.json').read_bytes())
                self.assertIn(b'preview_review_only',(o/'vercel.original-protected-review.json').read_bytes())
                self.assertRaises(FileExistsError,mod.assemble,a,overlay,o)

    def test_rejects_zip_slip_duplicate_case_paths_and_symlinks(self):
        with tempfile.TemporaryDirectory() as t:
            tmp=Path(t)
            cases=[('../escape.txt',),('folder\\escape.txt',),('foo.txt','FOO.txt')]
            for i,paths in enumerate(cases):
                file=tmp/f'bad{i}.zip'
                with zipfile.ZipFile(file,'w') as z:
                    for path in paths:z.writestr(path,'bad')
                with zipfile.ZipFile(file) as z:
                    self.assertRaises(ValueError,lambda:list(mod.safe_entries(z)))
            symlink=tmp/'symlink.zip'
            with zipfile.ZipFile(symlink,'w') as z:
                link=zipfile.ZipInfo('symlink.txt');link.create_system=3;link.external_attr=(0o120777<<16)
                z.writestr(link,'/etc/passwd')
            with zipfile.ZipFile(symlink) as z:
                self.assertRaises(ValueError,lambda:list(mod.safe_entries(z)))

    def test_rejects_unrecognized_file_checksum_without_creating_output(self):
        with tempfile.TemporaryDirectory() as t:
            base=Path(t);p=base/'unsafe.zip'
            with zipfile.ZipFile(p,'w') as z:z.writestr('index.html','unsupported source')
            output=base/'would-be-preview'
            with self.assertRaisesRegex(ValueError,'checksum mismatch'):
                mod.assemble(p,base,output)
            self.assertFalse(output.exists())


if __name__=='__main__':unittest.main()
