#!/usr/bin/env python3
"""Build human-readable Unit folders without changing the app's audio paths."""
import csv
import hashlib
import json
import os
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'audio-by-unit'
DEST.mkdir(exist_ok=True)
provenance = json.loads((ROOT / 'course-sources/unit-provenance.json').read_text())
columns = ['单元', '类型', '序号', '对应单词', '本目录文件', '程序原始路径', '内容', '中文', '出处']
all_rows = []
file_count = 0
total_bytes = 0

def write_csv(file, columns, rows):
    with file.open('w', encoding='utf-8-sig', newline='') as out:
        writer = csv.writer(out, lineterminator='\n')
        writer.writerow(columns)
        writer.writerows(rows)

def filename(word):
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', word).strip(' .') or 'word'

for record in provenance:
    number = record['unit']
    bundle = json.loads((ROOT / 'miniprogram' / record['runtimePath']).read_text())
    unit_dir = DEST / f'Unit{number:03d}'
    unit_dir.mkdir(exist_ok=True)
    rows = []
    for category in ['01-单词', '02-例句']:
        folder = unit_dir / category
        if folder.exists():
            shutil.rmtree(folder)
        folder.mkdir()
    for i, word in enumerate(bundle['unit']['vocabulary'], 1):
        key = word['word'].lower().replace('’', "'")
        example = bundle['unit']['examples'][i - 1]
        for category, kind, source_path, text, translation, source in [
            ('01-单词', '单词', bundle['dictionary'][key]['audio'], word['word'], word['meaning'], ''),
            ('02-例句', '例句', example['audio'], example['speechText'], example['translation'], example['source']),
        ]:
            original = ROOT / 'audio-resources' / source_path
            relative = f'{category}/{i:02d}_{filename(word["word"])}{original.suffix}'
            target = unit_dir / relative
            try:
                os.link(original, target)
            except OSError:
                shutil.copyfile(original, target)
            # Verify named copies are the exact original recordings.
            assert hashlib.sha256(target.read_bytes()).digest() == hashlib.sha256(original.read_bytes()).digest()
            rows.append([number, kind, i, word['word'], relative, source_path, text, translation, source])
            file_count += 1
            total_bytes += target.stat().st_size
    write_csv(unit_dir / '00-音频对照表.csv', columns, rows)
    all_rows.extend([[*row[:4], f'Unit{number:03d}/'+row[4], *row[5:]] for row in rows])
    shared = [[key, entry.get('ipa', ''), entry['audio'], 'audio-resources/'+entry['audio']]
              for key, entry in sorted(bundle['dictionary'].items()) if entry.get('audio')]
    write_csv(unit_dir / '03-句中点词共用音频索引.csv', ['词形', '音标', '程序原始路径', '工程文件位置'], shared)

write_csv(DEST / '00-全部单元音频清单.csv', columns, all_rows)
(DEST / 'README.md').write_text('''# 按单元查看录音

Unit001 对应 Unit 1，依次到 Unit120。每个单元包含：

- `01-单词`：15 个单词录音，按原词表顺序编号。
- `02-例句`：15 个完整例句录音，文件名使用对应目标词。
- `00-音频对照表.csv`：录音与单词、原句、翻译、出处及程序路径的对应关系。
- `03-句中点词共用音频索引.csv`：句中其他可点读词形的录音位置。这些词会在多个单元重复使用，因此共用原音频目录。

录音没有重新合成或更改内容；原文件扩展名保持不变。全书共 3,600 个按单元命名的单词/例句录音文件。同一录音出现在不同单元时会分别列出。

**配置小程序云音频时，仍上传 `audio-resources/audio/`，并保留 `audio/...` 原路径。** 本目录供按单元查看、核对和取用，不要用 Unit 目录替换小程序已有的音频路径。全部 4,524 个唯一录音（包括句中点词）仍完整保存在原目录。

重新生成：`python tools/organize-audio.py`。课程正文和音频事实取自当前工程的来源快照。
''', encoding='utf-8')
print(json.dumps({'unitFolders': len(provenance), 'namedAudioFiles': file_count, 'namedAudioBytes': total_bytes}, ensure_ascii=False))
