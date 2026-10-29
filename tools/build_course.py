#!/usr/bin/env python3
"""Build static course scripts from the audited DOCX extraction and audio manifest.

Normal builds require a verified recording and word timings for every example.
--allow-pending-audio is only for local UI work while media is being prepared.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
TOKENS = re.compile(r"[A-Za-z]+(?:[’'-][A-Za-z]+)*|\d+(?:,\d{3})*")


def normalize(word):
    return word.lower().replace("’", "'")


def canonical_objects(value):
    """Match sorted JS objects, whose integer property keys enumerate first."""
    if isinstance(value, list):
        return [canonical_objects(item) for item in value]
    if isinstance(value, dict):
        def order(key):
            if key.isdecimal() and str(int(key)) == key and 0 <= int(key) < 2 ** 32 - 1:
                return 0, int(key)
            return 1, key
        return {key: canonical_objects(value[key]) for key in sorted(value, key=order)}
    return value


def build(input_path, allow_pending=False):
    source = json.loads(input_path.read_text())
    manifest_path = ROOT / "audio/course-examples/manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"units": {}}
    lists, timings, pending = {}, {}, []
    verified = set()
    count = source["counts"]["units"]
    assert 1 <= count <= 120
    assert set(source["units"]) == {str(n) for n in range(1, count + 1)}
    baseline_path = ROOT / "data/preserved-units1-32.json"
    baseline = json.loads(baseline_path.read_text()) if source["source"].get("preservedExtraction") else None
    keep_through = baseline["keepThrough"] if baseline else 0
    protected_audio = set()
    for number, unit in source["units"].items():
        assert len(unit["vocabulary"]) == len(unit["examples"]) == 15, number
        vocabulary = [{key: word[key] for key in ("word", "ipa", "partsOfSpeech", "meaning")}
                      for word in unit["vocabulary"]]
        examples = []
        recordings = manifest.get("units", {}).get(number, [])
        for index, example in enumerate(unit["examples"]):
            item = {key: example[key] for key in ("text", "translation", "source", "speechText", "annotations", "targetForms")}
            cursor = 0
            for note in item["annotations"]:
                assert cursor <= note["start"] < note["end"] <= len(item["text"])
                assert item["text"][note["start"]:note["end"]] == note["text"]
                cursor = note["end"]
            recording = recordings[index] if index < len(recordings) else None
            if not recording:
                pending.append(f"Unit {number}, example {index + 1}")
                item["audio"] = ""
            else:
                assert recording["speechText"] == item["speechText"], (number, index, "speech text differs")
                audio = recording["audio"]
                path = (ROOT / audio).resolve()
                assert path.is_relative_to(ROOT) and path.is_file(), audio
                if audio not in verified:
                    assert hashlib.sha256(path.read_bytes()).hexdigest() == recording["sha256"], audio
                    verified.add(audio)
                expected = [normalize(word) for word in TOKENS.findall(item["speechText"])]
                words = recording["words"]
                assert [normalize(word["text"]) for word in words] == expected, (number, index, "word timings differ")
                for i, word in enumerate(words):
                    assert 0 <= word["start"] < word["end"] <= recording["duration"] + .15, (audio, word)
                    if i:
                        assert word["start"] >= words[i - 1]["end"] - .001, (audio, "overlapping timings")
                # Added units may reuse recordings. Keep the existing units'
                # browser timing records when later source text uses a variant.
                if int(number) <= keep_through or audio not in protected_audio:
                    timings[audio] = {"sha256": recording["sha256"], "words": words,
                                      "provider": recording.get("provider"), "voice": recording.get("voice")}
                if int(number) <= keep_through:
                    protected_audio.add(audio)
                item["audio"] = audio
            examples.append(item)
        lists[number] = {"vocabulary": vocabulary, "examples": examples}
    if pending and not allow_pending:
        raise ValueError(f"{len(pending)} examples still need verified audio; first: {pending[0]}")
    if baseline:
        original = ROOT / baseline["canonicalSource"]
        assert hashlib.sha256(original.read_bytes()).hexdigest() == baseline["canonicalSourceSha256"], "Preserved source changed"
        preserved = {str(n): lists[str(n)] for n in range(1, keep_through + 1)}
        canonical = json.dumps(canonical_objects(preserved), ensure_ascii=False, separators=(",", ":"))
        assert hashlib.sha256(canonical.encode()).hexdigest() == baseline["runtimeUnitsSha256"], "Existing units changed"
    course = {"title": "海纳教育·英语重点词点读", "totalLists": 120, "source": source["source"], "lists": lists}
    compact = {"ensure_ascii": False, "separators": (",", ":")}
    (ROOT / "content.js").write_text(f"// Document-backed Units 1–{count}; generated by tools/build_course.py.\nwindow.COURSE = " + json.dumps(course, **compact) + ";\n")
    (ROOT / "sentence-timings.js").write_text("// Recorded/generated sentence timing provenance: audio/course-examples/manifest.json.\nwindow.SENTENCE_TIMINGS = " + json.dumps(timings, **compact) + ";\n")
    print(json.dumps({"units": len(lists), "vocabulary": sum(len(u["vocabulary"]) for u in lists.values()),
                      "examples": sum(len(u["examples"]) for u in lists.values()),
                      "verified_unique_recordings": len(verified), "pending_audio": len(pending)}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=ROOT / "data/course-units1-120.json")
    parser.add_argument("--allow-pending-audio", action="store_true")
    args = parser.parse_args()
    build(args.input, args.allow_pending_audio)
