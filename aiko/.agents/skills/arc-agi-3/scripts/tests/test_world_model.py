from pathlib import Path
import sys
import uuid


SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

import arc_skill


class Frame:
    def __init__(self, grid, levels=0, state="NOT_FINISHED", actions=None):
        self.frame = [grid]
        self.levels_completed = levels
        self.state = state
        self.available_actions = actions or [1, 2]


class RecordingContract:
    def __init__(self):
        self.observations = []
        self.binary_observations = []

    def observe_capability(self, context, capability_id, success, shape):
        self.observations.append((context, capability_id, success, shape))

    def observe_binary(self, context, capability_id, before, after, reward):
        self.binary_observations.append((context, capability_id, before, after, reward))
        return True


def bare_skill(contract):
    skill = arc_skill.ArcSkill.__new__(arc_skill.ArcSkill)
    skill._contract = contract
    skill._contract_last = None
    skill._contract_calls = 0
    skill._experiment_uses = {}
    skill._experiment_attempts = 0
    skill._hypothesis_by_proposal = {}
    skill._grounded_contexts = set()
    skill._navigation_visited = set()
    skill._paint_variant = 0
    skill._tried_proposals = set()
    skill._inhibited_proposals = set()
    skill._current_level = 0
    return skill


def test_frame_change_is_dynamics_evidence_not_success():
    contract = RecordingContract()
    skill = bare_skill(contract)
    before = [[0, 0], [0, 1]]
    after = [[0, 1], [0, 0]]
    skill._contract_last = ("ctx", "aiko-arc.action.1", arc_skill.semantic_state_descriptor(before), 0, (1, None, None))
    skill._observe_contract_transition(Frame(after), after, "next")
    assert contract.observations == []
    assert contract.binary_observations[0][-1] == 0.15


def test_level_progress_is_the_positive_anchor():
    contract = RecordingContract()
    skill = bare_skill(contract)
    before = [[0, 0], [0, 1]]
    after = [[1, 0], [0, 0]]
    skill._contract_last = ("ctx", "aiko-arc.action.2", arc_skill.semantic_state_descriptor(before), 0, (2, None, None))
    skill._observe_contract_transition(Frame(after, levels=1), after, "next")
    assert contract.observations == [("ctx", "aiko-arc.action.2", True, "object")]
    assert contract.binary_observations[0][-1] == 1.0


def test_click_candidates_are_structural_and_coordinate_bound():
    grid = [[0 for _ in range(8)] for _ in range(8)]
    grid[1][1] = 2
    grid[6][5] = 3
    candidates = arc_skill.semantic_click_candidates(grid)
    assert {(item["x"], item["y"]) for item in candidates} == {(1, 1), (5, 6)}
    assert all(item["capability_id"].startswith("aiko-arc.click.") for item in candidates)
    assert all("1-1" not in item["capability_id"] and "5-6" not in item["capability_id"] for item in candidates)
    assert len({item["capability_id"] for item in candidates}) == len(candidates)


def test_repeated_semantic_roles_get_coordinate_free_unique_ids():
    grid = [[0 for _ in range(12)] for _ in range(12)]
    for y in (10, 11):
        for x in (1, 2, 8, 9):
            grid[y][x] = 3
    candidates = arc_skill.semantic_click_candidates(grid)
    repeated = [
        item for item in candidates
        if "bottom-small-color-3" in item["capability_id"]
    ]
    assert len(repeated) == 2
    assert repeated[0]["capability_id"] != repeated[1]["capability_id"]
    assert {item["capability_id"].rsplit("-", 1)[-1] for item in repeated} == {"1", "2"}
    assert all(
        f"{item['x']}-{item['y']}" not in item["capability_id"]
        for item in repeated
    )


def test_durable_state_descriptor_omits_coordinates():
    grid = [[0 for _ in range(8)] for _ in range(8)]
    grid[1][1] = 2
    grid[7][5] = 3
    descriptor = arc_skill.semantic_state_descriptor(grid)
    assert "1,1" not in descriptor
    assert "5,7" not in descriptor
    assert "top-small-c2" in descriptor
    assert "bottom-small-c3" in descriptor


def test_transition_law_is_coordinate_free_and_partial():
    before = "objects=3;colors=2;control-target=dx+,dy0,distance=4"
    after = "objects=3;colors=2;control-target=dx+,dy0,distance=3"
    delta = arc_skill.semantic_transition_delta(before, after)
    assert delta["target_distance"] == -1
    assert arc_skill.prediction_agreement({"target_distance": -1}, delta) is True
    assert arc_skill.prediction_agreement({"object_count": -1}, delta) is False


def test_region_control_is_structural_not_click_only(monkeypatch):
    grid = [[0 for _ in range(10)] for _ in range(10)]
    monkeypatch.setattr(
        arc_skill,
        "_perceive",
        lambda rows: {"big_regions": [{"size": 3}]},
    )
    monkeypatch.setattr(
        arc_skill._MO,
        "candidate_controls",
        lambda rows: [(8, 1, 2, 4), (8, 3, 2, 4), (8, 5, 2, 4)],
    )
    assert arc_skill.classify([6, 7], grid) == "region-control"
    monkeypatch.setattr(arc_skill._MO, "candidate_controls", lambda rows: [])
    assert arc_skill.classify([6], grid) == "explore"


