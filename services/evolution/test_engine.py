import os
import unittest

from engine import run_evolution
from gepa_loop import run_gepa_loop
from heuristic import propose_mutations


class EvolutionEngineTest(unittest.TestCase):
    def setUp(self) -> None:
        os.environ["DIY_GEPA_ENABLED"] = "0"
        os.environ["DIY_GEPA_MAX_ROUNDS"] = "3"

    def test_heuristic_engine_mode(self) -> None:
        os.environ["DIY_EVOLUTION_ENGINE"] = "heuristic"
        mutations, engine, gepa_meta = run_evolution(
            {
                "target": "prompt",
                "tier": "L1",
                "traces": [{"output": "", "toolCalls": []}],
                "snapshot": {"systemPrompt": "base"},
            }
        )
        self.assertEqual(engine, "heuristic")
        self.assertTrue(mutations)
        self.assertEqual(mutations[0]["path"], "prompt/system")
        self.assertEqual(gepa_meta, {})

    def test_dspy_stub_engine_mode(self) -> None:
        os.environ["DIY_EVOLUTION_ENGINE"] = "dspy"
        os.environ["DIY_EVOLUTION_USE_DSPY_STUB"] = "1"
        os.environ["DIY_GEPA_ENABLED"] = "0"
        mutations, engine, gepa_meta = run_evolution(
            {
                "target": "skill",
                "tier": "L1",
                "traces": [{"output": "ok", "toolCalls": [{"name": "lookup", "ok": False}]}],
                "evalTasks": [{"input": "task-1"}],
            }
        )
        self.assertEqual(engine, "dspy-stub")
        self.assertTrue(mutations)
        self.assertEqual(gepa_meta, {})

    def test_gepa_loop_requires_real_evaluation(self) -> None:
        import os

        os.environ["DIY_GEPA_ENABLED"] = "1"
        body = {
            "baseVersionId": "v1",
            "target": "prompt",
            "tier": "L1",
            "snapshot": {"systemPrompt": "base"},
            "evalTasks": [{"expectedContains": ["alpha", "beta"]}] * 5,
            "traces": [
                {
                    "profileVersionId": "v1",
                    "output": "",
                    "latencyMs": 50,
                    "toolCalls": [],
                }
            ]
            * 5,
        }
        with self.assertRaisesRegex(RuntimeError, "agent_evaluator_required"):
            run_gepa_loop(body, propose_mutations)



if __name__ == "__main__":
    unittest.main()
