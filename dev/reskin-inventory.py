#!/usr/bin/env python3
"""Measure how much of the app's look lives where, so reskinning progress is checkable.

Counts CSS files, hard-coded `px` literals and `--vscode-*` variables per area, and lists the
layout constants in code that must change together with any CSS size change.

Usage (from the repo root, after ./dev/build.sh has fetched vscode/):
    python3 dev/reskin-inventory.py
"""
import collections
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'vscode', 'src', 'vs')
AREAS = {
    'workbench parts (chrome)': 'workbench/browser',
    'workbench contrib (features)': 'workbench/contrib',
    'agents window': 'sessions',
    'editor': 'editor',
    'platform': 'platform',
}
CONSTANT = re.compile(r'(?:static\s+readonly\s+|export\s+const\s+|const\s+)([A-Z][A-Z0-9_]*(?:WIDTH|HEIGHT|SIZE|MARGIN|GAP|PADDING)[A-Z0-9_]*)\s*(?::[^=]+)?=\s*(\d+)')
CONSTANT_DIRS = ['workbench/browser', 'workbench/services/layout', 'sessions/browser']


def walk(base, suffix):
    for directory, _, files in os.walk(os.path.join(ROOT, base)):
        for name in files:
            if name.endswith(suffix):
                yield os.path.join(directory, name)


def main():
    if not os.path.isdir(ROOT):
        sys.exit(f'vscode/src/vs not found at {ROOT}; run ./dev/build.sh first.')

    print('CSS by area')
    variables = collections.Counter()
    for label, base in AREAS.items():
        files = px = 0
        for path in walk(base, '.css'):
            text = open(path, errors='ignore').read()
            files += 1
            px += len(re.findall(r'\b\d+(?:\.\d+)?px', text))
            variables.update(re.findall(r'var\((--vscode-[\w-]+)', text))
        print(f'  {label:32} {files:4} files {px:6} px literals')
    print(f'  distinct --vscode-* variables read: {len(variables)}')
    print('  most used:', ', '.join(f'{name} ({count})' for name, count in variables.most_common(5)))

    print('\nLayout constants in code (change these in step with any CSS size change)')
    found = []
    for base in CONSTANT_DIRS:
        for path in walk(base, '.ts'):
            for match in CONSTANT.finditer(open(path, errors='ignore').read()):
                found.append((os.path.relpath(path, ROOT), match.group(1), match.group(2)))
    for path, name, value in sorted(found):
        print(f'  {value:>5}  {name:42} {path}')
    print(f'  {len(found)} constants')


if __name__ == '__main__':
    main()
