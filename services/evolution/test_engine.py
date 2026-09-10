import unittest

from engine import run_evolution


class EvolutionEngineTest(unittest.TestCase):
    def test_heuristic_engine_mode(self) -> None:
        import os

        os.environ["DIY_EVOLUTION_ENGINE"] = "heuristic"
        mutations, engine = run_evolution(
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

    def test_dspy_stub_engine_mode(self) -> None:
        import os

        os.environ["DIY_EVOLUTION_ENGINE"] = "dspy"
        os.environ["DIY_EVOLUTION_USE_DSPY_STUB"] = "1"
        mutations, engine = run_evolution(
            {
                "target": "skill",
                "tier": "L1",
                "traces": [{"output": "ok", "toolCalls": [{"name": "lookup", "ok": False}]}],
                "evalTasks": [{"input": "task-1"}],
            }
        )
        self.assertEqual(engine, "dspy-stub")
        self.assertTrue(mutations)


if __name__ == "__main__":
    unittest.main()
