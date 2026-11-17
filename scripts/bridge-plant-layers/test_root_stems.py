import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from windlayer.parts import chunk_files, split_variant
from windlayer.root_stems import protect_root_contacts, rooted_stalks


class RootContactsTest(unittest.TestCase):
    @staticmethod
    def mesh():
        # Two strips meet the soil: a narrow stem and the point of a broad leaf.
        verts, faces = [], []
        for x, widths in ((0., [.05] * 5), (3., [.005, .32, .7, .65, .2])):
            offset = len(verts)
            for j, half_width in enumerate(widths):
                verts.extend(([x-half_width, 0., j*2.], [x+half_width, 0., j*2.]))
                if j:
                    a = offset + 2*(j-1)
                    faces.extend(([a, a+1, a+2], [a+1, a+3, a+2]))
        return np.array(verts), np.array(faces), np.repeat([0, 1], 10)

    def test_rooted_shaft_is_pinned_without_pinning_nearby_leaf_tip(self):
        verts, faces, labels = self.mesh()
        self.assertEqual(rooted_stalks(verts, faces, labels), {0})
        variant = dict(primaryAxes=[dict(base=[0., 0., 0.], tip=[0., 0., 1.], rooted=True)],
                       bindings=[dict(island=i, layers=['Branch1'], primary=0, secondary=-1,
                                      primaryAttachment=1., terminal=False) for i in range(2)])
        self.assertEqual(protect_root_contacts(variant, verts, faces, labels), 1)
        guard = variant['bindings'][0]['rootContact']
        self.assertNotIn('rootContact', variant['bindings'][1])
        center = verts.min(axis=0) + np.ptp(verts, axis=0)*guard['center']
        self.assertLess(max(np.linalg.norm(verts[i]-center) for i in (0, 1)), guard['innerHeight']*8.)
        stem_tip = verts[9]
        self.assertLess(guard['outerHeight']*8., np.linalg.norm(stem_tip-center))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            split_variant(variant, root, 'Var1', limit=1)
            chunks = [json.loads(p.read_bytes()) for p in chunk_files(root, variant)]
        self.assertEqual(chunks[0][0]['rootContact'], guard)
        self.assertNotIn('rootContact', chunks[1][0])

    def test_static_and_already_grounded_bindings_are_unchanged(self):
        args = self.mesh()
        self.assertEqual(protect_root_contacts({'primaryAxes': []}, *args), 0)
        v = dict(primaryAxes=[dict(base=[0., 0., 0.], tip=[0., 0., 1.], rooted=True)],
                 bindings=[dict(layers=['Branch1'], primary=0, secondary=-1,
                                primaryAttachment=-1., terminal=False) for _ in range(2)])
        self.assertEqual(protect_root_contacts(v, *args), 0)

    def test_valid_inherited_root_fade_is_preserved(self):
        args = self.mesh()
        variant = dict(primaryAxes=[dict(base=[0., 0., 0.], tip=[0., 0., 1.], rooted=True)],
                       bindings=[dict(island=i, layers=['Branch1'], primary=0, secondary=-1,
                                      primaryAttachment=1., terminal=False) for i in range(2)])
        self.assertEqual(protect_root_contacts(variant, *args), 1)
        # An inherited surface can have a wider fade than its tiny fragment.
        guard = variant['bindings'][0]['rootContact']
        guard['innerHeight'] *= 2
        guard['outerHeight'] *= 2
        original = json.loads(json.dumps(guard))
        self.assertEqual(protect_root_contacts(variant, *args), 0)
        self.assertEqual(variant['bindings'][0]['rootContact'], original)
