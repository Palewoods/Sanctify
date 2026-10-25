"""Keeps the translations of the library's own texts (the lives and prayers of the saints, history, books,
teachings, and prayers) in each language.

Short texts, and the previews of long ones, go into lang/<lang>.js under "entries". Long texts go into
data/texts/<lang>/, grouped like the English files (TEXT_FILES in app/data.js), so that opening an entry
loads its English and its translation together; the language file names them under "texts".

    python tools/lang_texts.py               regroup the translations after tools/slim_texts.py has run
    python tools/lang_texts.py new.json      add translations, given as {"es": {"s1": {"content": "…", "intercession": "…"}}, …}

Each translation can carry content, intercession, and notable. Run tools/stamp.py afterwards.
"""
import hashlib, json, os, re, sys
sys.stdout.reconfigure(encoding='utf-8')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LANGS = ('es', 'pl', 'fr', 'pt', 'it', 'de', 'ru', 'uk')
FIELDS = ('content', 'intercession', 'notable')
PREVIEW = 200      # as in tools/slim_texts.py

def preview(text):
    if len(text) <= PREVIEW + 20: return text
    cut = text[:PREVIEW]
    cut = cut[:cut.rfind(' ')] if ' ' in cut else cut
    return cut.rstrip(' ,;:—–-') + '…'

# Which English file each long text is in
data_js = open(os.path.join(ROOT, 'app', 'data.js'), encoding='utf-8').read()
file_of = dict(re.findall(r"\{ id:'([\w-]+)'(?:(?!\{ id:').)*?_t:'([\w-]+)'", data_js, re.S))

new = json.load(open(sys.argv[1], encoding='utf-8')) if len(sys.argv) > 1 else {}
for lang in LANGS:
    path = os.path.join(ROOT, 'lang', lang + '.js')
    src = open(path, encoding='utf-8').read()
    head = src[:src.index('window.SANCTIFY_I18N')]
    data = json.loads(src[src.index('= ') + 2:src.rstrip().rindex(';')])
    # Everything translated so far, in full
    full = {i: t for i, t in data.get('entries', {}).items() if i not in file_of}
    out_dir = os.path.join(ROOT, 'data', 'texts', lang)
    for name in data.get('texts', {}).values():
        full.update(json.load(open(os.path.join(out_dir, name + '.json'), encoding='utf-8')))
    for i, t in new.get(lang, {}).items():
        full[i] = {**full.get(i, {}), **{f: v for f, v in t.items() if f in FIELDS and v}}
    # Regroup
    entries, chunks = {}, {}
    for i in sorted(full, key=lambda x: (re.sub(r'\d+', '', x), int(re.sub(r'\D', '', x) or 0))):
        t = full[i]
        if i in file_of:
            chunks.setdefault(file_of[i], {})[i] = t
            if t.get('content'): entries[i] = {'content': preview(t['content'])}
        else:
            entries[i] = t
    os.makedirs(out_dir, exist_ok=True)
    for f in os.listdir(out_dir):
        if f.endswith('.json'): os.remove(os.path.join(out_dir, f))
    texts = {}
    for key in sorted(chunks):
        body = json.dumps(chunks[key], ensure_ascii=False, separators=(',', ':'))
        name = key + '.' + hashlib.sha1(body.encode()).hexdigest()[:8]
        open(os.path.join(out_dir, name + '.json'), 'w', encoding='utf-8', newline='\n').write(body)
        texts[key] = name
    data['entries'], data['texts'] = entries, texts
    open(path, 'w', encoding='utf-8', newline='\n').write(head + 'window.SANCTIFY_I18N = ' + json.dumps(data, ensure_ascii=False, indent=0) + ';\n')
    print(lang, len(full), 'texts,', len(texts), 'files')
