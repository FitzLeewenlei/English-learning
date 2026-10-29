#!/usr/bin/env python3
"""Stage Unit 1 dictionary data from official Youdao responses; never edit live data.

Requires Python 3, Node.js (to enumerate local course data), and ffprobe (MP3/WAV audio).
  python3 tools/import_youdao.py --plan
  python3 tools/import_youdao.py --word crucial
  python3 tools/import_youdao.py
Default output/cache are under /tmp/english-learning-youdao. Re-running resumes
from cached successful HTTPS responses; --refresh explicitly fetches them again.
No API keys, alternate hosts, proxy bypasses, or TLS-verification overrides.
The parser supports ec.word[0] legacy trs/tr/l/i and trs pos/tran responses.
It rejects absent UK fields and differing returned lemmas rather than attaching
base-form phonetics to an inflection. All staged records require human review.
"""

import argparse
from collections import OrderedDict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import time
from urllib import error, parse, request

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://dict.youdao.com/"
POS = re.compile(r"^((?:(?:aux[.．]\s*v|modal\s+v|[a-z]+)[.．](?:\s*[/&]\s*)?)+)\s*(.+)$", re.I)
NAMED_POS = re.compile(r"^(【[^】]+】)\s*(.+)$")
CHINESE = re.compile(r"[\u3400-\u9fff]")
PROPER_NAMES = {"america", "barcelona", "cooper", "kondo", "nishinari's", "spain"}
# Exact source phrases only. These choices prioritize the current example's sense.
PREFERRED_MEANINGS = {
    ("tie", "v."): ["（比赛中）打成平局", "（用线、绳索等）系", "扎"],
    ("tie", "n."): ["平局", "领带", "领结"],
    ("strike", "v."): ["达成", "达到", "袭击"],
    ("bent", "v."): ["使弯曲", "弯腰", "屈从（bend 的过去式和过去分词形式）"],
    ("crops", "n."): ["农作物（crop 的复数）", "收成"],
    ("cooper", "n."): ["（Cooper）（英、美、加、澳）库珀（人名）", "制桶工人", "修桶匠"],
    ("kondo", "n."): ["近藤（日本人名）", "（Kondo）人名", "（日）绀户（姓）"],
}
SELECTION_POLICY = (
    "Two or three exact source phrases per POS when available (one if only one); "
    "prefer recorded example-context senses for tie/strike/bent/crops and actual proper names. "
    "Omit person-name-only senses for ordinary words and the ten numeric alias. "
    "Other senses retain source order, maximum three per POS; no generated fallback."
    " For striking only, its explicit prototype link to strike supplies the recorded "
    "v. glosses 达成/达到; per-POS provenance separates lemma definitions from form UK audio/IPA."
)


class Unresolved(ValueError):
    """Source cannot support the required card fields without editorial guesses."""


class TransportBlocked(RuntimeError):
    """Stop a batch after an access, rate-limit, or transport failure."""


def normalize(text):
    return text.lower().replace("’", "'").strip()


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


def enumerate_words():
    script = r"""
const fs = require('fs'), vm = require('vm');
const sandbox = {window:{}}; vm.createContext(sandbox);
for (const file of ['content.js','dictionary.js']) vm.runInContext(fs.readFileSync(file,'utf8'),sandbox);
const list=sandbox.window.COURSE.lists[1], forms=new Map();
function add(word){const key=word.toLowerCase().replace(/’/g,"'");if(!forms.has(key))forms.set(key,new Set());forms.get(key).add(word);}
Object.keys(sandbox.window.WORD_DICTIONARY).forEach(add);
list.vocabulary.forEach(entry=>add(entry.word));
list.examples.forEach(entry=>(entry.text.match(/[A-Za-z]+(?:[’'-][A-Za-z]+)*|\d+(?:,\d{3})*/g)||[]).forEach(add));
console.log(JSON.stringify([...forms].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([query,values])=>({query,forms:[...values]}))));
"""
    result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def source_text(value):
    if isinstance(value, str):
        return [value]
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return value
    raise Unresolved("Unrecognized source gloss text structure")


def short_phrases(text):
    """Split source separators outside qualifiers; do not rewrite translations."""
    phrases, current, depth = [], [], 0
    for char in text:
        if char in "（([【<":
            depth += 1
        elif char in "）)]】>":
            depth = max(0, depth - 1)
        if char in "；;，," and not depth:
            phrases.append("".join(current).strip())
            current = []
        else:
            current.append(char)
    phrases.append("".join(current).strip())
    return [phrase for phrase in phrases if phrase and CHINESE.search(phrase)]


