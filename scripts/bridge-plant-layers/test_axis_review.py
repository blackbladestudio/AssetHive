"""Regression cases from repeated scan strips and mixed inline/chunked hierarchies."""
import copy
import tempfile
import unittest
from pathlib import Path

import numpy as np

from windlayer.axis_review import repair_retraced_axes, retraced_axis, sync_terminal_owners
from windlayer.parts import split_variant
from windlayer.ripple_review import suppress_silent_tips
from windlayer.validation import digest, parse, validate_asset


class AxisReviewTests(unittest.TestCase):
    def test_contact_on_return_leg_retains_physical_attachment(self):
        # The second side of the scanned strip walks from the true tip back to the root.
        points = np.array([[0.,0.,0.], [0.,0.,5.], [0.,0.,10.], [.01,0.,5.], [.01,0.,0.]])
        blade = [[0.,0.,.5], [.1,0.,.7]]
        row = dict(primary=0, secondary=0, primaryAttachment=.75, secondaryAttachment=-1.,
                   terminal=True, blade=copy.deepcopy(blade))
        variant = dict(primaryAxes=[dict(id=0, units=[3,4],tip=[.01,0.,0.])],
                       secondaryAxes=[dict(id=0, primary=0, attachOnPrimary=.75)],
                       bindings=[row,dict(row,secondary=-1,primaryAttachment=-1.,terminal=False)])
        edits = repair_retraced_axes(variant, [(("primaryAxes",0),points)], np.zeros(3), np.array([1.,1.,10.]))
        self.assertEqual(edits, {("primaryAxes",0)})
        self.assertEqual(variant["primaryAxes"][0]["tip"], [0.,0.,1.])
        self.assertAlmostEqual(row["primaryAttachment"], .5, places=4)
        self.assertEqual(variant["secondaryAxes"][0]["attachOnPrimary"], row["primaryAttachment"])
        self.assertEqual((row["secondaryAttachment"],row["blade"],row["terminal"]),(-1., blade, True))
        self.assertEqual(variant["bindings"][1]["primaryAttachment"], -1.)
        sync_terminal_owners(variant)
        self.assertFalse(variant["primaryAxes"][0]["terminalBlade"])

    def test_base_fragment_inherits_a_moving_leaf_across_the_batch_boundary(self):
        blade = dict(terminal=True, primary=0, secondary=-1, primaryAttachment=.3,
                     secondaryAttachment=-1, blade=[[0.,0.,0.],[0.,0.,1.]], layers=["Shared","Branch1","Ripple"])
        rows = [dict(blade),dict(blade,primary=1)] + [dict(terminal=False)]*8190 + [dict(blade)]
        labels = np.arange(len(rows))
        points = np.zeros((len(rows),3)); points[-1,2] = 10.
        self.assertEqual(suppress_silent_tips(dict(bindings=rows),points,labels), 1)
        self.assertTrue(rows[0]["terminal"])
        self.assertTrue(rows[-1]["terminal"])
        self.assertEqual(rows[1]["layers"], ["Shared","Branch1"])

    def test_root_guard_removes_only_fully_silent_wind_units(self):
        blade = dict(terminal=True, primary=0, secondary=-1, primaryAttachment=.3,
                     secondaryAttachment=-1, blade=[[0.,0.,0.],[0.,0.,1.]],
                     layers=["Shared","Branch1","Ripple"])
        guard = dict(center=[0.,0.,0.], innerHeight=.6, outerHeight=.7)
        rows = [dict(blade, rootContact=guard), dict(blade, primary=1)]
        points = np.array([[0.,0.,0.],[.1,0.,1.],[0.,.1,2.],
                           [0.,0.,3.],[.1,0.,3.5],[0.,.1,4.]])
        labels = np.repeat([0, 1], 3)
        before = copy.deepcopy(rows[0])
        self.assertEqual(suppress_silent_tips(dict(bindings=rows), points, labels), 1)
        self.assertEqual(rows[0], dict(before, terminal=False, layers=["Shared","Branch1"]))
        self.assertTrue(rows[1]["terminal"])

    def test_guarded_fragment_keeps_ripple_when_its_shared_leaf_still_moves(self):
        blade = dict(terminal=True, primary=0, secondary=-1, primaryAttachment=.3,
                     secondaryAttachment=-1, blade=[[0.,0.,0.],[0.,0.,1.]],
                     layers=["Shared","Branch1","Ripple"])
        rows = [dict(blade, rootContact=dict(center=[0.,0.,0.], innerHeight=.6, outerHeight=.7)),
                dict(blade)]
        points = np.array([[0.,0.,0.],[.1,0.,1.],[0.,.1,2.],
                           [0.,0.,3.],[.1,0.,3.5],[0.,.1,4.]])
        self.assertEqual(suppress_silent_tips(dict(bindings=rows), points, np.repeat([0, 1], 3)), 0)
        self.assertTrue(all(row["terminal"] for row in rows))

    def test_genuine_loop_has_distinct_outward_and_return_surfaces(self):
        poly = np.array([[0.,0,0], [4.,0.,5.], [0.,0.,10.], [-4.,0.,5.], [0.,0.,0.]])
        self.assertIsNone(retraced_axis(poly))


class SidecarTests(unittest.TestCase):
    def test_payload_validation_precedes_use_of_chunk_flags(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp).resolve()
            (folder/"Var1").mkdir()
            src = folder/"Var1/Var01_LOD0.fbx"
            src.write_bytes(b"fixture")
            row = dict(island=0, boundsCenter=[.5]*3, terminal=False, layers=[], influence=False)
            variant = dict(source="Var1/Var01_LOD0.fbx", sha256=digest(src), primaryAxes=[], secondaryAxes=[],
                           frame=dict(units="cm", up="Z", sizeCm=[1]*3, bboxMinCm=[0]*3, bboxMaxCm=[1]*3),
                           bindings=[row,dict(row,island=1)], review=dict(status="static"),
                           counts=dict(islands=2,primaryAxes=0,secondaryAxes=0,branch1InfluencedIslands=0,
                                       branch2InfluencedIslands=0,foliageIslands=0,unattachedIslands=0))
            asset = dict(id="sample", form="")
            doc = dict(provider="DeepSeek Harness",schemaVersion=1,assetId=asset["id"],form="",variants={"Var1":variant})
            split_variant(variant, folder, "Var1", limit=1)
            self.assertEqual(len(validate_asset(doc,asset,folder,folder)), 2)
            variant["hasTerminal"] = True
            with self.assertRaisesRegex(ValueError,"chunk summary"):
                validate_asset(doc,asset,folder,folder)
            variant["hasTerminal"] = False
            variant["bindingChunks"].reverse()
            with self.assertRaisesRegex(ValueError,"ordinal"):
                validate_asset(doc,asset,folder,folder)
            (folder/"Var2").mkdir()
            with self.assertRaisesRegex(ValueError,"coverage"):
                validate_asset(doc,asset,folder,folder)

    def test_reject_ambiguous_json(self):
        for encoded in ('{"terminal":true,"terminal":false}', '{"tip":NaN}'):
            with self.assertRaises(ValueError):
                parse(encoded)


if __name__ == "__main__":
    unittest.main()
