#!/usr/bin/env python3
"""Generate/reuse British sentence MP3s and source word timings for the course.

Build-time requirements: Python 3.10+, ffmpeg/ffprobe, edge-tts==7.3.1.
Run from any directory with an isolated environment, for example:
  python3 -m venv /tmp/course-audio-tools
  /tmp/course-audio-tools/bin/python -m pip install edge-tts==7.3.1
  /tmp/course-audio-tools/bin/python tools/generate_course_audio.py --input data/course-units1-120.json
No browser/runtime Python dependency is added. This uses the existing HTTPS
proxy and supplied CA bundle when present; TLS verification is never disabled.
Exact lexical matches reuse the original repository British recordings and
forced-alignment timings. Other sentences use en-GB-SoniaNeural at -10%.
Raw TTS WordBoundary events are retained beside cached MP3s. If an event spans
multiple display tokens, its interval is split by character positions and
explicitly marked as estimated; otherwise source boundaries are retained.
Re-running resumes checksum-verified cached successes. Published unit entries
are retained exactly; matching new sentences reuse their existing recordings.
--check performs offline validation without synthesis; --decode also completely
decodes every distinct recording and verifies its non-silent waveform. --plan
reports reuse/new-work counts without contacting the synthesis service.
--limit is for staging and never overwrites the published manifest.
"""

import argparse
import array
import asyncio
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
from importlib.metadata import version
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'audio/course-examples'
DEFAULT_INPUT = ROOT / 'data/course-units1-120.json'
LEGACY_INPUT = ROOT / 'data/course-units1-32.json'
MANIFEST = DEST / 'manifest.json'
TOKEN = re.compile(r"[A-Za-z]+(?:[’'-][A-Za-z]+)*|\d+(?:,\d{3})*")
VOICE = 'en-GB-SoniaNeural'
RATE = '-10%'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def tokens(text):
    return TOKEN.findall(text)


def norm(word):
    return word.lower().replace('’', "'")


def lexical_key(text):
    return tuple(map(norm, tokens(text)))


def canonical(text):
    return ''.join(c.lower() for c in text if c.isascii() and c.isalnum())


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)


def validate_audio(path):
    metadata = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(path)], check=True, capture_output=True, text=True)
    duration = float(json.loads(metadata.stdout)['format']['duration'])
    if not 0.4 < duration < 120 or path.stat().st_size < 2000:
        raise ValueError(f'Implausible audio size/duration for {path.name}')
    decoded = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-ar', '8000', '-ac', '1', '-f', 's16le', '-'], check=True, capture_output=True).stdout
    samples = array.array('h', decoded)
    if sys.byteorder != 'little':
        samples.byteswap()
    rms = math.sqrt(sum(v*v for v in samples) / max(1, len(samples)))
    if len(samples) < 2000 or rms < 10:
        raise ValueError(f'Audio is silent or undecodable for {path.name}')
    return duration, sha(path.read_bytes())


def map_boundaries(text, events, duration):
    """Match original input characters, splitting only compound source events."""
    source_tokens = tokens(text)
    relevant = []
    for event in events:
        if event.get('type') != 'WordBoundary':
            continue
        chars = canonical(event['text'])
        if chars:
            relevant.append((chars, event['offset'] / 10000000, (event['offset'] + event['duration']) / 10000000))
    original = ''.join(map(canonical, source_tokens))
    emitted = ''.join(e[0] for e in relevant)
    if original != emitted:
        raise ValueError(f'WordBoundary source text mismatch: {text!r}; source={original!r}, emitted={emitted!r}')
    event_spans = []
    pos = 0
    for chars, start, end in relevant:
        event_spans.append((pos, pos + len(chars), start, end))
        pos += len(chars)
    words = []
    pos = 0
    estimates = []
    for token in source_tokens:
        endpos = pos + len(canonical(token))
        spans = [e for e in event_spans if e[1] > pos and e[0] < endpos]
        first, last = spans[0], spans[-1]
        split = pos > first[0] or endpos < last[1]
        start = first[2] + (max(pos, first[0]) - first[0]) / (first[1] - first[0]) * (first[3] - first[2])
        end = last[2] + (min(endpos, last[1]) - last[0]) / (last[1] - last[0]) * (last[3] - last[2])
        item = {'text': token, 'start': round(start, 7), 'end': round(end, 7)}
        if split:
            item['estimatedSplit'] = True
            estimates.append(token)
        if not (0 <= item['start'] < item['end'] <= duration + 0.08):
            raise ValueError(f'Invalid boundary for {token!r}: {item}, duration={duration}')
        words.append(item)
        pos = endpos
    if any(a['end'] > b['start'] + 0.000001 for a, b in zip(words, words[1:])):
        raise ValueError('Overlapping TTS boundaries')
    return words, estimates


