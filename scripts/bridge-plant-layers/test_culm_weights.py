import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from run import retain_reviewed_weights


class ReviewedCulmWeights(unittest.TestCase):
    def test_exact_source_retains_authored_finite_contact_weights(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            source = directory / "culm.fbx"
            source.write_bytes(b"native reviewed source")
            previous = {"sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                        "primaryAxes": [{"weightProfile": "cantilever"}],
                        "bindings": [{"primary": 0, "primaryAttachment": .73456789}]}
            before = copy.deepcopy(previous)
            retained = retain_reviewed_weights(previous, source, directory)
            self.assertEqual(retained, before)
            retained["bindings"][0]["primaryAttachment"] = 0
            self.assertEqual(previous, before)
            source.write_bytes(b"changed geometry")
            with self.assertRaisesRegex(ValueError, "source changed"):
                retain_reviewed_weights(previous, source, directory)

    def test_unmarked_assets_continue_through_normal_generation(self):
        self.assertIsNone(retain_reviewed_weights({"primaryAxes": []}, Path("unused"), Path("unused")))

    def test_chunked_reviewed_contacts_are_verified_before_reuse(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            source = directory / "culm.fbx"
            source.write_bytes(b"same source")
            rows = [{"primary": 0, "primaryAttachment": .73456789}]
            data = json.dumps(rows).encode()
            name = "Var1_0000_" + hashlib.sha256(data).hexdigest() + ".json"
            parts = directory / "_layer_data"
            parts.mkdir()
            (parts / name).write_bytes(data)
            previous = {"sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                        "primaryAxes": [{"weightProfile": "cantilever"}],
                        "bindingChunks": [name], "bindingCount": 1, "hasSecondary": False, "hasTerminal": True}
            retained = retain_reviewed_weights(previous, source, directory)
            self.assertEqual(retained["bindings"], rows)
            self.assertNotIn("bindingChunks", retained)
            (parts / name).write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "chunk changed"):
                retain_reviewed_weights(previous, source, directory)


if __name__ == "__main__":
    unittest.main()
