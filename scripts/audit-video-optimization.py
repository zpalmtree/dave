#!/usr/bin/env python3
"""Read-only production cost/latency audit; excludes prompts and Discord identities."""
import argparse
import json
import math
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


def summarize(values):
    values = sorted(value for value in values if value is not None and math.isfinite(value))
    return {"samples": len(values), "mean": sum(values) / len(values) if values else None,
            "median": values[max(0, math.ceil(len(values) * .5) - 1)] if values else None,
            "p95": values[max(0, math.ceil(len(values) * .95) - 1)] if values else None}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="/home/beach/.local/state/dave-video/queue.sqlite3")
    parser.add_argument("--since", default="2026-09-02")
    args = parser.parse_args()
    since = datetime.fromisoformat(args.since).replace(tzinfo=timezone.utc).timestamp()
    db = sqlite3.connect(Path(args.db).resolve().as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    job_columns = {row["name"] for row in db.execute("PRAGMA table_info(video_jobs)")}
    usage_columns = {row["name"] for row in db.execute("PRAGMA table_info(video_usage_events)")}
    variant = "COALESCE(command_variant, model)" if "command_variant" in job_columns else "model"
    jobs = [dict(row) for row in db.execute(f"SELECT public_id, {variant} AS command, status, created_at, updated_at"
                                         + (",requested_at" if "requested_at" in job_columns else "")
                                         + " FROM video_jobs WHERE created_at>=?", (since,))]
    usage = [dict(row) for row in db.execute("SELECT job_public_id, command, stage, cost"
                                          + (",pricing_status" if "pricing_status" in usage_columns else "")
                                          + " FROM video_usage_events WHERE created_at>=?", (since,))]
    costs = defaultdict(float)
    stages = defaultdict(float)
    unknown = 0
    for row in usage:
        costs[row["job_public_id"]] += row["cost"]
        stages[f'{row["command"]}:{row["stage"]}'] += row["cost"]
        unknown += row.get("pricing_status") in {"unknown_price", "usage_missing"}
    commands = {}
    for command in sorted({job["command"] for job in jobs}):
        rows = [job for job in jobs if job["command"] == command]
        commands[command] = {"jobs": len(rows), "status": {status: sum(job["status"] == status for job in rows)
                          for status in sorted({job["status"] for job in rows})},
                          "recorded_cost_usd_per_job": summarize([costs[job["public_id"]] for job in rows]),
                          "request_to_terminal_seconds": summarize([job["updated_at"] - job["requested_at"] for job in rows
                              if job.get("requested_at") and job["status"] == "delivered"])}
    known_jobs = {row[0] for row in db.execute("SELECT public_id FROM video_jobs")}
    result = {"schema_version": 1, "read_only": True, "since": args.since,
              "created_at": datetime.now(timezone.utc).isoformat(),
              "canonical_command_labels_available": "command_variant" in job_columns,
              "commands": commands, "recorded_usage_cost_usd": sum(row["cost"] for row in usage),
              "unpriced_or_missing_usage_events": unknown, "recorded_cost_by_command_and_stage": dict(stages),
              "orphan_submission_cost_usd": sum(row["cost"] for row in usage if row["job_public_id"] not in known_jobs),
              "limitations": ["Token-priced estimates, not a reconciled invoice.",
                              "Historical labels can combine OALGO, meximutt and MiniMax.",
                              "Terminal timestamp is the last job update; queue-inclusive latency is confounded by GPU wait."]}
    print(json.dumps(result, indent=2))
    db.close()


if __name__ == "__main__":
    main()
