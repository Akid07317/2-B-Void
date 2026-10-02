#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
task_python="${PYTHON:-python3}"
task_node="${NODE:-node}"

"$task_python" -m unittest discover -s tests -v
for task_script in planner/static/*.js design/motion-study/*.js design/motion-study/*.cjs tests/*.cjs; do
    "$task_node" --check "$task_script"
done
"$task_node" tests/test_time.cjs
