#!/usr/bin/env python3
"""固定调用官方 SWE-bench TestSpec、eval-script 与 grading 的窄适配器。"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from swebench.harness.grading import get_eval_report
from swebench.harness.utils import make_test_spec


def load_payload() -> dict:
    """从 stdin 读取 TypeScript runner 提供的单个 JSON 请求。"""
    return json.load(sys.stdin)


def instance_from_task(task: dict) -> dict:
    """把仓库 task schema 映射为官方 make_test_spec 所需字段。"""
    return {
        "instance_id": task["id"],
        "image": task["image"],
        "repo": task["repo"],
        "version": task["version"],
        "FAIL_TO_PASS": task["failToPass"],
        "PASS_TO_PASS": task["passToPass"],
        "log_parser": task["logParser"],
        "eval_type": task["evalType"],
        "eval_script": task["evalScript"],
    }


def main() -> int:
    """执行 prepare 或 grade，判分真值完全交给固定版本官方包。"""
    payload = load_payload()
    test_spec = make_test_spec(instance_from_task(payload["task"]))
    action = payload["action"]
    if action == "prepare":
        json.dump({"evalScript": test_spec.eval_script}, sys.stdout)
        return 0
    if action == "grade":
        prediction = {
            "instance_id": test_spec.instance_id,
            "model_name_or_path": "minicode",
            "model_patch": payload["modelPatch"],
        }
        report = get_eval_report(
            test_spec,
            prediction,
            str(Path(payload["evaluationLog"])),
            include_tests_status=True,
        )
        json.dump(report, sys.stdout)
        return 0
    raise ValueError(f"unsupported action: {action}")


if __name__ == "__main__":
    raise SystemExit(main())
