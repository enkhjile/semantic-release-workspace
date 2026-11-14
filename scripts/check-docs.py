"""Check repository Markdown whitespace and local inline/reference link files.

External URLs and heading fragments are intentionally not checked offline.
"""

import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

files = subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0')
errors = []
for name in files:
    if name not in ('README.md', 'CONTRIBUTING.md', 'AGENTS.md') and not (
        name.startswith('docs/') and name.endswith('.md')
    ):
        continue
    path = Path(name)
    if not path.exists():
        continue
    text = path.read_text()
    for number, line in enumerate(text.splitlines(), 1):
        # Two trailing spaces are a Markdown hard line break.
        if line.endswith('\t') or (line.endswith(' ') and not (
            line.endswith('  ') and not line.endswith('   ')
        )):
            errors.append(f'{name}:{number}: trailing whitespace')
    if text and not text.endswith('\n'):
        errors.append(f'{name}: missing final newline')
    # Ignore fenced examples and inline code before checking prose links.
    prose = re.sub(r'^(`{3,}|~{3,}).*?^\1[^\n]*$', '', text, flags=re.M | re.S)
    prose = re.sub(r'`[^`\n]*`', '', prose)
    targets = re.findall(r'\]\(\s*(<[^>]+>|[^\s)]+)', prose)
    targets += re.findall(r'^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)', prose, re.M)
    for target in targets:
        url = urlsplit(target.strip('<>'))
        if url.scheme or url.netloc or not url.path:
            continue
        local = unquote(url.path)
        destination = Path(local.lstrip('/')) if local.startswith('/') else path.parent / local
        if not destination.exists():
            errors.append(f'{name}: missing local link target {target}')
if errors:
    print('\n'.join(errors), file=sys.stderr)
    sys.exit(1)
print('Documentation whitespace and local file links passed.')
