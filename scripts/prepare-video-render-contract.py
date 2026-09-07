#!/usr/bin/env python3
"""Freeze production H3 scene compilation without starting any model or GPU process."""
import argparse
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--generator", type=Path, default=Path("/mnt/d/AI/ComfyUI_windows_portable/video_gen/video_gen.py"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    spec = json.loads(args.spec.read_text())
    module_spec = importlib.util.spec_from_file_location("video_gen", args.generator)
    gen = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(gen)
    images = [(int(index), Path(path).resolve()) for index, path in spec.get("segment_keyframes", {}).items()]
    image = Path(spec["keyframe_path"]).resolve() if spec.get("keyframe_path") else None
    duration = spec.get("requested_duration")
    plan = gen.load_frontier_video_plan(Path(spec["plan_path"]), spec["prompt"], duration, ("h3",))
    if not images:
        plan = gen.auto_split_h3_kinetic_segment(plan, spec["prompt"])
    args.output.mkdir(parents=True, exist_ok=True)
    plan_path = (args.output / "frozen-plan.json").resolve()
    plan_path.write_text(json.dumps(plan, indent=2) + "\n")
    # Exercise the same reload/normalization the renderer will use.
    loaded = gen.load_frontier_video_plan(plan_path, spec["prompt"], duration, ("h3",))
    gen.validate_segment_keyframe_targets(loaded, dict(images))
    inputs = SimpleNamespace(frontier_plan=plan_path, image=image, segment_keyframe=images,
                             prompt=spec["prompt"], seed=spec["seed"], aspect=spec.get("aspect", "auto"), duration=duration)
    compiled = gen.prepare_model_segments("unused", loaded, "h3", "frozen-image" if image else None,
                                          {index: str(path) for index, path in images}, duration is None, 1)
    contract = {"schema_version": 1, "inputs": gen.experiment_input_identity(inputs), "compiled_h3": compiled}
    contract_path = (args.output / "contract.json").resolve()
    contract_path.write_text(json.dumps(contract, indent=2) + "\n")
    render_spec = {**spec, "plan_path": str(plan_path), "contract_path": str(contract_path),
                   "aspect": contract["inputs"]["aspect"]}
    (args.output / "render-spec.json").write_text(json.dumps(render_spec, indent=2) + "\n")
    print(json.dumps({"contract": str(contract_path), "segments": len(compiled),
                      "frames": [segment["frame_count"] for segment in compiled]}))


if __name__ == "__main__":
    main()
