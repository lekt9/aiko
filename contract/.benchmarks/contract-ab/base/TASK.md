# Task

Repair and complete `run_graph` in `scheduler.py`.

The function executes an asynchronous dependency graph and returns a
`RunResult`. Its required behavior is:

1. Reject malformed graphs before calling `worker`:
   - every dependency must name a known task;
   - a task cannot depend on itself;
   - cycles raise `CycleError`, whose `cycle` contains a closed path
     (`cycle[0] == cycle[-1]`).
2. Run a task only after all of its dependencies succeeded.
3. Never exceed `concurrency`; reject values below 1.
4. Choose ready work deterministically in lexicographic task-name order.
5. A worker exception fails that task but does not abort independent branches.
6. Tasks transitively dependent on a failed task are marked `skipped` and are
   never passed to `worker`.
7. Resume from `prior` results:
   - prior `succeeded` tasks with an output are reused and not rerun;
   - all other prior states are eligible to run again;
   - unknown prior task names are ignored.
8. Return every task exactly once across `succeeded`, `failed`, and `skipped`.
   `outputs` contains succeeded tasks only, including reused outputs.

Do not change the public classes or function signature. Use only the Python
standard library. Add tests where useful.
