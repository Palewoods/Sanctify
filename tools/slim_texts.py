"""Keeps index.html light: moves the long texts of saints (life and prayer), books, and history entries
into data/texts/*.json, leaving a short preview in the page. The site loads a file of about forty entries
only when one of them is opened (or when searching), and the service worker keeps it on the device.

Run it again after adding entries: entries that still carry their full text are moved out, entries already
moved keep their text, and the files are rebuilt with new content-hashed names.

    python tools/slim_texts.py
"""
import hashlib, json, os, re, sys
sys.stdout.reconfigure(encoding='utf-8')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, 'index.html')
OUT = os.path.join(ROOT, 'data', 'texts')
CATS = ('saint', 'book', 'history')
PREVIEW = 200      # long enough for every excerpt shown before an entry is opened (lists and cards show at most 200 characters)
PER_FILE = 40

JS_STR = r"'(?:[^'\\]|\\.)*'"
def js_decode(lit):
    return re.sub(r'\\(u[0-9a-fA-F]{4}|.)', lambda m: chr(int(m.group(1)[1:], 16)) if m.group(1)[0] == 'u' and len(m.group(1)) == 5
                  else {'n': '\n', 't': '\t', 'r': '\r'}.get(m.group(1), m.group(1)), lit[1:-1])
def js_encode(text):
    return "'" + text.replace('\\', '\\\\').replace("'", "\\'").replace('\n', '\\n') + "'"

def preview(text):
    if len(text) <= PREVIEW + 20: return text
    cut = text[:PREVIEW]
    cut = cut[:cut.rfind(' ')] if ' ' in cut else cut
    return cut.rstrip(' ,;:—–-') + '…'

s = open(INDEX, encoding='utf-8').read()
start = s.index('const SEED_DATA = [')
end = s.index('\n];', start)
seed = s[start:end]

# Texts already moved out
m = re.search(r"const TEXT_FILES = (\{.*?\});", s)
old_files = json.loads(m.group(1)) if m else {}
known = {}
for name in old_files.values():
    known.update(json.load(open(os.path.join(OUT, name + '.json'), encoding='utf-8')))

# Walk the entries in order
starts = [mm.start() for mm in re.finditer(r"\{ id:'", seed)] + [len(seed)]
pieces, texts, order = [seed[:starts[0]]], {}, {c: [] for c in CATS}
for a, b in zip(starts, starts[1:]):
    block = seed[a:b]
    head = re.match(r"\{ id:'([\w-]+)', category:'(\w+)'", block)
    if head and head.group(2) in CATS:
        eid, cat = head.group(1), head.group(2)
        full = dict(known.get(eid, {}))
        block = re.sub(r",? _t:'[\w-]+'", '', block)   # re-assigned below
        cm = re.search(r"\bcontent:(" + JS_STR + ")", block)
        if cm:
            text = js_decode(cm.group(1))
            if not text.endswith('…') or eid not in known: full['content'] = text
            full.setdefault('content', text)
            block = block[:cm.start(1)] + js_encode(preview(full['content'])) + block[cm.end(1):]
        im = re.search(r",?\s*\bintercession:(" + JS_STR + ")", block)
        if im:
            full['intercession'] = js_decode(im.group(1))
            block = block[:im.start()] + block[im.end():]
        if full.get('content') and (len(full['content']) > PREVIEW + 20 or full.get('intercession')):
            texts[eid] = {k: full[k] for k in ('content', 'intercession') if full.get(k)}
            order[cat].append(eid)
            cm = re.search(r"\bcontent:" + JS_STR, block)
            block = block[:cm.end()] + ", _t:'@" + eid + "'" + block[cm.end():]
    pieces.append(block)
seed = ''.join(pieces)

# Group into files and name each by its content
os.makedirs(OUT, exist_ok=True)
for f in os.listdir(OUT):
    if f.endswith('.json'): os.remove(os.path.join(OUT, f))
files, bucket_of = {}, {}
for cat in CATS:
    ids = order[cat]
    for n in range(0, len(ids), PER_FILE):
        key = f'{cat}-{n // PER_FILE}'
        chunk = {i: texts[i] for i in ids[n:n + PER_FILE]}
        body = json.dumps(chunk, ensure_ascii=False, separators=(',', ':'))
        name = key + '.' + hashlib.sha1(body.encode()).hexdigest()[:8]
        open(os.path.join(OUT, name + '.json'), 'w', encoding='utf-8', newline='\n').write(body)
        files[key] = name
        for i in chunk: bucket_of[i] = key
seed = re.sub(r"_t:'@([\w-]+)'", lambda mm: f"_t:'{bucket_of[mm.group(1)]}'", seed)

s = s[:start] + seed + s[end:]
line = 'const TEXT_FILES = ' + json.dumps(files, separators=(',', ':')) + ';'
if m: s = s.replace(m.group(0), line)
else: s = s.replace('const SEED_DATA = [', '// Long texts live in data/texts/ (see tools/slim_texts.py); each entry names its file in _t\n' + line + '\nconst SEED_DATA = [', 1)
open(INDEX, 'w', encoding='utf-8', newline='\n').write(s)
print(len(texts), 'entries moved into', len(files), 'files')
