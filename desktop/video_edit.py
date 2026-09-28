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
import numpy as np
import subprocess
import sys
import tempfile
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
FUN_PATCH = "minimax_h3_fun_controlnet_union_2.0_pruned_int8_convrot.safetensors"
SAM_MODEL = "sam3.1_multiplex_fp16.safetensors"
MAX_SOURCE_SECONDS = 120
MIN_SOURCE_SECONDS = 0.5
MAX_SEGMENT_FRAMES = 15 * 24


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
    if not MIN_SOURCE_SECONDS <= duration <= MAX_SOURCE_SECONDS:
        raise RuntimeError(f"Video replacement supports {MIN_SOURCE_SECONDS}–{MAX_SOURCE_SECONDS} second clips")
    width, height = int(stream["width"]), int(stream["height"])
    if width < 32 or height < 32:
        raise RuntimeError("Source clip must be at least 32×32 pixels")
    return duration, width, height


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
    candidates = [(w, h) for w in range(32, min(width, limit_w) + 1, 32)
                  for h in range(32, min(height, limit_h) + 1, 32)]
    aspect_error = lambda size: abs(math.log((size[0] / size[1]) / (width / height)))
    close = [size for size in candidates if aspect_error(size) <= 0.02]
    return (max(close, key=lambda size: size[0] * size[1]) if close else
            min(candidates, key=lambda size: (aspect_error(size), -(size[0] * size[1]))))


def legal_frames(duration: float) -> int:
    needed = math.ceil(duration * 24)
    return max(124, 5 + math.ceil((needed - 5) / 17) * 17)


def segment_plan(duration: float) -> list[tuple[int, int, int]]:
    """Partition the 24 fps timeline without dropping or duplicating source frames."""
    total_frames = math.ceil(duration * 24)
    count = math.ceil(total_frames / MAX_SEGMENT_FRAMES)
    common, extra = divmod(total_frames, count)
    lengths = [common + (index < extra) for index in range(count)]
    result = []
    start = 0
    for length in lengths:
        result.append((start, length, legal_frames(length / 24)))
        start += length
    return result


def normalized_clip(source: Path, destination: Path, width: int, height: int, frames: int) -> None:
    command("ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(source),
            "-vf", f"fps=24,scale={width}:{height}:flags=lanczos,setsar=1,tpad=stop_mode=clone:stop_duration=1",
            "-frames:v", str(frames), "-an", "-c:v", "libx264", "-crf", "18",
            "-pix_fmt", "yuv420p", str(destination))


def segment_clip(source: Path, destination: Path, start: int, length: int,
                 model_frames: int) -> None:
    pad_seconds = max(1, math.ceil((model_frames - length) / 24) + 1)
    command("ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(source),
            "-vf", (f"trim=start_frame={start}:end_frame={start + length},"
                    f"setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration={pad_seconds}"),
            "-frames:v", str(model_frames), "-an", "-c:v", "libx264", "-crf", "18",
            "-pix_fmt", "yuv420p", str(destination))


def composite_segment(source: Path, rendered: Path, mask: Path,
                      destination: Path, source_frames: int) -> None:
    # The H3 result may drift outside the tracked subject. Keep every source
    # pixel beyond the expanded mask and emit only this segment's source frames.
    filter_graph = ("[2:v]format=gray," + ",".join(["dilation"] * 6) +
                    ",gblur=sigma=2[mask];[1:v][mask]alphamerge[edited];" +
                    "[0:v][edited]overlay=shortest=1:format=auto[v]")
    command("ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(source),
            "-i", str(rendered), "-i", str(mask), "-filter_complex", filter_graph,
            "-map", "[v]", "-frames:v", str(source_frames), "-an", "-c:v", "libx264",
            "-crf", "18", "-pix_fmt", "yuv420p", str(destination))


def join_segments(segments: list[Path], source: Path, destination: Path,
                  duration: float, directory: Path) -> None:
    listing = directory / "segments.txt"
    entries = []
    for path in segments:
        escaped = path.as_posix().replace("'", "'\\''")
        entries.append(f"file '{escaped}'\n")
    listing.write_text("".join(entries), encoding="utf-8")
    source_audio = audio_codec(source)
    command("ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "concat", "-safe", "0",
            "-i", str(listing), "-i", str(source), "-map", "0:v:0", "-map", "1:a:0?",
            "-t", f"{duration:.3f}", "-c:v", "copy",
            "-c:a", "copy" if source_audio == "aac" else "aac", "-b:a", "192k",
            "-movflags", "+faststart", str(destination))


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


