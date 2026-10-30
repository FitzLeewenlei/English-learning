#!/usr/bin/env python3
"""Read-only container and duration audit of every imported recording."""
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import json
import subprocess

ROOT=Path(__file__).resolve().parents[1]
manifest=json.loads((ROOT/'audio-resource-manifest.json').read_text())
def inspect(item):
    path=ROOT/'audio-resources'/item['path']
    result=subprocess.run(['ffprobe','-v','error','-show_entries','format=duration:stream=codec_name','-of','json',str(path)],capture_output=True,text=True,timeout=30)
    if result.returncode:return {'path':item['path'],'error':result.stderr.strip()}
    try:
        data=json.loads(result.stdout)
        duration=float(data['format']['duration'])
        if duration<=0:raise ValueError('Empty audio')
        return {'duration':duration,'codec':data['streams'][0]['codec_name']}
    except Exception as exc:return {'path':item['path'],'error':str(exc)}
errors=[];codecs={};seconds=0.0
with ThreadPoolExecutor(max_workers=6) as pool:
    pending=[pool.submit(inspect,item) for item in manifest['files']]
    for n,future in enumerate(as_completed(pending),1):
        result=future.result()
        if 'error' in result:errors.append(result)
        else:seconds+=result['duration'];codecs[result['codec']]=codecs.get(result['codec'],0)+1
        if n%1000==0:print(f'Checked {n} recordings',flush=True)
report={'files':len(manifest['files']),'failed':len(errors),'codecs':codecs,'totalSeconds':round(seconds,3),'errors':errors}
(ROOT/'AUDIO_AUDIT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False))
if errors:raise SystemExit(1)