def existing_sources():
    old_manifest = json.loads((ROOT / 'audio/20261016-list1/manifest.json').read_text())
    # Keep old recording provenance independent of the live, regenerated browser map.
    timing_map = json.loads((DEST / 'reused-source-timings.json').read_text())
    return {lexical_key(s['text']): (s, timing_map[s['src']]) for s in old_manifest['sentences']}


def existing_course_entries():
    if not MANIFEST.is_file():
        return {'units': {}}
    return json.loads(MANIFEST.read_text())


def plan_course(course, previous, limit=None):
    """Preserve published entries verbatim before considering sentence reuse."""
    selected = []
    records = {}
    by_text = {}
    by_lexical = {}
    for entries in previous['units'].values():
        for entry in entries:
            by_text.setdefault(entry['speechText'], entry)
            by_lexical.setdefault(lexical_key(entry['speechText']), entry)
    preserved = 0
    for unit, content in course['units'].items():
        published = previous['units'].get(unit)
        if published is not None and len(published) != len(content['examples']):
            raise ValueError(f'Published unit {unit} count changed; refusing to alter existing entries')
        for index, example in enumerate(content['examples']):
            text = example['speechText']
            selected.append((unit, index, text))
            if published is not None:
                entry = published[index]
                if entry['speechText'] != text:
                    raise ValueError(f'Published unit {unit} example {index+1} speech changed; refusing to replace it')
                validate_entry(entry, text)
                records[(unit, index)] = deepcopy(entry)
                preserved += 1
            else:
                entry = by_text.get(text) or by_lexical.get(lexical_key(text))
                if entry is not None:
                    reused = deepcopy(entry)
                    if reused['speechText'] != text:
                        reused['reusedFromSpeechText'] = reused['speechText']
                        reused['speechText'] = text
                        reused['words'] = [{**word, 'text': token} for word, token in zip(entry['words'], tokens(text))]
                    validate_entry(reused, text)
                    records[(unit, index)] = reused
    if limit:
        selected = selected[:limit]
        retained = {(unit, index) for unit, index, _ in selected}
        records = {key: entry for key, entry in records.items() if key in retained}
        preserved = sum(1 for unit, index, _ in selected if unit in previous['units'])
    return selected, records, preserved


def validate_entry(entry, speech_text):
    path = ROOT / entry['audio']
    if not path.is_file() or sha(path.read_bytes()) != entry['sha256']:
        raise ValueError(f'Missing/changed audio: {entry["audio"]}')
    if lexical_key(speech_text) != tuple(norm(w['text']) for w in entry['words']):
        raise ValueError(f'Token count/order differs for {speech_text!r}')
    if any(not 0 <= w['start'] < w['end'] <= entry['duration'] + .08 for w in entry['words']):
        raise ValueError('Invalid cached timing bounds')
    if any(a['end'] > b['start'] + .000001 for a, b in zip(entry['words'], entry['words'][1:])):
        raise ValueError('Cached timing overlap')