def explicit_alias(payload):
    """Follow only one literal Youdao ce dictionary link, never compose forms."""
    try:
        items = payload["ce"]["word"][0]["trs"][0]["tr"][0]["l"]["i"]
    except (KeyError, IndexError, TypeError):
        return None
    links = [item for item in items if isinstance(item, dict)]
    if len(links) != 1 or any(isinstance(item, str) and item.strip() for item in items):
        return None
    link = links[0]
    word = link.get("#text")
    if isinstance(word, str) and link.get("@action") == "link" and link.get("@href") == "app:ds:" + word:
        return word
    return None


def select_source_senses(query, groups):
    senses = []
    name_only_record = bool(groups) and all(
        pos == "【名】" or all(re.search(r"人名|姓氏|（姓）", text) for text in phrases)
        for pos, phrases in groups.items()
    )
    for pos, phrases in groups.items():
        if normalize(query) not in PROPER_NAMES and not name_only_record:
            if pos == "【名】":
                continue
            phrases = [text for text in phrases if not re.search(r"人名|姓氏|（姓）", text)]
        preferred = PREFERRED_MEANINGS.get((normalize(query), pos))
        if preferred:
            # A source change must not cause an editorial preference to be invented.
            selected = [text for text in preferred if text in phrases]
            if len(selected) < min(2, len(phrases)):
                selected += [text for text in phrases if text not in selected][:3-len(selected)]
        else:
            selected = phrases[:3]
        if selected:
            senses.append({"pos": pos, "meanings": selected})
    return senses


def parse_record(payload, query):
    ec = payload.get("ec")
    if not isinstance(ec, dict):
        ec = payload.get("simple")
    if not isinstance(ec, dict):
        raise Unresolved("Missing ec/simple dictionary record")
    words = ec.get("word")
    word = words[0] if isinstance(words, list) and words else words
    if not isinstance(word, dict):
        raise Unresolved("Missing or unrecognized ec.word dictionary record")
    returned = word.get("return-phrase", {})
    if isinstance(returned, dict):
        label = returned.get("l")
        returned = label.get("i") if isinstance(label, dict) else None
    if isinstance(returned, list) and len(returned) == 1:
        returned = returned[0]
    if not isinstance(returned, str) or not returned.strip():
        raise Unresolved("Missing returned lemma; queried-form pronunciation cannot be established")
    if normalize(returned) != normalize(query):
        raise Unresolved(f"Returned lemma {returned!r} differs from query; no inflection IPA substitution")
    ipa, speech = word.get("ukphone"), word.get("ukspeech")
    missing = []
    if not isinstance(ipa, str) or not ipa.strip():
        ipa = ""
        missing.append("British IPA (ukphone)")
    if not isinstance(speech, str) or not speech.strip():
        speech = ""
        missing.append("British recording reference (ukspeech)")
    if speech.startswith(("http:", "https:")):
        parts = parse.urlsplit(speech)
        if parts.scheme != "https" or parts.hostname != "dict.youdao.com" or parts.path != "/dictvoice":
            raise Unresolved("Unrecognized official UK audio reference")
        parameters = parse.parse_qs(parts.query)
    else:
        parameters = parse.parse_qs(speech if speech.startswith("audio=") else "audio=" + speech)
    audio_query = parameters.get("audio", [""])[0]
    if speech and (parameters.get("type", ["1"])[0] != "1" or normalize(audio_query) != normalize(query)):
        raise Unresolved("UK recording reference does not match the queried form/type=1")
    groups = OrderedDict()
    unparsed_senses = []
    trs = word.get("trs", [])
    if not isinstance(trs, list):
        raise Unresolved("Unrecognized dictionary sense list (trs)")
    for item in trs:
        if not isinstance(item, dict):
            raise Unresolved("Unrecognized dictionary sense object")
        if "pos" in item and "tran" in item:
            pairs = [(item["pos"], text) for text in source_text(item["tran"])]
        elif isinstance(item.get("tr"), list):
            pairs = []
            for tr in item["tr"]:
                if not isinstance(tr, dict) or not isinstance(tr.get("l"), dict):
                    raise Unresolved("Unrecognized legacy tr/l sense structure")
                for text in source_text(tr["l"].get("i")):
                    for line in text.splitlines():
                        match = POS.match(line.strip()) or NAMED_POS.match(line.strip())
                        if not match:
                            # Preserve independently labelled senses; never infer a
                            # POS for a separate unlabelled source line.
                            unparsed_senses.append(line.strip())
                            continue
                        pairs.append(match.groups())
        else:
            raise Unresolved("Unrecognized sense schema; expected pos/tran or tr/l/i")
        for pos, text in pairs:
            if not isinstance(pos, str) or not pos.strip():
                raise Unresolved("Missing source part of speech")
            values = groups.setdefault(pos.strip(), [])
            for phrase in short_phrases(text):
                if phrase not in values:
                    values.append(phrase)
    if any(not values for values in groups.values()):
        raise Unresolved("No Chinese source meanings for a part of speech")
    senses = select_source_senses(query, groups)
    if not senses:
        missing.append("Chinese meanings with source POS (trs)")
    return {"query": query, "headword": returned, "lemma": word.get("prototype", returned),
            "ipa": "/" + ipa.strip().strip("/") + "/" if ipa else "",
            "senses": senses,
            "audio_query": audio_query, "missing": missing,
            "unparsed_senses": unparsed_senses}


