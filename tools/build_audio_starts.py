#!/usr/bin/env python3
"""Audit safe playback starts without rewriting any source recording.

Only near-zero leading PCM samples are skipped, with at least 80 ms left before
the first detected activity. Starts are content-bound to each original file.
Run --check to verify the saved audit/source checksums without decoding again.
"""

import argparse
import array
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys

from build_course import ROOT, read_dictionary

OUTPUT = ROOT / "data/audio-starts.json"
SOURCE_PATHS = ("dictionary.js", "audio/course-examples/manifest.json")
ALGORITHM = {
    "name": "first-near-zero-peak-with-conservative-preroll-v1",
    "sampleRate": 48000,
    "channels": 2,
    "peakThresholdPcm16": 10,
    "prerollSeconds": 0.08,
    "maxStartSeconds": 0.45,
    "scanSeconds": 0.8,
    "minActivitySeconds": 0.01,
    "rounding": "floor-to-millisecond",
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def scope():
    words = {entry["audio"] for entry in read_dictionary().values() if entry.get("audio")}
    manifest = json.loads((ROOT / SOURCE_PATHS[1]).read_text())
    sentences = {row["audio"] for rows in manifest["units"].values() for row in rows}
    paths = sorted(words | sentences)
    for relative in paths:
        path = (ROOT / relative).resolve()
        if not path.is_relative_to(ROOT) or not path.is_file():
            raise ValueError(f"Missing or invalid source recording: {relative}")
    return paths, words, sentences


def decode_prefix(path):
    # Preserve stereo channels instead of summing them: cancellation must never
    # hide an early phoneme. Mono input is duplicated by ffmpeg, not rewritten.
    result = subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-threads", "1",
        "-i", str(path), "-t", str(ALGORITHM["scanSeconds"]),
        "-filter_threads", "1", "-ac", "2", "-ar", "48000",
        "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1",
    ], capture_output=True, check=True, timeout=20)
    samples = array.array("h")
    samples.frombytes(result.stdout)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def analyze(relative):
    path = ROOT / relative
    sha = digest(path)
    pcm = decode_prefix(path)
    threshold = ALGORITHM["peakThresholdPcm16"]
    # Either channel is enough to preserve the earliest detectable activity.
    first = next((i // 2 for i, value in enumerate(pcm) if abs(value) > threshold), None)
    if first is None:
        return relative, sha, None
    # An isolated near-zero decoder artefact may reduce the possible saving, but
    # it can never move the start past an earlier low-volume consonant. Requiring
    # a later 10 ms active block only rejects empty/noise-like snippets.
    frame_size = int(ALGORITHM["sampleRate"] * ALGORITHM["minActivitySeconds"]) * 2
    has_activity = any(
        math.sqrt(sum(value * value for value in pcm[offset:offset + frame_size]) / frame_size) > threshold
        for offset in range(0, len(pcm) - frame_size + 1, frame_size)
    )
    first_seconds = first / ALGORITHM["sampleRate"]
    start = max(0, min(ALGORITHM["maxStartSeconds"], first_seconds - ALGORITHM["prerollSeconds"]))
    start = math.floor((start + 1e-10) * 1000) / 1000
    if not has_activity or start < 0.01:
        return relative, sha, None
    assert start + ALGORITHM["prerollSeconds"] <= first_seconds + 1e-8
    # The interval actually skipped must contain only near-zero samples.
    skipped = pcm[:int(start * ALGORITHM["sampleRate"]) * 2]
    assert all(abs(value) <= threshold for value in skipped)
    return relative, sha, {"sha256": sha, "start": start, "firstActivity": round(first_seconds, 6)}


def source_hashes():
    return {relative: digest(ROOT / relative) for relative in SOURCE_PATHS}


def scope_digest(hashes):
    return hashlib.sha256(json.dumps(hashes, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def verify(report):
    paths, _, _ = scope()
    assert report["version"] == 1 and report["algorithm"] == ALGORITHM
    assert report["sources"] == source_hashes(), "Audio source manifests changed; regenerate starts"
    hashes = {relative: digest(ROOT / relative) for relative in paths}
    assert report["sourceScopeSha256"] == scope_digest(hashes), "Source audio changed; regenerate starts"
    assert set(report["files"]).issubset(hashes)
    for relative, row in report["files"].items():
        assert row["sha256"] == hashes[relative], relative
        assert 0 < row["start"] <= ALGORITHM["maxStartSeconds"], relative
        assert row["start"] + ALGORITHM["prerollSeconds"] <= row["firstActivity"] + 1e-6, relative
    print(json.dumps({"audio_start_audit": "verified", **report["counts"]}), flush=True)


def build(workers):
    paths, words, sentences = scope()
    starts, hashes = {}, {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for index, (relative, sha, row) in enumerate(pool.map(analyze, paths), 1):
            hashes[relative] = sha
            if row is not None:
                starts[relative] = row
            if index % 500 == 0:
                print(f"Audited {index}/{len(paths)} recordings", flush=True)
    report = {
        "version": 1, "algorithm": ALGORITHM, "sources": source_hashes(),
        "sourceScopeSha256": scope_digest(hashes),
        "counts": {"audioFiles": len(paths), "positiveStarts": len(starts),
                   "wordAudioFiles": len(words), "sentenceAudioFiles": len(sentences)},
        "files": starts,
    }
    verify(report)
    OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        verify(json.loads(OUTPUT.read_text()))
    else:
        if not 1 <= args.workers <= 6:
            parser.error("--workers must be between 1 and 6")
        build(args.workers)