def render_graph(clip_name: str, image_name: str, mask_name: str, direction: str,
                 width: int, height: int, frames: int, prefix: str) -> dict:
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
    graph["105:124"]["inputs"]["value"] = 40
    graph["105:16"]["inputs"]["model"] = ["patched_model", 0]
    graph["105:107"]["inputs"]["expression"] = str(frames)
    graph["105:104"] = node("MiniMaxH3ReferenceToVideo",
                            clip=["105:13", 0], vae=["105:11", 0],
                            audio_vae=["105:24", 0],
                            prompt=("<Picture 1> is the new subject in the masked region. "
                                    "Show that subject following the source shot's action, timing, camera movement, "
                                    f"lighting, and unmasked background. {direction}"),
                            width=width, height=height, length=frames, ref_image_size="match",
                            **{"ref_images.ref_image_0": ["replacement", 0]})
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


def mask_frame_coverages(path: Path) -> list[float]:
    """Count selected pixels, not encoded luma (limited-range black is 16)."""
    info = json.loads(command("ffprobe", "-v", "error", "-select_streams", "v:0",
                              "-show_entries", "stream=width,height", "-of", "json", str(path)))
    stream = info["streams"][0]
    frame_bytes = int(stream["width"]) * int(stream["height"])
    samples = []
    # Stream one grayscale frame at a time, keeping memory bounded for long clips.
    with tempfile.TemporaryFile() as errors:
        with subprocess.Popen(
            ["ffmpeg", "-nostdin", "-v", "error", "-i", str(path),
             "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
            stdout=subprocess.PIPE, stderr=errors,
        ) as process:
            while data := process.stdout.read(frame_bytes):
                if len(data) != frame_bytes:
                    raise RuntimeError("Tracked replacement mask ended mid-frame")
                samples.append(float(np.mean(np.frombuffer(data, dtype=np.uint8) > 127)))
            code = process.wait()
        if code:
            errors.seek(0)
            raise RuntimeError(f"Could not decode replacement mask: {errors.read()[-1000:].decode(errors='replace')}")
    if not samples:
        raise RuntimeError("Could not inspect the tracked replacement mask")
    return samples


def validate_tracking_mask(path: Path, target: str, source_frames: int) -> float:
    samples = mask_frame_coverages(path)
    if len(samples) < source_frames:
        raise RuntimeError("Tracked replacement mask is shorter than the source segment")
    # Model padding must not make a brief detection look like a stable track.
    samples = samples[:source_frames]
    coverage = float(np.mean(samples))
    tracked_fraction = sum(0.003 <= value <= 0.85 for value in samples) / len(samples)
    if not 0.003 <= coverage <= 0.85 or tracked_fraction < 0.5:
        raise RuntimeError(
            f"Could not reliably isolate '{target}' in the source clip "
            f"(selected pixels {coverage:.2%}; usable tracking in {tracked_fraction:.0%} of frames). "
            "Describe the subject's visible appearance and position instead of only a name. "
            "No replacement was rendered for this segment."
        )
    return coverage


def tracked_edit_mask(source: Path, destination: Path, width: int, height: int) -> None:
    """Give the replacement room to differ from the tracked object's outline."""
    with tempfile.TemporaryDirectory(prefix="video-edit-mask-") as directory:
        raw = Path(directory) / "tracked.gray"
        expanded = Path(directory) / "expanded.gray"
        command("ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(source),
                "-f", "rawvideo", "-pix_fmt", "gray", str(raw))
        frame_bytes = width * height
        with raw.open("rb") as incoming, expanded.open("wb") as outgoing:
            while data := incoming.read(frame_bytes):
                if len(data) != frame_bytes:
                    raise RuntimeError("Tracked replacement mask ended mid-frame")
                tracked = np.frombuffer(data, dtype=np.uint8).reshape(height, width) > 127
                frame = np.zeros((height, width), dtype=np.uint8)
                rows, columns = np.nonzero(tracked)
                if rows.size:
                    left, right = int(columns.min()), int(columns.max()) + 1
                    top, bottom = int(rows.min()), int(rows.max()) + 1
                    pad_x = max(24, round((right - left) * 0.15))
                    pad_y = max(24, min(96, round(max(bottom - top, right - left) * 0.25)))
                    frame[max(0, top - pad_y):min(height, bottom + pad_y),
                          max(0, left - pad_x):min(width, right + pad_x)] = 255
                outgoing.write(frame.tobytes())
        command("ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "rawvideo",
                "-pix_fmt", "gray", "-video_size", f"{width}x{height}",
                "-framerate", "24", "-i", str(expanded), "-an", "-c:v", "libx264",
                "-crf", "0", "-pix_fmt", "yuv420p", str(destination))


def rgb_frame(path: Path, seconds: float, width: int, height: int) -> np.ndarray:
    process = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{seconds:.3f}",
         "-i", str(path), "-frames:v", "1", "-vf", f"scale={width}:{height}",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=False,
    )
    if process.returncode or len(process.stdout) != width * height * 3:
        raise RuntimeError(f"Could not inspect video replacement: {process.stderr[-300:].decode(errors='replace')}")
    return np.frombuffer(process.stdout, dtype=np.uint8).reshape(height, width, 3)