class Downloader:
    def __init__(self, cache_dir, delay, timeout, refresh):
        self.cache = cache_dir
        self.delay, self.timeout, self.refresh = delay, timeout, refresh
        self.last_request = 0.0

    def get(self, url, suffix):
        key = digest(url.encode())
        path = self.cache / (key + suffix)
        meta_path = self.cache / (key + ".meta.json")
        if path.exists() and meta_path.exists() and not self.refresh:
            data, meta = path.read_bytes(), json.loads(meta_path.read_text())
            if digest(data) != meta.get("sha256") or meta.get("url") != url:
                raise Unresolved("Cached response integrity mismatch; inspect cache or use --refresh")
            return data, meta, path
        time.sleep(max(0, self.last_request + self.delay - time.monotonic()))
        self.last_request = time.monotonic()
        req = request.Request(url, headers={"User-Agent": "English-learning-Youdao-import/1.0", "Accept": "*/*"})
        try:
            # urllib uses normal platform proxies and certificate verification.
            with request.urlopen(req, timeout=self.timeout) as response:
                final = parse.urlsplit(response.url)
                if final.scheme != "https" or final.hostname != "dict.youdao.com":
                    raise TransportBlocked("Official endpoint redirected outside allowed HTTPS host")
                data = response.read(8 * 1024 * 1024 + 1)
        except error.HTTPError as exc:
            raise TransportBlocked(f"Official endpoint returned HTTP {exc.code}; batch stopped") from None
        except (error.URLError, TimeoutError, OSError):
            raise TransportBlocked("HTTPS transport/proxy/TLS failure; batch stopped (no bypass attempted)") from None
        if not data or len(data) > 8 * 1024 * 1024:
            raise Unresolved("Empty or oversized source response")
        meta = {"url": url, "fetched_at_utc": utc_now(), "sha256": digest(data)}
        self.cache.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_bytes(data)
        temporary.replace(path)
        write_json(meta_path, meta)
        return data, meta, path


