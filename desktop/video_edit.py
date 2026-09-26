"""Generic MiniMax H3 source-video subject replacement.

The source clip, replacement image, and text target are independent inputs. SAM3
tracks the named subject; H3 Ref2VA and Fun ControlNet regenerate its mask while
the source video controls the surrounding timeline. Delivery keeps source audio.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
COMFY = ROOT.parent / "ComfyUI"
INPUT = COMFY / "input"
OUTPUT = COMFY / "output"
TEMPLATE = ROOT / "templates" / "h3_i2v.json"
REF_MODEL = "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
FUN_PATCH = "minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors"
SAM_MODEL = "sam3.1_multiplex_fp16.safetensors"


def required_models() -> None:
    for category, name in (("diffusion_models", REF_MODEL),
                           ("model_patches", FUN_PATCH), ("checkpoints", SAM_MODEL)):
        if not (COMFY / "models" / category / name).is_file():
            raise RuntimeError(f"Video replacement model is missing: {category}/{name}")


def command(*parts: str) -> str:
    process = subprocess.run(parts, text=True, capture_output=True, check=False)
    if process.returncode:
        raise RuntimeError(f"{parts[0]} failed: {process.stderr[-1000:]}")
    return process.stdout


def clip_details(path: Path) -> tuple[float, int, int]:
    info = json.loads(command("ffprobe", "-v", "error", "-select_streams", "v:0",
                              "-show_entries", "stream=width,height:format=duration", "-of", "json", str(path)))
    stream = (info.get("streams") or [None])[0]
    if not stream:
        raise RuntimeError("Source clip has no video stream")
    duration = float(info["format"]["duration"])
    if not 5 <= duration <= 15:
        raise RuntimeError("Video replacement supports 5–15 second clips")
    return duration, int(stream["width"]), int(stream["height"])


def audio_codec(path: Path) -> str | None:
    info = json.loads(command("ffprobe", "-v", "error", "-select_streams", "a:0",
                              "-show_entries", "stream=codec_name", "-of", "json", str(path)))
    stream = (info.get("streams") or [None])[0]
    return stream.get("codec_name") if stream else None


def canvas(width: int, height: int) -> tuple[int, int]:
    # Ref2VA carries an entire clip and a mask alongside H3; keep enough VRAM
    # for those extra tokens on the 32 GiB desktop card.
    long_edge, short_edge = (896, 512)
    limit_w, limit_h = (long_edge, short_edge) if width >= height else (short_edge, long_edge)
    scale = min(1.0, limit_w / width, limit_h / height)
    return max(32, int(width * scale) // 32 * 32), max(32, int(height * scale) // 32 * 32)


def legal_frames(duration: float) -> int:
    needed = math.ceil(duration * 24)
    return max(124, 5 + math.ceil((needed - 5) / 17) * 17)


def normalized_clip(source: Path, destination: Path, width: int, height: int, frames: int) -> None:
    command("ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(source),
            "-vf", f"fps=24,scale={width}:{height}:flags=lanczos,tpad=stop_mode=clone:stop_duration=1",
            "-frames:v", str(frames), "-an", "-c:v", "libx264", "-crf", "18",
            "-pix_fmt", "yuv420p", str(destination))


def node(kind: str, **inputs):
    return {"class_type": kind, "inputs": inputs}


def segmentation_graph(clip_name: str, target: str, prefix: str) -> dict:
    return {
        "source": node("LoadVideo", file=clip_name),
        "frames": node("GetVideoComponents", video=["source", 0]),
        "sam": node("CheckpointLoaderSimple", ckpt_name=SAM_MODEL),
        "target": node("CLIPTextEncode", clip=["sam", 1], text=target),
        "track": node("SAM3_VideoTrack", images=["frames", 0], model=["sam", 0],
                      conditioning=["target", 0], detection_threshold=0.5,
                      max_objects=4, detect_interval=12),
        "mask": node("SAM3_TrackToMask", track_data=["track", 0], object_indices=""),
        "mask_image": node("MaskToImage", mask=["mask", 0]),
        "mask_video": node("CreateVideo", images=["mask_image", 0], fps=24.0, bit_depth=8),
        "save_mask": node("SaveVideo", video=["mask_video", 0], filename_prefix=prefix,
                          format="auto", codec="auto"),
    }


def render_graph(clip_name: str, image_name: str, mask_name: str, target: str,
                 direction: str, width: int, height: int, frames: int, prefix: str) -> dict:
    graph = copy.deepcopy(json.loads(TEMPLATE.read_text(encoding="utf-8")))
    for name in ("114", "119", "120", "115", "105:121", "105:122",
                 "105:123", "105:125", "105:126"):
        graph.pop(name, None)
    graph["105:6"]["inputs"]["unet_name"] = REF_MODEL
    graph["source"] = node("LoadVideo", file=clip_name)
    graph["source_frames"] = node("GetVideoComponents", video=["source", 0])
    graph["replacement"] = node("LoadImage", image=image_name)
    graph["mask_source"] = node("LoadVideo", file=mask_name)
    graph["mask_frames"] = node("GetVideoComponents", video=["mask_source", 0])
    graph["mask"] = node("ImageToMask", image=["mask_frames", 0], channel="red")
    graph["patch_loader"] = node("ModelPatchLoader", name=FUN_PATCH)
    graph["patched_model"] = node("MiniMaxH3FunControlNetApply", model=["105:6", 0],
                                  model_patch=["patch_loader", 0], vae=["105:11", 0],
                                  strength=1.0, start_percent=0.0, end_percent=1.0,
                                  mask=["mask", 0], source_video=["source_frames", 0])
    graph["105:9"]["inputs"]["model"] = ["patched_model", 0]
    graph["105:9"]["inputs"]["steps"] = ["105:124", 0]
    graph["105:16"]["inputs"]["model"] = ["patched_model", 0]
    graph["105:107"]["inputs"]["expression"] = str(frames)
    graph["105:104"] = node("MiniMaxH3ReferenceToVideo",
                            clip=["105:13", 0], vae=["105:11", 0],
                            audio_vae=["105:24", 0],
                            prompt=(f"<Video 1> is the source shot. Replace {target} with the subject in "
                                    f"<Picture 1>. Keep the source shot's action, timing, camera movement, "
                                    f"lighting, and unmasked background. {direction}"),
                            width=width, height=height, length=frames, ref_image_size="match",
                            **{"ref_images.ref_image_0": ["replacement", 0],
                               "ref_videos.ref_video_0": ["source_frames", 0]})
    graph["92"]["inputs"]["filename_prefix"] = prefix
    return graph


def api(server: str, route: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(server + route, data=data,
                                     headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"ComfyUI rejected {route}: {error.read(2000).decode(errors='replace')}") from error


def run_graph(server: str, graph: dict, output_node: str, timeout: float) -> Path:
    response = api(server, "/prompt", {"prompt": graph, "client_id": "video-edit-" + uuid.uuid4().hex})
    prompt_id = response.get("prompt_id")
    if not prompt_id:
        raise RuntimeError(f"ComfyUI returned no prompt ID: {response}")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        history = api(server, f"/history/{prompt_id}").get(prompt_id)
        if history:
            for message in history.get("status", {}).get("messages", []):
                if message[0] == "execution_error":
                    raise RuntimeError(str(message[1].get("exception_message", "ComfyUI execution failed")))
            if history.get("status", {}).get("completed"):
                files = history.get("outputs", {}).get(output_node, {}).get("images", [])
                files += history.get("outputs", {}).get(output_node, {}).get("gifs", [])
                files += history.get("outputs", {}).get(output_node, {}).get("videos", [])
                for item in files:
                    path = OUTPUT / item.get("subfolder", "") / item["filename"]
                    if path.is_file():
                        return path
                raise RuntimeError("ComfyUI completed without saving the edited video")
        time.sleep(5)
    raise TimeoutError("ComfyUI video replacement timed out")


def mask_coverage(path: Path) -> float:
    values = command("ffmpeg", "-nostdin", "-v", "error", "-i", str(path),
                     "-vf", "signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=-",
                     "-f", "null", "-")
    samples = [float(value) for value in re.findall(r"lavfi\.signalstats\.YAVG=([\d.]+)", values)]
    if not samples:
        raise RuntimeError("Could not inspect the tracked replacement mask")
    return sum(samples) / len(samples) / 255


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--clip", type=Path, required=True)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--error-file", type=Path)
    parser.add_argument("--server", default="http://127.0.0.1:8188")
    args = parser.parse_args()
    required_models()
    duration, source_w, source_h = clip_details(args.clip)
    width, height = canvas(source_w, source_h)
    frames = legal_frames(duration)
    run_id = uuid.uuid4().hex
    INPUT.mkdir(parents=True, exist_ok=True)
    normalized = INPUT / f"video-edit-{run_id}.mp4"
    replacement = INPUT / f"video-edit-{run_id}{args.image.suffix.lower()}"
    mask_input = INPUT / f"video-edit-mask-{run_id}.mp4"
    try:
        print("Normalizing source clip", flush=True)
        normalized_clip(args.clip, normalized, width, height, frames)
        replacement.write_bytes(args.image.read_bytes())
        print("Tracking replacement target with SAM3", flush=True)
        mask_file = run_graph(args.server, segmentation_graph(normalized.name, args.target,
                               f"video/edits/{run_id}-mask"), "save_mask", 1800)
        coverage = mask_coverage(mask_file)
        if coverage < 0.003 or coverage > 0.85:
            raise RuntimeError(f"Could not isolate '{args.target}' in the source clip (mask coverage {coverage:.1%}).")
        mask_input.write_bytes(mask_file.read_bytes())
        print("Rendering masked replacement with MiniMax H3", flush=True)
        rendered = run_graph(args.server, render_graph(normalized.name, replacement.name,
                             mask_input.name, args.target, args.prompt, width, height,
                             frames, f"video/edits/{run_id}-render"), "92", 7200)
        print("Restoring original soundtrack", flush=True)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        source_audio = audio_codec(args.clip)
        # The diffusion output can drift outside the tracked object. Composite
        # through the tracked mask so every other source pixel remains intact.
        filter_graph = ("[2:v]format=gray," + ",".join(["dilation"] * 6) +
                        ",gblur=sigma=2[mask];[1:v][mask]alphamerge[edited];" +
                        "[0:v][edited]overlay=shortest=1:format=auto[v]")
        command("ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(normalized),
                "-i", str(rendered), "-i", str(mask_file), "-i", str(args.clip),
                "-filter_complex", filter_graph, "-map", "[v]", "-map", "3:a:0?",
                "-t", f"{duration:.3f}", "-c:v", "libx264", "-crf", "18",
                "-pix_fmt", "yuv420p", "-c:a", "copy" if source_audio == "aac" else "aac",
                "-b:a", "192k",
                "-movflags", "+faststart", str(args.output))
        if not args.output.is_file() or args.output.stat().st_size == 0:
            raise RuntimeError("Video replacement produced no output")
        print(f"Video replacement ready: {args.output}", flush=True)
    finally:
        normalized.unlink(missing_ok=True)
        replacement.unlink(missing_ok=True)
        mask_input.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        if "--error-file" in sys.argv:
            try:
                path = Path(sys.argv[sys.argv.index("--error-file") + 1])
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(str(error)[:1000], encoding="utf-8")
            except (IndexError, OSError):
                pass
        raise
