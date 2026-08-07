import subprocess, pathlib, json, tempfile, os
cell = pathlib.Path(__file__).parent.parent
def run(*args):
    return subprocess.run(["python3","run.py",*args], cwd=str(cell), capture_output=True, text=True)
def test_builds():
    for p in ["example/hello.cell.yaml","example/pipeline.cell.yaml","system/builder.cell.yaml","primitives/session.cell.yaml","primitives/auth.cell.yaml","primitives/request.cell.yaml","patterns/api-reveng/api-reveng.cell.yaml"]:
        r = run("build", p)
        assert r.returncode==0, f"build {p}: {r.stderr}"
def test_runs():
    inputs = {
        "patterns/prompt-cell/classify.cell.yaml": {"ticket":{"text":"refund please"}},
        "patterns/context-cell/context.cell.yaml": {"query":"battery?"},
        "patterns/loop-cell/loop.cell.yaml": {"ticket":{"text":"battery issue"},"capacity":{"available_pct":90}},
        "patterns/graph-cell/graph.cell.yaml": {"query":"battery refund"},
        "example/pipeline.cell.yaml": json.loads(pathlib.Path("example/inputs.json").read_text()),
    }
    for path, inp in inputs.items():
        inp_file = pathlib.Path(tempfile.mktemp(suffix=".json"))
        inp_file.write_text(json.dumps(inp))
        r = run("run", path, "--inputs", str(inp_file), "--out", tempfile.mkdtemp())
        assert r.returncode==0, f"run {path}: {r.stderr}"
        inp_file.unlink(missing_ok=True)
def test_primitives_compose():
    inp = {"base_url":"https://api.example.com","credentials":{"token":"t"},"path":"/orders/1"}
    f = pathlib.Path(tempfile.mktemp(suffix=".json"))
    f.write_text(json.dumps(inp))
    r = run("run","patterns/api-reveng/api-reveng.cell.yaml","--inputs",str(f),"--out",tempfile.mkdtemp())
    assert r.returncode==0, r.stderr
    f.unlink(missing_ok=True)
def test_builder_self_hosts():
    f = pathlib.Path(tempfile.mktemp(suffix=".json"))
    f.write_text(json.dumps({"root":"system/builder.cell.yaml"}))
    r = run("run","system/builder.cell.yaml","--inputs",str(f),"--out",tempfile.mkdtemp())
    assert r.returncode==0, r.stderr
    f.unlink(missing_ok=True)
