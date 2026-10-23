"""Stamps the addresses of the site's own files in index.html with a fingerprint of their contents
(app/style.css, app/data.js, app/app.js, and the language files), so browsers keep each file until it
actually changes and always fetch the new one after an update.

Run it after changing any of those files:

    python tools/stamp.py
"""
import hashlib, os, re, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, 'index.html')
LANGS = ('es', 'pl', 'fr', 'pt', 'it', 'de', 'ru', 'uk')

def digest(*paths):
    h = hashlib.sha1()
    for p in paths:
        # the same fingerprint whatever line endings this copy was checked out with
        h.update(open(os.path.join(ROOT, p), 'rb').read().replace(b'\r\n', b'\n'))
    return h.hexdigest()[:8]

s = open(INDEX, encoding='utf-8').read()
stamps = {}
for name in ('app/style.css', 'app/data.js', 'app/app.js'):
    v = digest(name)
    s, n = re.subn(re.escape(name) + r'(\?v=[0-9a-f]+)?"', f'{name}?v={v}"', s)
    assert n == 1, (name, n)
    stamps[name] = v
v = digest(*[f'lang/{l}.js' for l in LANGS])
s, n = re.subn(r"lang/' \+ ui \+ '\.js(\?v=[0-9a-f]+)?\"", f"lang/' + ui + '.js?v={v}\"", s)
assert n == 1, ('lang', n)
stamps['lang'] = v
open(INDEX, 'w', encoding='utf-8', newline='\n').write(s)
print(' '.join(f'{k}={v}' for k, v in stamps.items()))
