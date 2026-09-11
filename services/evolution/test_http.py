import json
import threading
import unittest
from http.server import HTTPServer
from urllib.request import Request, urlopen
from server import EvolutionHandler


class EvolutionHttpTest(unittest.TestCase):
    def test_real_http_proposes_mutations_without_claiming_unmeasured_improvement(self):
        import os
        os.environ["DIY_GEPA_ENABLED"] = "0"
        os.environ["DIY_EVOLUTION_ENGINE"] = "heuristic"
        server = HTTPServer(("127.0.0.1", 0), EvolutionHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            req = Request(f"http://127.0.0.1:{server.server_port}/run", data=json.dumps({
                "target": "prompt", "tier": "L2", "snapshot": {"systemPrompt": "base"}
            }).encode(), headers={"Content-Type": "application/json"})
            with urlopen(req, timeout=5) as response:
                result = json.load(response)
            self.assertTrue(result["mutations"])
            self.assertEqual(result["status"], "awaiting_review")
            self.assertEqual(result["evalScoreDelta"], 0)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_production_entry_requires_auth_configuration(self):
        from unittest.mock import patch
        from server import main
        with patch.dict('os.environ', {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, 'evolution_auth_not_configured'):
                main()
