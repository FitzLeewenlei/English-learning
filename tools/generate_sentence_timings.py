#!/usr/bin/env python3
"""Generate offline word timings for the recorded List 1 example sentences.

Build-time requirements (no browser/runtime dependencies):
  Python 3.10+, ffmpeg on PATH, and pocketsphinx==5.1.1 with its bundled
  en-US acoustic model and pronunciation dictionary. The British recordings
  and synthetic speech may differ from that model, so boundaries remain
  approximate. Each output entry records the exact source MP3 SHA-256.

Example isolated installation and regeneration from the repository root:
  python3 -m venv /tmp/english-sentence-aligner
  CC=gcc CXX=g++ CMAKE_BUILD_PARALLEL_LEVEL=2 \
    /tmp/english-sentence-aligner/bin/python -m pip install pocketsphinx==5.1.1
  /tmp/english-sentence-aligner/bin/python tools/generate_sentence_timings.py

Use --check to rerun alignment and verify the checked-in data without writing.
Model decoding runs twice: known-word alignment, then subword refinement.
Punctuation is excluded from acoustic alignment. Numbers, hyphenated words and
MWC are expanded to the recorded spoken words and regrouped for display.
"""

import argparse
import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import re
import shutil
import subprocess
from tempfile import TemporaryDirectory

from pocketsphinx import Decoder

TOKEN_PATTERN = re.compile(r"[A-Za-z]+(?:[’'-][A-Za-z]+)*|\d+(?:,\d{3})*")
EXPANSIONS = {
    "1988": ["nineteen", "eighty", "eight"],
    "25,000": ["twenty", "five", "thousand"],
    "200": ["two", "hundred"],
    "10": ["ten"],
    "mwc": ["m", "w", "c"],
}
# Nishinari's is absent from the bundled CMU dictionary. ARPAbet phones express
# an approximate English reading of this Japanese surname and its possessive.
CUSTOM_PRONUNCIATIONS = {"nishinari's": "N IH SH IH N AA R IY Z"}
SILENCE_WORDS = {"<sil>", "<s>", "</s>", "[SPEECH]", "[NOISE]"}
HEADER = "// PocketSphinx 5.1.1 two-pass forced alignment; tools/generate_sentence_timings.py; approximate boundaries for the exact MP3 checksums below.\n"


def normalize(word):
    return word.lower().replace("’", "'")


def expand_words(tokens):
    return [EXPANSIONS.get(normalize(token), normalize(token).split("-")) for token in tokens]


def align_sentence(root, sentence, raw_path):
    audio_path = root / sentence["src"]
    audio_bytes = audio_path.read_bytes()
    digest = hashlib.sha256(audio_bytes).hexdigest()
    if digest != sentence["sha256"]:
        raise ValueError(f"Audio differs from source manifest: {sentence['src']}")
    tokens = TOKEN_PATTERN.findall(sentence["text"])
    groups = expand_words(tokens)
    spoken_words = [word for group in groups for word in group]
    transcript_words = [
        part for token in TOKEN_PATTERN.findall(sentence["spoken_text"])
        for part in normalize(token).split("-")
    ]
    if spoken_words != transcript_words:
        raise ValueError(f"Spoken-word expansion differs from transcript: {sentence['src']}")
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(audio_path),
         "-ar", "16000", "-ac", "1", "-f", "s16le", str(raw_path)],
        check=True,
    )
    raw_audio = raw_path.read_bytes()
    duration = len(raw_audio) / 32000  # Mono PCM16, 16 kHz.
    decoder = Decoder(samprate=16000, lm=None, logfn="/dev/null")
    for word in sorted(set(spoken_words)):
        if decoder.lookup_word(word):
            continue
        if word not in CUSTOM_PRONUNCIATIONS:
            raise ValueError(f"Missing pronunciation for {word!r}; add reviewed ARPAbet phones")
        decoder.add_word(word, CUSTOM_PRONUNCIATIONS[word], update=True)
    decoder.set_align_text(" ".join(spoken_words))
    decoder.start_utt()
    decoder.process_raw(raw_audio, full_utt=True)
    decoder.end_utt()
    decoder.set_alignment()
    decoder.start_utt()
    decoder.process_raw(raw_audio, full_utt=True)
    decoder.end_utt()
    aligned = [
        {"text": re.sub(r"\(\d+\)$", "", word.name),
         "start": word.start / 100,
         "end": (word.start + word.duration) / 100}
        for word in decoder.get_alignment() if word.name not in SILENCE_WORDS
    ]
    if [word["text"] for word in aligned] != spoken_words:
        raise ValueError(f"Decoded word order mismatch: {sentence['src']}")
    # Expanded spoken words must be nonempty and plausible before regrouping.
    for word in aligned:
        if not (0 <= word["start"] < word["end"] <= duration + 0.03):
            raise ValueError(f"Invalid boundary in {sentence['src']}: {word}")
        if word["end"] - word["start"] > 3:
            raise ValueError(f"Implausibly long word in {sentence['src']}: {word}")
    display_words = []
    offset = 0
    for token, group in zip(tokens, groups):
        chunk = aligned[offset:offset + len(group)]
        display_words.append({"text": token, "start": chunk[0]["start"], "end": chunk[-1]["end"]})
        offset += len(group)
    if offset != len(aligned) or len(display_words) != len(tokens):
        raise ValueError(f"Token count mismatch: {sentence['src']}")
    if any(a["end"] > b["start"] for a, b in zip(display_words, display_words[1:])):
        raise ValueError(f"Overlapping word boundaries: {sentence['src']}")
    return {"sha256": digest, "words": display_words}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Output JS path (default: repository sentence-timings.js)")
    parser.add_argument("--check", action="store_true", help="Regenerate and compare without writing")
    args = parser.parse_args()
    if version("pocketsphinx") != "5.1.1":
        raise SystemExit("Use pocketsphinx==5.1.1 for reproducible alignment")
    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg is required to decode the MP3 recordings")
    root = Path(__file__).resolve().parents[1]
    output = args.output or root / "sentence-timings.js"
    manifest = json.loads((root / "audio/20261016-list1/manifest.json").read_text())
    results = {}
    with TemporaryDirectory(prefix="english-sentence-align-") as tmp:
        for index, sentence in enumerate(manifest["sentences"], 1):
            results[sentence["src"]] = align_sentence(root, sentence, Path(tmp) / f"{index:02d}.raw")
            print(f"Aligned {index:02d}: {len(results[sentence['src']]['words'])} tokens", flush=True)
    if args.check:
        saved = output.read_text().split("window.SENTENCE_TIMINGS = ", 1)[1].rsplit(";", 1)[0]
        if json.loads(saved) != results:
            raise SystemExit(f"Generated timings differ from {output}")
        action = "Verified"
    else:
        output.write_text(HEADER + "window.SENTENCE_TIMINGS = " + json.dumps(results, ensure_ascii=False, indent=2) + ";\n")
        action = "Wrote"
    count = sum(len(entry["words"]) for entry in results.values())
    print(f"{action} {len(results)} sentences and {count} displayed token boundaries: {output}")


if __name__ == "__main__":
    main()
