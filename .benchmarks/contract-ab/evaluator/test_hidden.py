import asyncio
import importlib.util
import pathlib
import sys
import unittest


SUBMISSION = pathlib.Path(sys.argv.pop(1)).resolve()
sys.path.insert(0, str(SUBMISSION))
from scheduler import CycleError, GraphError, PriorResult, run_graph


class HiddenSchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def test_unknown_dependency_rejected_before_worker(self):
        calls = []

        async def worker(name, value):
            calls.append(name)

        with self.assertRaises(GraphError):
            await run_graph({"a": 1}, {"a": {"missing"}}, worker)
        self.assertEqual(calls, [])

    async def test_self_dependency_rejected_before_worker(self):
        calls = []

        async def worker(name, value):
            calls.append(name)

        with self.assertRaises(GraphError):
            await run_graph({"a": 1}, {"a": {"a"}}, worker)
        self.assertEqual(calls, [])

    async def test_cycle_reports_closed_real_path(self):
        async def worker(name, value):
            raise AssertionError("worker must not run")

        with self.assertRaises(CycleError) as caught:
            await run_graph(
                {"a": 1, "b": 2, "c": 3, "free": 4},
                {"a": {"b"}, "b": {"c"}, "c": {"a"}},
                worker,
            )
        cycle = caught.exception.cycle
        self.assertGreaterEqual(len(cycle), 2)
        self.assertEqual(cycle[0], cycle[-1])
        for task, dep in zip(cycle, cycle[1:]):
            self.assertIn(dep, {"a": {"b"}, "b": {"c"}, "c": {"a"}}[task])

    async def test_failure_skips_only_descendants(self):
        calls = []

        async def worker(name, value):
            calls.append(name)
            await asyncio.sleep(0)
            if name == "a":
                raise RuntimeError("boom")
            return name.upper()

        result = await run_graph(
            {"a": 1, "b": 2, "c": 3, "x": 4, "y": 5},
            {"b": {"a"}, "c": {"b"}, "y": {"x"}},
            worker,
            concurrency=2,
        )
        self.assertIn("a", result.failed)
        self.assertEqual(set(result.skipped), {"b", "c"})
        self.assertEqual(set(result.succeeded), {"x", "y"})
        self.assertNotIn("b", calls)
        self.assertNotIn("c", calls)

    async def test_multiple_dependency_failure_propagates(self):
        async def worker(name, value):
            if name == "bad":
                raise OSError("no")
            return name

        result = await run_graph(
            {"bad": 0, "good": 1, "join": 2, "leaf": 3},
            {"join": {"bad", "good"}, "leaf": {"join"}},
            worker,
        )
        self.assertEqual(set(result.succeeded), {"good"})
        self.assertEqual(set(result.failed), {"bad"})
        self.assertEqual(set(result.skipped), {"join", "leaf"})

    async def test_failed_prior_is_retried_and_unknown_prior_ignored(self):
        calls = []

        async def worker(name, value):
            calls.append(name)
            return value * 10

        result = await run_graph(
            {"a": 1, "b": 2},
            {"b": {"a"}},
            worker,
            prior={
                "a": PriorResult("failed", 999),
                "ghost": PriorResult("succeeded", 123),
            },
        )
        self.assertEqual(calls, ["a", "b"])
        self.assertNotIn("ghost", result.outputs)

    async def test_prior_success_without_output_is_retried(self):
        calls = []

        async def worker(name, value):
            calls.append(name)
            return value

        result = await run_graph(
            {"a": 1},
            {},
            worker,
            prior={"a": PriorResult("succeeded")},
        )
        self.assertEqual(calls, ["a"])
        self.assertEqual(result.outputs["a"], 1)

    async def test_every_task_classified_once(self):
        async def worker(name, value):
            if name == "fail":
                raise RuntimeError()
            return value

        tasks = {"ok": 1, "fail": 2, "child": 3, "independent": 4}
        result = await run_graph(
            tasks,
            {"child": {"fail"}},
            worker,
            prior={"ok": PriorResult("succeeded", "cached")},
        )
        classified = result.succeeded + list(result.failed) + result.skipped
        self.assertEqual(set(classified), set(tasks))
        self.assertEqual(len(classified), len(set(classified)))
        self.assertEqual(set(result.outputs), set(result.succeeded))

    async def test_ready_launch_order_is_lexicographic(self):
        starts = []
        gate = asyncio.Event()

        async def worker(name, value):
            starts.append(name)
            if len(starts) == 2:
                gate.set()
            await gate.wait()
            return value

        result = await asyncio.wait_for(
            run_graph(
                {"z": 1, "a": 2, "m": 3},
                {},
                worker,
                concurrency=2,
            ),
            timeout=1,
        )
        self.assertEqual(starts[:2], ["a", "m"])
        self.assertEqual(set(result.succeeded), {"a", "m", "z"})


if __name__ == "__main__":
    unittest.main()
