import copy
import tempfile
import unittest
from pathlib import Path

from windlayer.lod_sources import source_records
from windlayer.validation import digest, validate_asset


class LodSourceTests(unittest.TestCase):
    def test_billboard_uses_declared_final_lod_and_does_not_relabel_partial_downloads(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder/'Var1').mkdir()
            for lod in (0, 1, 3):
                (folder/'Var1'/f'Var1_LOD{lod}.fbx').write_bytes(str(lod).encode())
            meta = dict(meta=[dict(key='useBillboardMaterial', value=True)], billboards=[{}],
                        models=[dict(uri='Var1/Var1_LOD3.fbx')])
            records = source_records(folder, 1, metadata=meta)
            self.assertEqual(records['LOD3']['layers'], ['Shared'])
            self.assertEqual(records['LOD3']['representation'], 'billboard')
            self.assertNotIn('layers', records['LOD1'])
            meta['models'].append(dict(uri='Var1/Var1_LOD5.fbx'))
            self.assertNotIn('layers', source_records(folder, 1, metadata=meta)['LOD3'])

    def test_sparse_lods_keep_source_identity_and_require_full_coverage(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp).resolve()
            var = folder / 'Var1'
            var.mkdir()
            for name in ('Var1_LOD0', 'Var1_LOD1', 'Var1_LOD3', 'Var2_LOD1'):
                (var / (name + '.fbx')).write_bytes(name.encode())
            records = source_records(folder, 1)
            self.assertEqual(set(records), {'LOD1', 'LOD3'})
            self.assertEqual(records['LOD3']['source'], 'Var1/Var1_LOD3.fbx')
            variant = dict(source='Var1/Var1_LOD0.fbx', sha256=digest(var/'Var1_LOD0.fbx'), lodSources=records,
                           frame=dict(units='cm', up='Z', bboxMinCm=[0]*3, bboxMaxCm=[1]*3, sizeCm=[1]*3),
                           primaryAxes=[], secondaryAxes=[], bindings=[dict(island=0, boundsCenter=[.5]*3,
                               influence=False, terminal=False, layers=[])], review=dict(status='static'),
                           counts=dict(islands=1, primaryAxes=0, secondaryAxes=0, branch1InfluencedIslands=0,
                                       branch2InfluencedIslands=0, foliageIslands=0, unattachedIslands=0))
            doc = dict(schemaVersion=1, provider='DeepSeek Harness', assetId='sample', form='',
                       lodWindMode='lod0-uv0-surface', variants=dict(Var1=variant))
            asset = dict(id='sample', form='')
            validate_asset(doc, asset, folder, folder)
            broken = copy.deepcopy(doc)
            del broken['variants']['Var1']['lodSources']['LOD3']
            with self.assertRaisesRegex(ValueError, 'coverage'):
                validate_asset(broken, asset, folder, folder)
            (var/'Var1_LOD3.fbx').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'fingerprint'):
                validate_asset(doc, asset, folder, folder)


if __name__ == '__main__':
    unittest.main()