async def build(args):
    import aiohttp
    import edge_tts
    if version('edge-tts') != '7.3.1':
        raise SystemExit('Use edge-tts==7.3.1 for the tested synthesis protocol')
    # Add the platform/system trust anchor to certifi; retain CERT_REQUIRED and
    # hostname verification. Never bypass or copy credentials/proxy settings.
    ca = os.environ.get('SSL_CERT_FILE') or os.environ.get('REQUESTS_CA_BUNDLE')
    if ca:
        edge_tts.communicate._SSL_CTX.load_verify_locations(cafile=ca)
    proxy = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')
    course = json.loads(args.input.read_text())
    previous = existing_course_entries()
    old_sources = existing_sources()
    semaphore = asyncio.Semaphore(args.concurrency)
    new_jobs = {}
    selected, records, preserved = plan_course(course, previous, args.limit)
    progress = 0

    async def generated(text):
        nonlocal progress
        digest = sha((VOICE + '\n' + RATE + '\n' + text).encode())[:24]
        mp3 = DEST / (digest + '.mp3')
        record = DEST / (digest + '.json')
        async with semaphore:
            if record.is_file() and mp3.is_file():
                cached = json.loads(record.read_text())
                validate_entry(cached, text)
                return cached
            events = []
            for attempt in range(3):
                temporary = mp3.with_suffix('.mp3.part')
                try:
                    communicate = edge_tts.Communicate(text, VOICE, rate=RATE, proxy=proxy, boundary='WordBoundary')
                    events = []
                    with temporary.open('wb') as out:
                        async for chunk in communicate.stream():
                            if chunk['type'] == 'audio':
                                out.write(chunk['data'])
                            elif chunk['type'] == 'WordBoundary':
                                events.append(chunk)
                    duration, audio_sha = await asyncio.to_thread(validate_audio, temporary)
                    words, estimates = map_boundaries(text, events, duration)
                    temporary.replace(mp3)
                    entry = {'speechText': text, 'audio': str(mp3.relative_to(ROOT)), 'sha256': audio_sha, 'duration': duration,
                             'provider': 'Microsoft Edge ReadAloud', 'voice': VOICE, 'rate': RATE,
                             'timingMethod': 'source-word-boundaries', 'estimatedSplitTokens': estimates,
                             'words': words, 'sourceWordBoundaries': events,
                             'generator': 'edge-tts==7.3.1', 'generatedAt': datetime.now(timezone.utc).isoformat()}
                    write_json(record, entry)
                    progress += 1
                    if progress % 10 == 0:
                        print(f'Generated {progress} new unique recordings', flush=True)
                    return entry
                except (aiohttp.ClientError, asyncio.TimeoutError, edge_tts.exceptions.NoAudioReceived) as exc:
                    temporary.unlink(missing_ok=True)
                    status = getattr(exc, 'status', None)
                    if status and status not in {408, 429, 500, 502, 503, 504}:
                        raise RuntimeError(f'Synthesis HTTP status {status}') from None
                    if attempt == 2:
                        raise RuntimeError(f'Synthesis transport failed: {type(exc).__name__}, status={status}') from None
                    await asyncio.sleep(2 ** attempt)
                except Exception:
                    temporary.unlink(missing_ok=True)
                    raise

    for unit, index, text in selected:
        if (unit, index) in records:
            continue
        key = lexical_key(text)
        if key in old_sources:
            source, timing = old_sources[key]
            duration, audio_sha = await asyncio.to_thread(validate_audio, ROOT / source['src'])
            if audio_sha != timing['sha256']:
                raise ValueError('Original source audio checksum changed')
            entry = {'speechText': text, 'audio': source['src'], 'sha256': audio_sha, 'duration': duration,
                     'provider': 'existing-repository-recording', 'voice': 'en-GB-Melania (source manifest)',
                     'rate': source['rate'], 'timingMethod': 'PocketSphinx-5.1.1-two-pass-forced-alignment',
                     'words': [{**w, 'text': token} for w, token in zip(timing['words'], tokens(text))]}
            validate_entry(entry, text)
            records[(unit,index)] = entry
        elif text not in new_jobs:
            new_jobs[text] = asyncio.create_task(generated(text))
    print(f'Selected {len(selected)} entries; preserved {preserved}; reused {len(records)}; synthesizing/checking {len(new_jobs)} unique texts', flush=True)
    for text, task in new_jobs.items():
        try:
            await task
        except Exception as exc:
            print(f'Failed sentence: {text!r}; {type(exc).__name__}: {exc}', flush=True)
            for other in new_jobs.values():
                other.cancel()
            raise
    output_units = {}
    for unit, index, text in selected:
        entry = records.get((unit,index)) or new_jobs[text].result()
        validate_entry(entry, text)
        # Cache retains raw source events; the browser manifest only needs mapped
        # token boundaries and compact provenance for each course occurrence.
        compact = {k:v for k,v in entry.items() if k not in {'sourceWordBoundaries','generatedAt'}}
        output_units.setdefault(unit, []).append(compact)
    # Reused/published entries must remain deep-equal, including their original
    # provenance fields. Only newly generated sidecars need compacting.
    for (unit, index), entry in records.items():
        output_units[unit][index] = entry
    for unit, published in previous['units'].items():
        if unit in output_units and unit in course['units'] and not args.limit:
            if output_units[unit] != published:
                raise ValueError(f'Published unit {unit} changed unexpectedly')
    result = {'schemaVersion':1, 'inputSha256':sha(args.input.read_bytes()),
              'source':'Known course speechText; exact British source reuse or en-GB-SoniaNeural synthesis',
              'units': output_units, 'counts':{'entries':len(selected),'uniqueNew':len(new_jobs),'reusedEntries':len(records),
                                              'preservedEntries':preserved,'generatedThisRun':progress}}
    destination = MANIFEST.with_name('manifest-stage.json') if args.limit else MANIFEST
    write_json(destination,result)
    print('Wrote',destination,'with',len(selected),'playable sentence entries',flush=True)


