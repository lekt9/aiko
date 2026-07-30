from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Mapping


class GraphError(ValueError):
    pass


class CycleError(GraphError):
    def __init__(self, cycle: list[str]):
        self.cycle = cycle
        super().__init__("dependency cycle: " + " -> ".join(cycle))


@dataclass
class PriorResult:
    state: str
    output: Any = None


@dataclass
class RunResult:
    succeeded: list[str] = field(default_factory=list)
    failed: dict[str, BaseException] = field(default_factory=dict)
    skipped: list[str] = field(default_factory=list)
    outputs: dict[str, Any] = field(default_factory=dict)


Worker = Callable[[str, Any], Awaitable[Any]]


async def run_graph(
    tasks: Mapping[str, Any],
    deps: Mapping[str, set[str]],
    worker: Worker,
    *,
    concurrency: int = 4,
    prior: Mapping[str, PriorResult] | None = None,
) -> RunResult:
    """Execute tasks once their dependencies complete.

    This starter implementation is intentionally incomplete and incorrect.
    """
    if concurrency < 1:
        raise ValueError("concurrency must be positive")

    result = RunResult()
    completed: set[str] = set()
    prior = prior or {}

    # BUG: trusts all prior states, including failed ones.
    for name, old in prior.items():
        if name in tasks:
            completed.add(name)
            result.succeeded.append(name)
            result.outputs[name] = old.output

    # BUG: no graph validation, no cycle detection, no concurrency, and a
    # dependency failure aborts the whole run.
    pending = set(tasks) - completed
    while pending:
        ready = [name for name in pending if deps.get(name, set()) <= completed]
        if not ready:
            break
        name = ready[0]
        output = await worker(name, tasks[name])
        result.succeeded.append(name)
        result.outputs[name] = output
        completed.add(name)
        pending.remove(name)

    result.skipped.extend(pending)
    return result
