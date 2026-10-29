#!/usr/bin/env python3
"""Fetch/reuse official Youdao word-card data for the document's 32 units.

Section 01 textual fields remain document-owned; this tool supplies audio and
section 02 word-card dictionary fields only. Uses normal TLS/proxy routing,
three workers, one global request-start gate, verified raw caches and bounded
503 backoff. No American audio or fabricated IPA/meanings. Source projections
retain the Chinese glosses from which at most two per POS are selected.

  python3 -B tools/import_youdao_course.py --plan
  python3 -B tools/import_youdao_course.py --fetch
  python3 -B tools/import_youdao_course.py --build
Default staging/cache are outside the checkout; --build is an explicit action
that updates dictionary.js, source audit and the new course audio directory.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
from urllib import error, parse, request

import import_youdao as source

ROOT = Path(__file__).resolve().parents[1]
TOKEN = re.compile(r"[A-Za-z]+(?:[’'-][A-Za-z]+)*|\d+(?:,\d{3})*")
STAGE = Path('/tmp/english-learning-youdao/course')
CACHE = Path('/tmp/english-learning-youdao/cache')
POLICY = 'Official Youdao UK fields/audio only; one or two exact source Chinese phrases per POS. Document section 01/02 text is not overwritten. No American or generated fallback.'
PARSER_VERSION = 'course-v2'


def scope(course):
    words = {}
    def add(text, unit, vocabulary=False):
        key = source.normalize(text)
        row = words.setdefault(key, {'query': key, 'forms': [], 'units': [], 'vocabulary_units': []})
        if text not in row['forms']: row['forms'].append(text)
        if unit not in row['units']: row['units'].append(unit)
        if vocabulary and unit not in row['vocabulary_units']: row['vocabulary_units'].append(unit)
    for unit_id, unit in course['units'].items():
        for entry in unit['vocabulary']: add(entry['word'], int(unit_id), True)
        for entry in unit['examples']:
            for token in TOKEN.findall(entry['speechText']): add(token, int(unit_id))
    return sorted(words.values(), key=lambda row: (not bool(row['vocabulary_units']), row['query']))


class RateLimitedCache:
    def __init__(self, delay):
        self.delay, self.last = delay, 0.0
        self.gate, self.keys_guard = threading.Lock(), threading.Lock()
        self.keys, self.blocked = {}, threading.Event()
    def get(self, url, extension):
        key = source.digest(url.encode())
        with self.keys_guard: lock = self.keys.setdefault(key, threading.Lock())
        with lock:
            path, meta_path = CACHE/(key+extension), CACHE/(key+'.meta.json')
            if path.exists() and meta_path.exists():
                raw, meta = path.read_bytes(), json.loads(meta_path.read_text())
                if source.digest(raw) != meta.get('sha256') or meta.get('url') != url:
                    raise source.Unresolved('Cached source integrity mismatch')
                return raw, meta, path
            for attempt in range(4):
                if self.blocked.is_set(): raise source.TransportBlocked('HTTP403 access denial stopped this batch')
                with self.gate:
                    time.sleep(max(0, self.last+self.delay-time.monotonic()))
                    self.last=time.monotonic()
                try:
                    req=request.Request(url,headers={'User-Agent':'English-learning-course-import/1.0','Accept':'*/*'})
                    with request.urlopen(req,timeout=25) as response:
                        final=parse.urlsplit(response.url)
                        if final.scheme!='https' or final.hostname!='dict.youdao.com':
                            raise source.TransportBlocked('Unexpected official endpoint redirect')
                        raw=response.read(8*1024*1024+1)
                    if not raw or len(raw)>8*1024*1024: raise source.Unresolved('Empty/oversized source response')
                    meta={'url':url,'fetched_at_utc':source.utc_now(),'sha256':source.digest(raw)}
                    CACHE.mkdir(parents=True,exist_ok=True)
                    temporary=path.with_suffix(path.suffix+'.tmp');temporary.write_bytes(raw);temporary.replace(path)
                    source.write_json(meta_path,meta)
                    return raw,meta,path
                except error.HTTPError as exc:
                    if exc.code==403:
                        self.blocked.set();raise source.TransportBlocked('HTTP403; no retry/bypass') from None
                    if exc.code not in {429,500,502,503,504} or attempt==3:
                        raise source.TransportBlocked(f'HTTP{exc.code} after bounded attempts') from None
                except (error.URLError,TimeoutError,OSError):
                    if attempt==3: raise source.TransportBlocked('HTTPS/proxy/TLS timeout after bounded attempts') from None
                time.sleep(2**attempt)


def parse_data(payload, query):
    try:
        entry=source.parse_record(payload,query)
    except source.Unresolved as exc:
        # A literal returned lemma may still supply genuine definitions. Its
        # phonetics/voice must not be presented as those of the queried form.
        if str(exc).startswith('Returned lemma '):
            block=payload.get('ec',payload.get('simple',{}));words=block.get('word',[])if isinstance(block,dict)else[]
            word=words[0]if isinstance(words,list)and words else words
            returned=word.get('return-phrase')if isinstance(word,dict)else None
            if isinstance(returned,dict):returned=returned.get('l',{}).get('i')
            if isinstance(returned,list)and len(returned)==1:returned=returned[0]
            if isinstance(returned,str)and source.normalize(returned)!=source.normalize(query):
                entry=source.parse_record(payload,returned)
                entry.update(ipa='',audio_query='',definition_scope='returned_headword',
                    source_form_mismatch={'query':query,'headword':returned},parse_warning=str(exc))
                entry['missing']=['British IPA for the queried form','British recording for the queried form']
                entry['senses']=[{'pos':s['pos'],'meanings':s['meanings'][:2]}for s in entry['senses']]
                return entry
        # An unfamiliar gloss schema must not discard independently valid UK
        # pronunciation fields. Only remove the sense list in a local copy.
        pronunciation_payload=json.loads(json.dumps(payload))
        for block in ['ec','simple']:
            obj=pronunciation_payload.get(block)
            if not isinstance(obj,dict):continue
            words=obj.get('word',[]);words=words if isinstance(words,list)else[words]
            if words and isinstance(words[0],dict):words[0]['trs']=[]
        entry=source.parse_record(pronunciation_payload,query)
        entry['parse_warning']=str(exc)
    entry['senses']=[{'pos':sense['pos'],'meanings':sense['meanings'][:2]} for sense in entry['senses']]
    return entry


def fetch_word(word, client, repair_partial=False):
    query=word['query'];target=STAGE/'records'/(source.digest(query.encode())+'.json')
    if target.exists():
        record=json.loads(target.read_text())
        if not record.get('transport_error') and record.get('parser_version')==PARSER_VERSION and not(repair_partial and record.get('status')!='complete'):
            record.update(word);source.write_json(target,record);return record
    record={**word,'parser_version':PARSER_VERSION,'status':'unavailable','ipa':'','senses':[]}
    url=source.BASE+'jsonapi?'+parse.urlencode({'q':query})
    try:
        raw,meta,_=client.get(url,'.json');payload=json.loads(raw)
        record['provenance']={'source':'Youdao','query':query,'url':url,'fetched_at_utc':meta['fetched_at_utc'],'raw_response_sha256':meta['sha256']}
        lookup=query;alias=source.explicit_alias(payload) if not payload.get('ec') else None
        if alias and source.normalize(alias)!=query:
            alias_url=source.BASE+'jsonapi?'+parse.urlencode({'q':alias});raw,meta,_=client.get(alias_url,'.json')
            record['alias']={'query':alias,'relationship':'explicit Youdao ce dictionary link','proof_field':'ce.word[0].trs[0].tr[0].l.i','proof':record['provenance']}
            payload,lookup=json.loads(raw),alias
            record['provenance']={'source':'Youdao','query':lookup,'url':alias_url,'fetched_at_utc':meta['fetched_at_utc'],'raw_response_sha256':meta['sha256']}
        entry=parse_data(payload,lookup);entry['query']=query;entry['lookup_query']=lookup
        if lookup=='striking' and entry.get('lemma')=='strike':
            lemma_url=source.BASE+'jsonapi?'+parse.urlencode({'q':'strike'});lemma_raw,lemma_meta,_=client.get(lemma_url,'.json')
            lemma_entry=parse_data(json.loads(lemma_raw),'strike');v=next((s['meanings'] for s in lemma_entry['senses'] if s['pos']=='v.'),[])
            if all(text in v for text in ['达成','达到']):
                entry['senses']=[s for s in entry['senses'] if s['pos']!='v.']+[{'pos':'v.','meanings':['达成','达到']}]
                record['definition_sources']=[{'pos':'v.','query':'strike','url':lemma_url,'fetched_at_utc':lemma_meta['fetched_at_utc'],'raw_response_sha256':lemma_meta['sha256'],'prototype_proof':{'query':'striking','field':'ec.word[0].prototype','value':'strike','raw_response_sha256':record['provenance']['raw_response_sha256']}}]
        audio_query=entry.pop('audio_query');record.update(entry)
        if audio_query:
            audio_url=source.BASE+'dictvoice?'+parse.urlencode({'audio':audio_query,'type':'1'});_,audio_meta,audio_path=client.get(audio_url,'.mp3')
            duration,extension,codec=source.verify_audio(audio_path)
            record['audio']={'url':audio_url,'fetched_at_utc':audio_meta['fetched_at_utc'],'sha256':audio_meta['sha256'],'codec':codec,'duration_seconds':duration,'type':1,'extension':extension,'source_field':'ukspeech','cache_file':str(audio_path)}
        missing=[field for field in ['ipa','senses','audio'] if not record.get(field)]
        record['missing']=missing;record['status']='complete' if not missing else 'unavailable'
    except source.TransportBlocked as exc:
        record['transport_error']=str(exc);record['reason']=str(exc)
    except (source.Unresolved,ValueError,KeyError,TypeError,subprocess.TimeoutExpired) as exc:
        record['reason']=str(exc)
        record['missing']=[field for field in ['ipa','senses','audio'] if not record.get(field)]
    source.write_json(target,record)
    return record


def projection(provenance):
    raw=(CACHE/(source.digest(provenance['url'].encode())+'.json')).read_bytes()
    if source.digest(raw)!=provenance['raw_response_sha256']: raise ValueError('Source projection checksum mismatch')
    payload=json.loads(raw);fields={}
    for block in ['ec','simple','ce']:
        obj=payload.get(block)
        if not isinstance(obj,dict):continue
        words=obj.get('word',[]);words=words if isinstance(words,list) else [words];items=[]
        for word in words[:1]:
            if not isinstance(word,dict):continue
            item={k:word[k] for k in ['ukphone','ukspeech','return-phrase','prototype'] if k in word}
            if 'trs' in word:
                item['trs']=[{'pos':s['pos'],'tran':s['tran']} if 'pos'in s and 'tran'in s else {'tr':[{'l':{k:v for k,v in tr.get('l',{}).items() if k in ['i','#tran']}} for tr in s.get('tr',[])]} for s in word['trs']]
            items.append(item)
        fields[block]={'word':items}
    return {**provenance,'fields':fields}


def build(words, course_path):
    records=[]
    for word in words:
        path=STAGE/'records'/(source.digest(word['query'].encode())+'.json')
        if not path.exists():raise ValueError('Missing staged query: '+word['query'])
        record=json.loads(path.read_text())
        if record.get('transport_error'):raise ValueError('Unresolved source transport: '+word['query'])
        if record.get('parser_version')!=PARSER_VERSION:raise ValueError('Re-run --fetch to refresh parsed cache version: '+word['query'])
        record.update(word)
        records.append(record)
    old=json.loads((ROOT/'data/youdao-unit1.json').read_text());existing={m['sha256']:path for path,m in old['audio_files'].items()}
    runtime={};documents={};entries={};audio_files={};audio_root=ROOT/'audio/youdao-course';audio_root.mkdir(exist_ok=True)
    for record in records:
        query=record['query'];lookup=record.get('lookup_query',query);provenance=record.get('provenance')
        if not provenance:raise ValueError('No genuine source response for '+query)
        proofs=[provenance]+([record['alias']['proof']]if record.get('alias')else[])+record.get('definition_sources',[])
        for proof in proofs:documents[proof['raw_response_sha256']]=projection(proof)
        raw=(CACHE/(source.digest(provenance['url'].encode())+'.json')).read_bytes()
        try:
            expected=parse_data(json.loads(raw),lookup)
        except source.Unresolved:
            expected={'ipa':'','senses':[],'audio_query':''}
        if record.get('definition_sources'):
            if lookup!='striking' or expected.get('lemma')!='strike':raise ValueError('Unrecognized definition override')
            proof=record['definition_sources'][0];lemma_raw=(CACHE/(source.digest(proof['url'].encode())+'.json')).read_bytes()
            lemma_entry=parse_data(json.loads(lemma_raw),'strike');v=next(s['meanings']for s in lemma_entry['senses']if s['pos']=='v.')
            if v[:2]!=['达成','达到']:raise ValueError('Lemma definition source changed')
            expected['senses']=[s for s in expected['senses']if s['pos']!='v.']+[{'pos':'v.','meanings':['达成','达到']}]
        if record.get('ipa','')!=expected['ipa'] or record.get('senses',[])!=expected['senses']:
            raise ValueError('Staged text differs from verified source selection: '+query)
        entry={'ipa':record.get('ipa',''),'senses':record.get('senses',[]),'lemma':record.get('lemma',lookup),'headword':record.get('headword',lookup),
            'source':{'name':'有道词典','url':'https://dict.youdao.com/result?'+parse.urlencode({'word':lookup,'lang':'en'}),'query':query,'lookup_query':lookup,'lemma':record.get('lemma',lookup)},
            'status':record['status'],'missing':record.get('missing',[])}
        if record.get('definition_scope'):
            entry['source']['definition_scope']=record['definition_scope']
            entry['source']['headword']=record['headword']
        if record.get('definition_sources'):entry['definition_sources']=record['definition_sources']
        meta=record.get('audio')
        if meta:
            expected_url=source.BASE+'dictvoice?'+parse.urlencode({'audio':expected['audio_query'],'type':'1'})
            if not expected['audio_query'] or meta['url']!=expected_url or meta['type']!=1:
                raise ValueError('Staged audio does not match official UK reference: '+query)
            path=existing.get(meta['sha256'])
            if not path:
                name=source.digest(query.encode())[:20]+meta['extension'];path='audio/youdao-course/'+name
                raw=Path(meta['cache_file']).read_bytes()
                if source.digest(raw)!=meta['sha256']:raise ValueError('Audio cache checksum mismatch')
                (ROOT/path).write_bytes(raw)
            elif source.digest((ROOT/path).read_bytes())!=meta['sha256']:raise ValueError('Retained audio checksum mismatch')
            entry['audio']=path;audio_files[path]={k:v for k,v in meta.items() if k not in ['cache_file','extension']}
        entry['missing']=[field for field in ['ipa','senses','audio']if not entry.get(field)]
        entry['status']='complete'if not entry['missing']else'unavailable'
        runtime[query]=entry
        entries[query]={'units':record['units'],'vocabulary_units':record['vocabulary_units'],'forms':record['forms'],'status':entry['status'],'missing':entry['missing'],'lookup_query':lookup,'lemma':entry['lemma'],'source_document_sha256':provenance['raw_response_sha256'],'source_senses':entry['senses'],'ipa':entry['ipa'],'audio':entry.get('audio'),'audio_source':{k:v for k,v in meta.items()if k not in ['cache_file','extension']}if meta else None,'definition_sources':record.get('definition_sources',[]),'alias':record.get('alias'),'reason':record.get('reason'),'parse_warning':record.get('parse_warning'),'unparsed_senses':record.get('unparsed_senses',[]),'definition_scope':record.get('definition_scope'),'source_form_mismatch':record.get('source_form_mismatch')}
    course_raw=course_path.read_bytes()
    audit={'source':'有道词典','generated_at_utc':source.utc_now(),'selection_policy':POLICY,'course_source':{'file':str(course_path.relative_to(ROOT))if course_path.is_relative_to(ROOT)else str(course_path),'sha256':source.digest(course_raw),'document_source':json.loads(course_raw).get('source')},'token_pattern':TOKEN.pattern,'scope_count':len(words),'counts':{'complete':sum(e['status']=='complete'for e in runtime.values()),'audio':len(audio_files),'vocabulary_total':sum(bool(w['vocabulary_units'])for w in words),'vocabulary_audio':sum(bool(e['vocabulary_units'])and bool(e['audio'])for e in entries.values())},'entries':entries,'audio_files':audio_files,'source_documents':documents}
    source.write_json(STAGE/'final-runtime.json',runtime);source.write_json(STAGE/'final-audit.json',audit)
    text='// Youdao word cards for document Units 1–32. UK source audio only; audit: data/youdao-course.json.\nwindow.WORD_DICTIONARY = '+json.dumps(runtime,ensure_ascii=False,separators=(',',':'))+';\n'
    audit_target=ROOT/'data/youdao-course.json';audit_temporary=audit_target.with_suffix('.json.tmp')
    audit_temporary.write_text(json.dumps(audit,ensure_ascii=False,separators=(',',':'))+'\n');audit_temporary.replace(audit_target)
    runtime_target=ROOT/'dictionary.js';runtime_temporary=runtime_target.with_suffix('.js.tmp')
    runtime_temporary.write_text(text);runtime_temporary.replace(runtime_target)
    print(json.dumps({'runtime_bytes':len(text.encode()),'audit_bytes':(ROOT/'data/youdao-course.json').stat().st_size,**audit['counts']},ensure_ascii=False))


def main():
    parser=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--course',type=Path,default=ROOT/'data/course-units1-32.json');parser.add_argument('--plan',action='store_true');parser.add_argument('--fetch',action='store_true');parser.add_argument('--build',action='store_true');parser.add_argument('--workers',type=int,default=3);parser.add_argument('--delay',type=float,default=.3);parser.add_argument('--vocabulary-only',action='store_true');parser.add_argument('--repair-partial',action='store_true',help='reparse incomplete staged entries from verified raw caches after an observed parser fix')
    args=parser.parse_args()
    if not 1<=args.workers<=3 or args.delay<.3:parser.error('1–3 workers; global delay minimum0.3 seconds')
    words=scope(json.loads(args.course.read_text()));words=[w for w in words if w['vocabulary_units']]if args.vocabulary_only else words
    plan={'scope':len(words),'vocabulary':sum(bool(w['vocabulary_units'])for w in words),'example_only':sum(not w['vocabulary_units']for w in words),'queries':[w['query']for w in words]}
    if args.plan:print(json.dumps(plan,ensure_ascii=False,indent=2));return
    if args.fetch:
        STAGE.mkdir(parents=True,exist_ok=True);client=RateLimitedCache(args.delay);results=[]
        with ThreadPoolExecutor(max_workers=args.workers)as executor:
            futures={executor.submit(fetch_word,word,client,args.repair_partial):word for word in words}
            for future in as_completed(futures):
                record=future.result();results.append(record)
                if len(results)%10==0 or record.get('transport_error'):print(f"{len(results)}/{len(words)} {record['query']}: {record['status']}"+((' '+record['transport_error'])if record.get('transport_error')else''),flush=True)
        summary={'updated_at_utc':source.utc_now(),'scope':len(words),'complete':sum(r['status']=='complete'for r in results),'audio':sum(bool(r.get('audio'))for r in results),'transport_errors':[r['query']for r in results if r.get('transport_error')],'unavailable':[r['query']for r in results if r['status']!='complete']};source.write_json(STAGE/'summary.json',summary);print(json.dumps(summary,ensure_ascii=False,indent=2))
    if args.build:build(words,args.course)
    if not(args.plan or args.fetch or args.build):parser.error('Choose --plan, --fetch and/or --build')


if __name__=='__main__':main()
