"""Regressions for distinct shoots that used to form a single short wind axis."""
import unittest

import numpy as np

from windlayer.fork_review import ForkBindings, remap_final_side
from windlayer.surface_fragments import find_fragment_parents


class BranchForkReview(unittest.TestCase):
    def test_two_laterals_meeting_at_insertion_stay_separate(self):
        parent = np.array([[0.,0.,0.], [0.,0.,5.], [0.,0.,10.]])
        east = np.array([[0.,0.,5.], [2.,0.,7.], [4.,0.,9.]])
        west = np.array([[0.,0.,5.], [-2.,0.,7.], [-4.,0.,9.]])
        walked = np.vstack([east, west[::-1]])
        variant = dict(primaryAxes=[dict(id=0, units=[0], base=[0.,0.,0.], tip=[0.,0.,1.])],
                       secondaryAxes=[dict(id=0, primary=0, units=[1,2], attachOnPrimary=.5)])
        tool = ForkBindings(variant,[("secondaryAxes",0,walked)],{0:parent,1:east,2:west}.__getitem__,
                            np.zeros(3),np.full(3,10.))
        rows = [dict(primary=0, secondary=0, primaryAttachment=.5, secondaryAttachment=-1.,terminal=False)
                for _ in (1,2)]
        for i,row in enumerate(rows,1):
            tool.bind(row,i)
        self.assertNotEqual(rows[0]["secondary"],rows[1]["secondary"])
        self.assertTrue(all(row["secondaryAttachment"] == -1 and row["primaryAttachment"] == .5 for row in rows))
        for row in rows:
            axis = variant["secondaryAxes"][row["secondary"]]
            self.assertEqual(axis["primary"],0)
            self.assertEqual(axis["base"],[0.,0.,.5])
            self.assertGreater(abs(axis["tip"][0]),.3)

    def test_existing_shoot_inherits_the_new_lateral_at_its_measured_root(self):
        trunk = np.array([[0., 0., 0.], [0., 0., 5.], [0., 0., 10.]])
        lateral = np.array([[0., 0., 5.], [3., 0., 7.], [6., 0., 9.]])
        shoot = np.array([[3., 0., 7.], [4., 2., 8.]])
        old_walk = np.vstack([trunk, lateral[::-1], lateral, trunk[::-1]])
        arc = np.r_[0., np.linalg.norm(np.diff(old_walk, axis=0), axis=1).cumsum()]
        variant = dict(
            primaryAxes=[dict(id=0, units=[0, 1], base=[0., 0., 0.], tip=[0., 0., .01])],
            secondaryAxes=[dict(id=0, primary=0, units=[2], attachOnPrimary=arc[4]/arc[-1],
                                base=[.3, 0., .7], tip=[.4, .2, .8])],
        )
        model = ForkBindings(variant, [("primaryAxes", 0, old_walk)],
                             [trunk, lateral, shoot].__getitem__, np.zeros(3), np.full(3, 10.))
        leaf = dict(primary=0, secondary=0, primaryAttachment=.5, secondaryAttachment=.9,
                    terminal=True, layers=["Shared", "Branch1", "Branch2", "Ripple"])
        side_remap = model.finish_existing_laterals()
        remap_final_side(leaf, side_remap)
        self.assertEqual(len(variant["secondaryAxes"]), 1)
        self.assertEqual(set(variant["secondaryAxes"][0]["units"]), {1, 2})
        self.assertEqual(leaf["secondary"], 0)
        self.assertAlmostEqual(leaf["secondaryAttachment"], .5)
        self.assertEqual(leaf["layers"][-1], "Ripple")

    def test_whole_scan_piece_has_to_touch_one_surface(self):
        vertices=np.array([[0.,0.,0.],[4.,0.,0.],[4.,4.,0.],[0.,4.,0.],[2.,2.,0.],
                           [.9,.5,.001],[1.,.5,.001],[1.,.6,.001],[.9,.6,.001]])
        faces=np.array([[0,1,4],[1,2,4],[2,3,4],[3,0,4],[5,6,7],[5,7,8]])
        labels=np.array([0]*5+[1]*4)
        donor=dict(island=0,primary=1,secondary=-1,primaryAttachment=-1.,secondaryAttachment=-1.,
                   terminal=False, blade=[[0.,0.,0.],[0.,1.,0.]],attachMethod="support")
        pending=dict(island=1,review=True)
        def match():
            return find_fragment_parents(vertices,faces,labels,[donor,pending],20.,review_only=True)[0][1]
        self.assertGreaterEqual(match(),0)
        vertices[8,2]=.1
        self.assertEqual(match(),-1)


if __name__ == "__main__":
    unittest.main()
