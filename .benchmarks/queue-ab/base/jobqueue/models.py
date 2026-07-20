from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


class QueueDataError(RuntimeError):
    pass


@dataclass(frozen=True)
class ClaimedJob:
    id: str
    payload: Any
    attempts: int
    lease_token: str
    lease_until: float


@dataclass(frozen=True)
class JobRecord:
    id: str
    payload: Any
    state: str
    attempts: int
    available_at: float
    lease_token: Optional[str]
    lease_until: Optional[float]
    last_error: Optional[str]
    idempotency_key: Optional[str]
