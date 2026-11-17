"""Regression checks for transferring wind across disconnected scan geometry."""
import unittest

import numpy as np

from windlayer.analyze import analyze_variant
from windlayer.contact_review import recover_contacts, prune_synthetic_axes, remap_primary
from windlayer.surface_fragments import find_fragment_parents, inherit_surface


class SurfaceContacts(unittest.TestCase):
    def test_a_recovered_side_stem_can_supply_its_leaf_in_the_same_repair(self):
        root = np.array([[-.05, 0, 0], [.05, 0, 0], [-.05, 0, 10], [.05, 0, 10.]])
        perpendicular = np.array([-1., 0., 2.]) / np.sqrt(5.)
        rings = np.array([point + .08 * (np.cos(angle) * perpendicular + np.sin(angle) * np.array([0., 1., 0.]))
                          for point in (np.array([0., 0., 4.]), np.array([4., 0., 6.]))
                          for angle in np.arange(8) * 2 * np.pi / 8])
        leaf = np.array([[1.92, .082, 5], [2.08, .082, 5], [1.93, 2, 5], [2.07, 2, 5], [2, 4, 5.]])
        points = np.vstack([root, rings, leaf])
        tube_faces = np.array([[i, (i+1)%8, i+8] if k == 0 else [(i+1)%8, (i+1)%8+8, i+8]
                               for i in range(8) for k in (0, 1)]) + 4
        faces = np.vstack([[[0, 1, 2], [1, 3, 2]], tube_faces,
                           np.array([[0, 1, 2], [1, 3, 2], [2, 3, 4]]) + 20])
        labels = np.repeat([0, 1, 2], [4, 16, 5])
        low, size = points.min(axis=0), np.maximum(np.ptp(points, axis=0), 1e-9)
        norm = lambda point: ((np.asarray(point)-low)/size).tolist()
        variant = dict(primaryAxes=[dict(id=0, base=norm([0,0,0]), tip=norm([0,0,10]), synthetic=False)], secondaryAxes=[])
        rows = [dict(island=0, primary=0, secondary=-1, primaryAttachment=-1., terminal=False,
                     influence=True, attachMethod="support"),
                dict(island=1, unit=1, primary=-1, secondary=-1, terminal=False, review=True,
                     influence=False, layers=["Shared"], attachMethod="unplacedSupport", unplacedSupport=True),
                dict(island=2, unit=2, primary=-1, secondary=-1, terminal=False, review=True,
                     influence=False, layers=["Shared"], attachMethod="synthetic")]
        self.assertEqual(recover_contacts(variant, rows, points, faces, labels, "herb"), 2)
        self.assertEqual(len(variant["secondaryAxes"]), 1)
        self.assertEqual(rows[2]["secondary"], 0)
        self.assertEqual(rows[2]["primaryAttachment"], rows[1]["primaryAttachment"])
        self.assertFalse(rows[1]["terminal"])
        self.assertTrue(rows[2]["terminal"])

    def test_measured_root_stalks_in_wide_ground_cover_do_not_need_a_global_upright_bbox(self):
        stalk = np.array([[x, 0., z] for z in (0., 2., 4., 6., 8., 10.) for x in (-.05, .05)])
        strip = np.array([[i, i+1, i+2] if parity == 0 else [i+1, i+3, i+2]
                          for i in range(0, 10, 2) for parity in (0, 1)])
        for upright in (True, False):
            with self.subTest(upright=upright):
                vertices = np.vstack([stalk, stalk + [100, 0, 0]])
                if not upright:
                    vertices = vertices[:, [2, 1, 0]]
                faces = np.vstack([strip, strip + 12])
                labels = np.repeat([0, 1], 12)
                rows = [dict(island=i, unit=i, review=True, influence=False,
                             terminal=False, layers=["Shared"], attachMethod="synthetic") for i in range(2)]
                variant = dict(primaryAxes=[], secondaryAxes=[])
                recover_contacts(variant, rows, vertices, faces, labels, "groundcover")
                self.assertEqual(len(variant["primaryAxes"]), 2 if upright else 0)
                if upright:
                    self.assertTrue(all(not row["review"] and row["layers"] == ["Shared", "Branch1"] for row in rows))

    def test_leaf_attaches_to_a_sparse_stem_face_interior_and_rejects_ambiguous_contacts(self):
        stem = np.array([[-.05, 0, 0], [.05, 0, 0], [-.05, 0, 10], [.05, 0, 10.]])
        leaf = np.array([[-.08, .002, 4], [.08, .002, 4], [-.07, 2, 4], [.07, 2, 4], [0, 4, 4.]])
        stem_faces = np.array([[0, 1, 2], [1, 3, 2]])
        leaf_faces = np.array([[4, 5, 6], [5, 7, 6], [6, 7, 8]])
        for duplicate, offset in ((False, 0.), (True, 0.), (False, 1.)):
            with self.subTest(duplicate=duplicate, offset=offset):
                points = np.vstack([stem, leaf + [offset, 0, 0]])
                faces = np.vstack([stem_faces, leaf_faces])
                labels = np.r_[np.zeros(4, int), np.ones(5, int)]
                rows = [dict(island=0, primary=0, secondary=-1, primaryAttachment=-1.,
                             terminal=False, influence=True, attachMethod="support"),
                        dict(island=1, unit=1, primary=-1, secondary=-1, review=True,
                             influence=False, terminal=False, layers=["Shared"], attachMethod="synthetic")]
                variant = dict(primaryAxes=[dict(id=0, base=[.5, 0, 0], tip=[.5, 0, 1], synthetic=False)], secondaryAxes=[])
                if duplicate:
                    points = np.vstack([points, stem + [0, .015, 0]])
                    faces = np.vstack([faces, stem_faces + 9])
                    labels = np.r_[labels, np.full(4, 2)]
                    rows.append(dict(rows[0], island=2, primary=1))
                    variant["primaryAxes"].append(dict(variant["primaryAxes"][0], id=1))
                recover_contacts(variant, rows, points, faces, labels, "herb")
                if duplicate or offset:
                    self.assertTrue(rows[1]["review"])
                else:
                    self.assertFalse(rows[1]["review"])
                    self.assertEqual(rows[1]["attachMethod"], "surfaceContact")
                    self.assertEqual(rows[1]["primary"], 0)
                    self.assertAlmostEqual(rows[1]["primaryAttachment"], .4)
                    self.assertIn("Ripple", rows[1]["layers"])

    def test_unused_welded_position_keeps_an_inactive_island_row(self):
        # A rooted blade plus an unused control point by its free end.
        points = np.array([[0., 0., 0.], [.04, 0., 0.], [0., 0., 1.],
                           [.04, 0., 1.], [0., 0., 2.], [.04, 0., 2.], [.02, .001, 1.99]])
        faces = np.array([[0, 1, 2], [1, 3, 2], [2, 3, 4], [3, 5, 4]])
        variant = analyze_variant(points, faces, form="grass")
        visible, unused = variant["bindings"]
        self.assertTrue(visible["terminal"])
        self.assertEqual(variant["counts"]["noSurfaceIslands"], 1)
        self.assertEqual(unused["attachMethod"], "noSurface")
        self.assertFalse(unused["influence"])
        self.assertFalse(unused["review"])
        self.assertEqual((unused["primary"], unused["secondary"], unused["terminal"]), (-1, -1, False))

    def test_rejected_axis_is_removed_without_changing_real_parentage(self):
        variant = dict(primaryAxes=[dict(id=0, synthetic=True), dict(id=1, synthetic=False)],
                       secondaryAxes=[dict(id=0, primary=1)], counts={})
        mapping = prune_synthetic_axes(variant)
        active = dict(primary=1, secondary=0)
        pending = dict(primary=0, review=True, influence=False)
        remap_primary(active, mapping)
        remap_primary(pending, mapping)
        self.assertEqual(active, dict(primary=0, secondary=0))
        self.assertEqual(variant["secondaryAxes"][0]["primary"], 0)
        self.assertEqual(pending["primary"], -1)
        self.assertEqual(variant["counts"]["primaryAxes"], 1)
        with self.assertRaises(ValueError):
            remap_primary(dict(primary=0, influence=True), mapping)

    def test_small_fragment_inherits_a_unique_face_interior(self):
        surface = [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0], [2, 2, 0]]
        fragment = [[.97, .51, .002], [1.01, .51, .003], [.98, .55, .004]]
        vertices = np.array(surface + fragment)
        triangles = np.array([[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4], [5, 6, 7]])
        labels = np.array([0]*5 + [1]*3)
        donor = dict(island=0, primary=2, secondary=1, primaryAttachment=.4, secondaryAttachment=.6,
                     terminal=True, blade=[[.1, .2, 0], [.5, .4, 0]], layers=["Shared", "Branch1", "Branch2", "Ripple"],
                     attachMethod="support")
        child = dict(island=1, review=True, influence=False, layers=["Shared"], terminal=False)
        matched, parents = find_fragment_parents(vertices, triangles, labels, [donor, child], 20.)
        self.assertEqual(matched.tolist(), [-1, 0])
        self.assertTrue(inherit_surface(child, parents[matched[1]]))
        self.assertEqual(child["blade"], donor["blade"])
        self.assertEqual((child["primary"], child["secondary"], child["terminal"]), (2, 1, True))
        self.assertFalse(inherit_surface(child, donor))
        donor["rootContact"] = dict(center=[.1, .2, 0], innerHeight=.01, outerHeight=.03)
        self.assertTrue(inherit_surface(child, donor))
        self.assertEqual(child["rootContact"], donor["rootContact"])
        donor["rootContact"]["innerHeight"] = .02
        self.assertEqual(child["rootContact"]["innerHeight"], .01)
        self.assertTrue(inherit_surface(child, donor))

        # A second leaf has a different terminal axis and lies within contact uncertainty.
        other = dict(donor, island=2, blade=[[.2, .2, 0], [.6, .4, 0]])
        doubled = np.vstack([vertices, np.array(surface) + [0, 0, .012]])
        faces = np.vstack([triangles, triangles[:4] + 8])
        matched, _ = find_fragment_parents(doubled, faces, np.r_[labels, [2]*5], [donor, child, other], 20.)
        self.assertEqual(matched[1], -1)
        vertices[5:, 2] += 1.
        matched, _ = find_fragment_parents(vertices, triangles, labels, [donor, child], 20.)
        self.assertEqual(matched[1], -1)

    def test_inherited_multiface_fragment_resyncs_only_a_unique_root_field(self):
        surface = np.array([[0., 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0], [2, 2, 0]])
        fragment = [[.97, .51, .002], [1.01, .51, .003], [1.01, .55, .004], [.97, .55, .002]]
        vertices = np.vstack([surface, fragment])
        faces = np.array([[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4], [5, 6, 7], [5, 7, 8]])
        labels = np.array([0]*5 + [1]*4)
        parent = dict(island=0, primary=0, secondary=-1, primaryAttachment=-1., secondaryAttachment=-1.,
                      terminal=False, blade=[[0, 0, 0], [0, 0, 1]], layers=['Shared', 'Branch1'],
                      attachMethod='support', rootContact=dict(center=[0, 0, 0], innerHeight=.01, outerHeight=.04))
        child = dict(island=1)
        inherit_surface(child, parent)
        child['blade'] = [[.1, .1, .1], [.2, .2, .2]]
        self.assertFalse(inherit_surface(child, parent))  # No Ripple: the unused blade is irrelevant.
        child.pop('rootContact')
        matched, parents = find_fragment_parents(vertices, faces, labels, [parent, child], 20.)
        self.assertEqual(matched[1], 0)
        self.assertTrue(inherit_surface(child, parents[0]))
        other = dict(parent, island=2, rootContact=dict(center=[.2, 0, 0], innerHeight=.01, outerHeight=.04))
        vertices = np.vstack([vertices, surface + [0, 0, .012]])
        faces = np.vstack([faces, faces[:4] + 9])
        matched, _ = find_fragment_parents(vertices, faces, np.r_[labels, [2]*5], [parent, child, other], 20.)
        self.assertEqual(matched[1], -1)

    def test_paired_upright_stalks_share_one_primary_and_flat_scans_stay_unbound(self):
        stalk = np.array([[-.1, 0, 0], [.1, 0, 0], [-.2, 0, 2], [.2, 0, 2],
                          [-.5, 0, 5], [.5, 0, 5], [-.4, 0, 8], [.4, 0, 8]])
        strip = np.array([[0, 1, 2], [1, 3, 2], [2, 3, 4], [3, 5, 4], [4, 5, 6], [5, 7, 6]])
        triangles = np.vstack([strip, strip + 8])
        for upright in (True, False):
            vertices = np.vstack([stalk, stalk + [0, .06, 0]])
            if not upright:
                vertices = vertices[:, [0, 2, 1]]
            rows = [dict(island=i, unit=i, review=True, influence=False, attachMethod="synthetic")
                    for i in range(2)]
            variant = dict(primaryAxes=[], secondaryAxes=[])
            recover_contacts(variant, rows, vertices, triangles, np.repeat([0, 1], 8), "herb")
            self.assertEqual(len(variant["primaryAxes"]), int(upright))
            if upright:
                self.assertEqual([row["primary"] for row in rows], [0, 0])
                self.assertTrue(all(row["layers"] == ["Shared", "Branch1"] for row in rows))

    def test_upright_grass_blade_needs_a_real_root(self):
        blade = np.array([[-.15, 0, 0], [.15, 0, 0], [-.13, 0, 4], [.13, 0, 4], [0, 0, 9.]])
        vertices = np.vstack([blade, blade + [3, 0, 3]])
        faces = np.array([[0, 1, 2], [1, 3, 2], [2, 3, 4]])
        triangles = np.vstack([faces, faces + 5])
        variant = dict(primaryAxes=[], secondaryAxes=[])
        rows = [dict(island=i, unit=i, review=True, influence=False, attachMethod="unassigned") for i in range(2)]
        recover_contacts(variant, rows, vertices, triangles, np.repeat([0, 1], 5), "grass")
        self.assertEqual(len(variant["primaryAxes"]), 1)
        self.assertEqual(rows[0]["layers"], ["Shared", "Branch1", "Ripple"])
        self.assertTrue(rows[1]["review"])


if __name__ == "__main__":
    unittest.main()