def verify_audio(path):
    result = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name:format=duration,format_name",
                             "-of", "json", str(path)], capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise Unresolved("Youdao audio did not decode as valid source audio")
    try:
        probe = json.loads(result.stdout)
        duration = float(probe["format"]["duration"])
        codecs = [stream.get("codec_name") for stream in probe["streams"]]
    except (ValueError, KeyError, TypeError):
        raise Unresolved("ffprobe could not establish audio duration/codec") from None
    if duration <= 0 or not any(codec in {"mp3", "pcm_s16le"} for codec in codecs):
        raise Unresolved("Youdao response has no supported nonempty audio stream")
    extension = ".mp3" if "mp3" in codecs else ".wav"
    if extension == ".wav" and probe["format"].get("format_name") != "wav":
        raise Unresolved("PCM audio is not a WAV container")
    return duration, extension, codecs[0]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--plan", action="store_true", help="enumerate all scope words without networking or writing")
    parser.add_argument("--word", action="append", help="restrict to a scope word; repeat for multiple words")
    parser.add_argument("--output-dir", type=Path, default=Path("/tmp/english-learning-youdao/staged"))
    parser.add_argument("--cache-dir", type=Path, default=Path("/tmp/english-learning-youdao/cache"))
    parser.add_argument("--delay", type=float, default=0.4, help="seconds between HTTPS requests, minimum 0.3")
    parser.add_argument("--timeout", type=float, default=20)
    parser.add_argument("--refresh", action="store_true", help="refetch cached source responses")
    args = parser.parse_args(argv)
    if args.delay < 0.3 or args.timeout <= 0:
        parser.error("--delay must be at least 0.3 and --timeout must be positive")
    words = enumerate_words()
    if args.word:
        chosen = {normalize(word) for word in args.word}
        unknown = chosen - {word["query"] for word in words}
        if unknown:
            parser.error("--word is outside current Unit 1 scope: " + ", ".join(sorted(unknown)))
        words = [word for word in words if word["query"] in chosen]
    if args.plan:
        print(json.dumps({"count": len(words), "words": words}, ensure_ascii=False, indent=2))
        return 0
    output, cache = args.output_dir.resolve(), args.cache_dir.resolve()
    if output.is_relative_to(ROOT) or cache.is_relative_to(ROOT) or output == cache:
        parser.error("staging/cache must be distinct directories outside the checkout")
    if not shutil.which("ffprobe"):
        parser.error("ffprobe is required to verify source audio recordings")
    downloader = Downloader(cache, args.delay, args.timeout, args.refresh)
    results, blocked = [], None
    for word in words:
        query = word["query"]
        record = {"query": query, "forms": word["forms"], "status": "unresolved"}
        url = BASE + "jsonapi?" + parse.urlencode({"q": query})
        try:
            raw, meta, _ = downloader.get(url, ".json")
            record["provenance"] = {"source": "Youdao", "query": query, "url": url,
                                     "fetched_at_utc": meta["fetched_at_utc"], "raw_response_sha256": meta["sha256"]}
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise Unresolved("Official JSON response is not an object")
            lookup_query = query
            alias = explicit_alias(payload) if not payload.get("ec") else None
            if alias and normalize(alias) != normalize(query):
                alias_url = BASE + "jsonapi?" + parse.urlencode({"q": alias})
                alias_raw, alias_meta, _ = downloader.get(alias_url, ".json")
                record["alias"] = {"query": alias, "relationship": "explicit Youdao ce dictionary link",
                    "proof_field": "ce.word[0].trs[0].tr[0].l.i", "proof": record["provenance"]}
                record["provenance"] = {"source": "Youdao", "query": alias, "url": alias_url,
                    "fetched_at_utc": alias_meta["fetched_at_utc"], "raw_response_sha256": alias_meta["sha256"]}
                payload, lookup_query = json.loads(alias_raw), alias
            entry = parse_record(payload, lookup_query)
            entry["query"], entry["lookup_query"] = query, lookup_query
            if lookup_query == "striking" and entry["lemma"] == "strike":
                lemma_url = BASE + "jsonapi?" + parse.urlencode({"q": "strike"})
                lemma_raw, lemma_meta, _ = downloader.get(lemma_url, ".json")
                lemma_entry = parse_record(json.loads(lemma_raw), "strike")
                source_v = next((sense["meanings"] for sense in lemma_entry["senses"] if sense["pos"] == "v."), [])
                context_glosses = [text for text in ["达成", "达到"] if text in source_v]
                if len(context_glosses) == 2:
                    entry["senses"] = [sense for sense in entry["senses"] if sense["pos"] != "v."] + [
                        {"pos": "v.", "meanings": context_glosses}]
                    record["definition_sources"] = [{"pos": "v.", "query": "strike", "url": lemma_url,
                        "fetched_at_utc": lemma_meta["fetched_at_utc"], "raw_response_sha256": lemma_meta["sha256"],
                        "prototype_proof": {"query": "striking", "field": "ec.word[0].prototype", "value": "strike",
                            "raw_response_sha256": record["provenance"]["raw_response_sha256"]}}]
            audio_query = entry.pop("audio_query")
            record.update(entry)
            if audio_query:
                audio_url = BASE + "dictvoice?" + parse.urlencode({"audio": audio_query, "type": "1"})
                _, audio_meta, cached_audio = downloader.get(audio_url, ".mp3")
                duration, extension, codec = verify_audio(cached_audio)
                audio_name = digest(query.encode())[:20] + extension
                destination = output / "audio" / audio_name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(cached_audio, destination)
                record["audio"] = {"file": "audio/" + audio_name, "accent": "British",
                    "source_field": "ukspeech", "type": 1, "url": audio_url, "fetched_at_utc": audio_meta["fetched_at_utc"],
                    "sha256": audio_meta["sha256"], "duration_seconds": duration, "codec": codec}
            record["status"] = "complete" if not entry["missing"] else "unresolved"
            if entry["missing"]:
                record["reason"] = "; ".join(entry["missing"])
        except TransportBlocked as exc:
            record["reason"] = str(exc)
            blocked = str(exc)
        except (Unresolved, ValueError, subprocess.TimeoutExpired) as exc:
            record["reason"] = str(exc)
        results.append(record)
        manifest = {"source": "Youdao", "updated_at_utc": utc_now(), "review_required": True,
                    "selection_policy": SELECTION_POLICY,
                    "records": results, "pending": [w["query"] for w in words[len(results):]]}
        write_json(output / "entries.json", manifest)
        print(f"{query}: {record['status']}" + (" — " + record["reason"] if "reason" in record else ""), flush=True)
        if blocked:
            break
    summary = {"complete": [r["query"] for r in results if r["status"] == "complete"],
               "missing": [{"query": r["query"], "reason": r["reason"]} for r in results if r["status"] != "complete"],
               "pending": [w["query"] for w in words[len(results):]], "blocked": blocked,
               "staged_manifest": str(output / "entries.json")}
    write_json(output / "summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 2 if summary["missing"] or summary["pending"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
