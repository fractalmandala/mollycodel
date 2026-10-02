#!/usr/bin/env python3
"""Generate a patches/user/*.patch containing ONLY our own changes.

Why: after `./dev/build.sh -s` the vscode/ tree holds every built-in patch applied but
uncommitted, so `git diff` mixes other patches into ours. This builds a temporary git
index whose baseline is "the tree without our change" and diffs against that.

Usage (from the repo root):
    python3 dev/make-user-patch.py patches/user/20-foo.patch \
        --new  src/vs/a/new.ts src/vs/a/new2.ts \
        --edit src/vs/b/changed.ts:'import { X } from "./x.js";' ...

--new   files that do not exist upstream (they are added in full).
--edit  PATH:LINE   existing files where our change is only the ADDED LINE(s) matching
        LINE (substring match; may be repeated per file with several PATH:LINE pairs).
--revert-file PATH:SCRIPT  existing files whose baseline is produced by running SCRIPT
        (a python file defining revert(text)->text) over the current file.

The resulting patch is verified with `git apply --cached --check` against the baseline.
"""
import argparse, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VSCODE = os.path.join(ROOT, 'vscode')


def git(*args, env=None, inp=None, check=True):
    return subprocess.run(['git', *args], cwd=VSCODE, env=env, input=inp, capture_output=True, text=True, check=check)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--new', nargs='*', default=[])
    ap.add_argument('--edit', nargs='*', default=[])
    ap.add_argument('--revert-file', nargs='*', default=[])
    args = ap.parse_args()

    out = os.path.join(ROOT, args.out)
    idx = tempfile.mktemp(suffix='.idx')
    env = dict(os.environ, GIT_INDEX_FILE=idx)
    git('read-tree', 'HEAD', env=env)

    baselines = {}  # path -> baseline text
    edit_lines = {}
    for spec in args.edit:
        path, line = spec.split(':', 1)
        edit_lines.setdefault(path, []).append(line)
    for path, lines in edit_lines.items():
        text = open(os.path.join(VSCODE, path), encoding='utf-8').read().split('\n')
        kept, removed = [], 0
        for l in text:
            if any(needle in l for needle in lines):
                removed += 1
                continue
            kept.append(l)
        if removed < len(lines):
            sys.exit(f'{path}: found only {removed} of {len(lines)} lines to strip')
        baselines[path] = '\n'.join(kept)
    for spec in args.revert_file:
        path, script = spec.split(':', 1)
        ns = {}
        exec(open(script).read(), ns)
        baselines[path] = ns['revert'](open(os.path.join(VSCODE, path), encoding='utf-8').read())

    for path, text in baselines.items():
        mode = git('ls-files', '-s', path, env=env).stdout.split()[0]
        blob = git('hash-object', '-w', '--stdin', env=env, inp=text).stdout.strip()
        git('update-index', '--cacheinfo', f'{mode},{blob},{path}', env=env)
    for path in args.new:
        git('rm', '--cached', '-q', '--ignore-unmatch', path, env=env)
        git('add', '-N', path, env=env)

    paths = list(baselines) + args.new
    diff = git('diff', '-U1', '--', *paths, env=env).stdout
    open(out, 'w', encoding='utf-8').write(diff)
    check = git('apply', '--cached', '--check', out, env=env, check=False)
    os.unlink(idx)
    files = [l.split(' b/')[-1] for l in diff.split('\n') if l.startswith('diff --git')]
    print(f'{args.out}: {len(diff.splitlines())} lines, files: {files}')
    if check.returncode != 0:
        print('FORWARD APPLY CHECK FAILED:\n' + check.stderr)
        sys.exit(1)
    print('forward apply check: clean')


if __name__ == '__main__':
    main()
