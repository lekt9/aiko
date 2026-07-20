import asyncio
import unittest

from scheduler import PriorResult, run_graph


class SchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def test_dependency_order_and_outputs(self):
        calls = []

        async def worker(name, value):
            calls.append(name)
            return value * 2

        result = await run_graph(
            {"build": 2, "test": 3, "ship": 4},
            {"test": {"build"}, "ship": {"test"}},
            worker,
        )
        self.assertEqual(calls, ["build", "test", "ship"])
        self.assertEqual(result.succeeded, ["build", "test", "ship"])
        self.assertEqual(result.outputs["ship"], 8)

    async def test_reuses_successful_prior_output(self):
        calls = []

        async def worker(name, value):
            calls.append(name)
            return value

        result = await run_graph(
            {"a": 1, "b": 2},
            {"b": {"a"}},
            worker,
            prior={"a": PriorResult("succeeded", 99)},
        )
        self.assertEqual(calls, ["b"])
        self.assertEqual(result.outputs, {"a": 99, "b": 2})

    async def test_concurrency_bound(self):
        active = 0
        peak = 0

        async def worker(name, value):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.01)
            active -= 1
            return value

        await run_graph(
            {str(i): i for i in range(8)},
            {},
            worker,
            concurrency=3,
        )
        self.assertLessEqual(peak, 3)
        self.assertGreater(peak, 1)


if __name__ == "__main__":
    unittest.main()