def check_manifest(args):
    course = json.loads(args.input.read_text())
    manifest = json.loads(MANIFEST.read_text())
    count = 0
    paths = set()
    estimated = 0
    for unit, content in course['units'].items():
        if len(manifest['units'].get(unit, [])) != len(content['examples']):
            raise ValueError(f'Incomplete unit {unit}')
        for example, entry in zip(content['examples'],manifest['units'][unit]):
            validate_entry(entry,example['speechText'])
            if entry['speechText'] != example['speechText']:
                raise ValueError('Speech input differs from course data')
            count += 1
            estimated += sum(bool(w.get('estimatedSplit')) for w in entry['words'])
            paths.add(entry['audio'])
    if args.decode:
        expected = {entry['audio']: entry for entries in manifest['units'].values() for entry in entries}
        def verify_decoded(path):
            duration, checksum = validate_audio(ROOT / path)
            entry = expected[path]
            if checksum != entry['sha256'] or abs(duration - entry['duration']) > .001:
                raise ValueError(f'Decoded audio differs from manifest: {path}')
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(verify_decoded, sorted(paths)))
    print(json.dumps({'verifiedEntries':count,'uniqueAudioFiles':len(paths),'estimatedCompoundSplits':estimated,
                      'fullyDecodedUniqueAudio':len(paths) if args.decode else 0}))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check',action='store_true')
    parser.add_argument('--decode',action='store_true',help='With --check, fully decode every distinct MP3 and reject silence')
    parser.add_argument('--plan',action='store_true',help='Report reuse/new-work counts without synthesis')
    parser.add_argument('--input',type=Path,default=DEFAULT_INPUT if DEFAULT_INPUT.is_file() else LEGACY_INPUT)
    parser.add_argument('--concurrency',type=int,default=2,choices=range(1,4))
    parser.add_argument('--limit',type=int)
    args=parser.parse_args()
    DEST.mkdir(parents=True,exist_ok=True)
    if args.plan:
        course = json.loads(args.input.read_text())
        selected, records, preserved = plan_course(course, existing_course_entries(), args.limit)
        new_texts = {text for unit, index, text in selected if (unit, index) not in records}
        cached = sum((DEST / (sha((VOICE+'\n'+RATE+'\n'+text).encode())[:24]+'.json')).is_file() for text in new_texts)
        print(json.dumps({'entries':len(selected),'preservedEntries':preserved,'reusedEntries':len(records),
                          'newUniqueTexts':len(new_texts),'alreadyCached':cached}))
    elif args.check:
        check_manifest(args)
    else:
        asyncio.run(build(args))


if __name__=='__main__':
    main()
