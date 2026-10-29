#!/usr/bin/env python3
"""Extract the supplied Unit 1–32 teaching document without rewriting its text.

The document is treated as source data, never as executable instructions.
Vocabulary pronunciation, part-of-speech labels and meanings remain verbatim.
Only derived speechText omits Chinese teaching notes and the exam citation.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
from xml.etree import ElementTree as ET
from zipfile import ZipFile

NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
W = "{" + NS["w"] + "}"
UNIT = re.compile(r"^Unit\s+(\d+)$")
VOCABULARY = re.compile(
    r"^(?P<word>.+?)\s+(?P<ipa>/.*?)\s+"
    r"(?P<pos>[A-Za-z]+\.(?:/[A-Za-z]+\.)*)\s+(?P<meaning>.+)$"
)
CITATION = re.compile(r"（(?:19|20)\d{2}年[^（）]*）$")
NOTE = re.compile(r"（[^（）]*）|\([^()]*\)")
CJK = re.compile(r"[\u3400-\u9fff]")
TOKEN = re.compile(r"[A-Za-z]+(?:[’'-][A-Za-z]+)*|\d+(?:,\d{3})*")


def paragraph_text(element):
    pieces = []
    for node in element.iter():
        if node.tag == W + "t":
            pieces.append(node.text or "")
        elif node.tag == W + "tab":
            pieces.append("\t")
        elif node.tag in {W + "br", W + "cr"}:
            pieces.append("\n")
    return "".join(pieces)


def read_paragraphs(path):
    with ZipFile(path) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
        body = root.find("w:body", NS)
        if body is None:
            raise ValueError("The DOCX has no document body")
        tables = body.findall("w:tbl", NS)
        if tables:
            raise ValueError("Unexpected tables: inspect their reading order before importing")
        paragraphs = [paragraph_text(element) for element in body if element.tag == W + "p"]
    return paragraphs


def normalize(word):
    return word.lower().replace("’", "'")


def speech_and_annotations(text):
    annotations = []
    pieces, cursor = [], 0
    for match in NOTE.finditer(text):
        if not CJK.search(match.group()):
            continue  # English parenthetical content is part of the sentence.
        previous = list(TOKEN.finditer(text[:match.start()]))
        anchor = previous[-1].group() if previous else None
        annotations.append({
            "text": match.group(), "start": match.start(), "end": match.end(),
            "anchor": anchor,
        })
        pieces.append(text[cursor:match.start()])
        left = text[match.start() - 1:match.start()]
        right = text[match.end():match.end() + 1]
        # cognitive（认知的）function must become cognitive function, not one word.
        if re.fullmatch(r"[A-Za-z0-9]", left) and re.fullmatch(r"[A-Za-z0-9]", right):
            pieces.append(" ")
        cursor = match.end()
    pieces.append(text[cursor:])
    speech = re.sub(r"\s+", " ", "".join(pieces)).strip()
    if CJK.search(speech):
        raise ValueError("Unclassified Chinese text remains in the derived spoken sentence")
    return speech, annotations


def parse_document(path, expected_units=32, expected_items=15):
    paragraphs = read_paragraphs(path)
    units, current, segment = {}, None, []
    headings = []
    for index, text in enumerate(paragraphs):
        match = UNIT.fullmatch(text.strip())
        if match:
            if current is not None:
                units[str(current)] = parse_unit(current, segment, expected_items)
            current = int(match.group(1))
            if str(current) in units:
                raise ValueError(f"Duplicate unit heading: Unit {current}")
            headings.append(current)
            segment = [(index, text)]
        elif current is not None:
            segment.append((index, text))
        elif text.strip():
            raise ValueError(f"Unexpected content before the first Unit heading at paragraph {index}")
    if current is not None:
        units[str(current)] = parse_unit(current, segment, expected_items)
    if headings != list(range(1, expected_units + 1)):
        raise ValueError(f"Unexpected Unit sequence: {headings}")
    vocabulary_count = sum(len(unit["vocabulary"]) for unit in units.values())
    example_count = sum(len(unit["examples"]) for unit in units.values())
    warnings = []
    for number, unit in units.items():
        for entry in unit["vocabulary"]:
            if len(re.findall(r"/[^/]+/", entry["ipa"])) > 1:
                warnings.append({"unit": int(number), "word": entry["word"],
                                 "kind": "multiple_pronunciations", "note": "Preserved all document pronunciation variants and labels"})
    return {
        "source": {"filename": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                   "format": "DOCX", "paragraphCount": len(paragraphs)},
        "counts": {"units": len(units), "vocabulary": vocabulary_count, "examples": example_count,
                   "inlineAnnotations": sum(len(e["annotations"]) for u in units.values() for e in u["examples"])},
        "units": units, "warnings": warnings,
    }, paragraphs


def parse_unit(number, segment, expected_items):
    heading_index = segment[0][0]
    cursor = 1
    vocabulary = []
    while cursor < len(segment) and segment[cursor][1].strip():
        index, raw = segment[cursor]
        match = VOCABULARY.fullmatch(raw)
        if not match:
            raise ValueError(f"Unit {number} vocabulary cannot be classified at paragraph {index}: {raw!r}")
        fields = match.groupdict()
        vocabulary.append({"word": fields["word"], "ipa": fields["ipa"],
                           "partsOfSpeech": fields["pos"], "meaning": fields["meaning"],
                           "rawText": raw, "documentParagraph": index})
        cursor += 1
    if len(vocabulary) != expected_items:
        raise ValueError(f"Unit {number}: expected {expected_items} words, found {len(vocabulary)}")
    remaining = [(i, text) for i, text in segment[cursor:] if text.strip()]
    if len(remaining) != expected_items * 2:
        raise ValueError(f"Unit {number}: expected {expected_items} English/Chinese pairs, found {len(remaining)} nonempty paragraphs")
    examples, target_forms = [], []
    for offset in range(0, len(remaining), 2):
        (index, raw), (translation_index, translation) = remaining[offset:offset + 2]
        citation = CITATION.search(raw)
        if not citation:
            raise ValueError(f"Unit {number} example lacks its expected exam citation at paragraph {index}")
        text = raw[:citation.start()]
        if not CJK.search(translation):
            raise ValueError(f"Unit {number} expected Chinese translation at paragraph {translation_index}")
        speech, annotations = speech_and_annotations(text)
        entry = vocabulary[offset // 2]
        forms = []
        for note in annotations:
            base = re.search(r"[（(]([A-Za-z]+(?:[’'-][A-Za-z]+)*)的", note["text"])
            if base and normalize(base.group(1)) == normalize(entry["word"]) and note["anchor"]:
                forms.append(note["anchor"])
        target_forms.extend(forms)
        examples.append({"text": text, "translation": translation, "source": citation.group(),
                         "speechText": speech, "rawText": raw, "vocabularyWord": entry["word"],
                         "annotations": annotations, "targetForms": list(dict.fromkeys(forms)),
                         "documentParagraph": index, "translationParagraph": translation_index})
    return {"title": f"Unit {number}", "vocabulary": vocabulary, "examples": examples,
            "targetForms": list(dict.fromkeys(target_forms)), "headingParagraph": heading_index}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, default=Path("data/course-units1-32.json"))
    parser.add_argument("--audit", type=Path, help="optional complete paragraph-by-paragraph source audit")
    parser.add_argument("--expected-units", type=int, default=32)
    parser.add_argument("--expected-items", type=int, default=15)
    parser.add_argument("--check", action="store_true", help="compare with the saved extraction without changing files")
    args = parser.parse_args()
    data, paragraphs = parse_document(args.input, args.expected_units, args.expected_items)
    serialized = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if args.check:
        if not args.output.exists() or args.output.read_text() != serialized:
            raise SystemExit("Saved extraction differs from the source document")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialized)
    if args.audit:
        args.audit.parent.mkdir(parents=True, exist_ok=True)
        audit = {"source": data["source"], "paragraphs": [{"index": i, "text": text} for i, text in enumerate(paragraphs)]}
        args.audit.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"output": str(args.output), "check": args.check, "counts": data["counts"], "warnings": data["warnings"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