def test_directional_controls_prevent_region_router_preemption(monkeypatch):
    grid = [[0 for _ in range(10)] for _ in range(10)]
    monkeypatch.setattr(
        arc_skill,
        "_perceive",
        lambda rows: {"big_regions": [{"size": 20}]},
    )
    monkeypatch.setattr(
        arc_skill._MO,
        "candidate_controls",
        lambda rows: [(8, 1, 2, 4), (8, 3, 2, 4), (8, 5, 2, 4)],
    )
    assert arc_skill.classify([1, 2, 3, 4, 5, 6], grid) == "explore"
    assert arc_skill.classify([6, 7], grid) == "region-control"


def test_hypothesis_agreement_is_dynamics_evidence_not_success():
    contract = RecordingContract()
    skill = bare_skill(contract)
    before = "objects=3;colors=2;control-target=dx+,dy0,distance=4"
    after = "objects=3;colors=2;control-target=dx+,dy0,distance=3"
    skill._contract_last = (
        "ctx",
        "aiko-arc.hypothesis.navigate",
        before,
        0,
        (4, None, None),
        {"predicted_delta": {"target_distance": -1}},
    )
    skill._observe_contract_transition(Frame([[0]]), [[0]], "next")
    # Force the descriptor path directly because the tiny test grid cannot
    # encode the navigation relation used in the synthetic law.
    skill._contract_last = (
        "ctx",
        "aiko-arc.hypothesis.navigate",
        before,
        0,
        (4, None, None),
        {"predicted_delta": {"target_distance": -1}},
    )
    original = arc_skill.semantic_state_descriptor
    try:
        arc_skill.semantic_state_descriptor = lambda rows: after
        skill._observe_contract_transition(Frame([[0]]), [[0]], "next")
    finally:
        arc_skill.semantic_state_descriptor = original
    assert contract.observations == []
    assert contract.binary_observations[-1][-1] == 0.25


def test_installed_contract_muscle_round_trip():
    native = arc_skill.NativeContract()
    assert native.abi_version >= 4
    witness = uuid.uuid4().hex
    find_context = f"find source text {witness}"
    compile_context = f"compile native code {witness}"
    before = f"source tree {witness}"
    found = f"matching lines {witness}"
    built = f"built library {witness}"
    find_binary = f"rg-test-{witness}"
    compile_binary = f"zig-test-{witness}"
    assert native.observe_binary(find_context, find_binary, before, found, 1)
    assert native.observe_binary(compile_context, compile_binary, before, built, 1)
    # Recall is energy retrieval over the ACCUMULATED store, not exact
    # memoization: with a populated ledger an older, stronger prototype for the
    # same kind of context may legitimately rank first (e.g. a prior `rg-test`
    # binary outranks a freshly-observed `rg-test-<uuid>`). So we assert the
    # freshly-observed binary is RETRIEVABLE (present in the ranked candidate
    # set), not that it is #1. Exact cross-process persistence has its own
    # isolated-store witness (benchmarks/arc-agi3/jespa/witness_muscle_persistence.py).
    ranked = native.rank_binary(find_context, before=before, limit=64)
    if ranked is not None:
        binaries = {c["binary"] for c in ranked["candidates"]}
        assert find_binary in binaries, f"find_binary not retrievable: {ranked}"
    assert native.recall_binary(find_context)
    assert native.predict_binary(before, built)


class PlanningContract:
    def __init__(self, recalled=None, status="available_unverified"):
        self.recalled = recalled
        self.status = status

    def register_candidates(self, candidates):
        self.candidates = candidates

    def plan_candidates(self, context, candidates):
        return {
            "candidates": [
                {"capability_id": item["capability_id"], "status": "available_unverified"}
                | {"status": self.status}
                for item in candidates
            ]
        }

    def recall_binary(self, context):
        return self.recalled

    def rank_binary(self, context, limit=8):
        return {
            "candidates": [] if self.recalled is None else [{
                "binary": self.recalled,
                "successes": 1,
                "failures": 0,
                "context_energy": -0.95,
            }]
        }


def test_cold_candidates_are_bounded_and_balanced():
    contract = PlanningContract()
    skill = bare_skill(contract)
    rows = [[0, 0], [0, 1]]
    first = skill._contract_experiment("novel", [1, 2], rows)
    assert first[:2] == (1, None)
    skill._tried_proposals.add(skill._proposal_key(rows, *first[:3]))
    second = skill._contract_experiment("novel", [1, 2], rows)
    assert second[:2] == (2, None)
    skill._tried_proposals.add(skill._proposal_key(rows, *second[:3]))
    assert skill._contract_experiment("novel", [1, 2], rows) is None


def test_durable_recall_precedes_unverified_candidates():
    contract = PlanningContract(recalled="aiko-arc.action.2")
    skill = bare_skill(contract)
    result = skill._contract_experiment("similar", [1, 2], [[0]])
    assert result == (2, None, None, "contract-recall")


def test_global_verification_does_not_escape_its_semantic_context():
    contract = PlanningContract(status="verified_fresh")
    skill = bare_skill(contract)
    rows = [[0]]
    # With no locally grounded (context, capability) witness, verified status
    # degrades to a balanced cold experiment instead of global exploitation.
    first = skill._contract_experiment("novel-movement-state", [5, 2], rows)
    assert first[0] == 2
    assert first[3] == "contract-available_unverified"


def test_grounded_recall_resolves_without_opening_cold_candidates():
    contract = PlanningContract(recalled="aiko-arc.action.2")
    skill = bare_skill(contract)
    skill._grounded_contexts.add(("similar", "aiko-arc.action.2"))
    assert skill._contract_grounded_recall("similar", [1, 2], [[0]]) == (
        2,
        None,
        None,
        "contract-grounded-recall",
    )
    contract.recalled = None
    assert skill._contract_grounded_recall("novel", [1, 2], [[0]]) is None