def reject_blank_edit(rendered: Path, mask: Path, source: Path, reference: Path,
                      duration: float, width: int, height: int) -> None:
    reference_pixels = rgb_frame(reference, 0, 256, 256)
    if np.mean(np.max(reference_pixels, axis=2) < 25) >= 0.2:
        return
    blank_samples = 0
    for fraction in (0.25, 0.5, 0.75):
        second = duration * fraction
        selected = np.mean(rgb_frame(mask, second, width, height), axis=2) > 127
        if np.count_nonzero(selected) < width * height * 0.003:
            continue
        source_dark = np.mean(np.max(rgb_frame(source, second, width, height)[selected], axis=1) < 25)
        rendered_dark = np.mean(np.max(rgb_frame(rendered, second, width, height)[selected], axis=1) < 25)
        if source_dark < 0.35 and rendered_dark > 0.8:
            blank_samples += 1
    if blank_samples >= 2:
        raise RuntimeError("The model left the tracked subject nearly black. Try a reference with a closer shape or style.")


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
    segments = segment_plan(duration)
    run_id = uuid.uuid4().hex
    INPUT.mkdir(parents=True, exist_ok=True)
    normalized = INPUT / f"video-edit-{run_id}.mp4"
    replacement = INPUT / f"video-edit-{run_id}{args.image.suffix.lower()}"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    try:
        print("Normalizing source clip", flush=True)
        normalized_clip(args.clip, normalized, width, height, math.ceil(duration * 24))
        replacement.write_bytes(args.image.read_bytes())
        with tempfile.TemporaryDirectory(prefix="video-edit-", dir=args.output.parent) as temporary:
            directory = Path(temporary)
            edited_segments = []
            for index, (start, source_frames, model_frames) in enumerate(segments, start=1):
                clip = INPUT / f"video-edit-{run_id}-{index}.mp4"
                mask_input = INPUT / f"video-edit-mask-{run_id}-{index}.mp4"
                try:
                    print(f"Generating replacement segment {index}/{len(segments)}", flush=True)
                    segment_clip(normalized, clip, start, source_frames, model_frames)
                    print("Tracking replacement target with SAM3", flush=True)
                    mask_file = run_graph(args.server, segmentation_graph(clip.name, args.target,
                                           f"video/edits/{run_id}-{index}-mask"), "save_mask", 1800)
                    coverage = validate_tracking_mask(mask_file, args.target, source_frames)
                    print(f"Validated tracked subject: {coverage:.2%} selected pixels", flush=True)
                    tracked_edit_mask(mask_file, mask_input, width, height)
                    print("Rendering masked replacement with MiniMax H3", flush=True)
                    rendered = run_graph(args.server, render_graph(clip.name, replacement.name,
                                         mask_input.name, args.prompt, width, height,
                                         model_frames, f"video/edits/{run_id}-{index}-render"), "92", 7200)
                    reject_blank_edit(rendered, mask_input, clip, args.image,
                                      source_frames / 24, width, height)
                    edited = directory / f"segment-{index:02d}.mp4"
                    composite_segment(clip, rendered, mask_input, edited, source_frames)
                    edited_segments.append(edited)
                    print(f"Completed segment {index}/{len(segments)}", flush=True)
                finally:
                    clip.unlink(missing_ok=True)
                    mask_input.unlink(missing_ok=True)
            print("Joining edited segments and restoring original soundtrack", flush=True)
            join_segments(edited_segments, args.clip, args.output, duration, directory)
        if not args.output.is_file() or args.output.stat().st_size == 0:
            raise RuntimeError("Video replacement produced no output")
        print(f"Video replacement ready: {args.output}", flush=True)
    finally:
        normalized.unlink(missing_ok=True)
        replacement.unlink(missing_ok=True)


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
