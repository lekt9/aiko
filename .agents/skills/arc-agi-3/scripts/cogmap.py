"""Dependency-free cognitive map used when the legacy native binding is absent."""

from __future__ import annotations

from collections import deque
from collections import Counter


class CognitiveMap:
    def __init__(self) -> None:
        self.available: dict[int, list[int]] = {}
        self.transitions: dict[tuple[int, int], int] = {}
        self.tried: set[tuple[int, int]] = set()
        self.action_uses: Counter[int] = Counter()

    def observe(self, source: int, action: int, target: int) -> None:
        self.tried.add((source, action))
        self.transitions[(source, action)] = target
        self.action_uses[action] += 1

    def set_available(self, state: int, actions: list[int]) -> None:
        self.available[state] = list(dict.fromkeys(int(action) for action in actions))

    def next(self, state: int) -> int | None:
        # A newly discovered state must not always restart at the lowest action ID.
        # Balance probes globally, while retaining deterministic ordering for reproducibility.
        for action in sorted(self.available.get(state, []), key=lambda item: (self.action_uses[item], item)):
            if (state, action) not in self.tried:
                return action

        queue = deque([(state, None)])
        visited = {state}
        while queue:
            current, first_action = queue.popleft()
            if current != state and any(
                (current, action) not in self.tried
                for action in self.available.get(current, [])
            ):
                return first_action
            for action in self.available.get(current, []):
                target = self.transitions.get((current, action))
                if target is None or target in visited:
                    continue
                visited.add(target)
                queue.append((target, action if first_action is None else first_action))
        return None
