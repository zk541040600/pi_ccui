# Pi CCUI Statusline

A global Pi extension that replaces Pi's TUI footer with a compact Claude-Code-style statusline.

## What it shows

- Current provider, model, and thinking level
- Current working directory basename
- Git branch
- Context usage percentage and token/window totals
- Total assistant input/output token totals and cost for the current branch
- Last assistant output throughput in tokens/second
- Dirty workspace line stats (`+added` / `-removed`)
- Non-noisy extension statuses

## Global placement

This extension lives in its own git repo under the global Pi git path:

```text
~/.pi/agent/git/github.com/zk541040600/pi_ccui/pi-ccui-statusline/
```

A symlink from the extensions directory keeps Pi loading it:

```text
~/.pi/agent/extensions/pi-ccui-statusline
  → ~/.pi/agent/git/github.com/zk541040600/pi_ccui/pi-ccui-statusline
```

Enable it from `~/.pi/agent/settings.json` (already set up):

```json
"extensions": [
  "./extensions/pi-ccui-statusline/pi-mystatusline.ts"
]
```

Then restart Pi or run `/reload` in an existing Pi TUI session.

## Development

```bash
cd ~/.pi/agent/git/github.com/zk541040600/pi_ccui/pi-ccui-statusline
corepack pnpm install
./node_modules/.bin/tsc --noEmit
```

If `pnpm` is already on your `PATH`, the equivalent commands also work:

```bash
pnpm install
pnpm exec tsc --noEmit
```

The package manifest exposes `./pi-mystatusline.ts` through the `pi.extensions` field for optional package-style loading. Runtime dependencies on Pi core packages are declared as peer dependencies because Pi provides them when loading extensions.

## Safety notes

The extension only reads session metadata and git workspace status. It does not modify global Pi config, does not commit files, and does not change the current repository.
