# Pi CCUI Statusline

A global Pi extension that replaces Pi's TUI footer with a compact Claude-Code-style statusline.

## What it shows

- Current provider, model, and thinking level
- Current working directory basename
- Git branch
- Context usage percentage and token/window totals
- Total assistant input/output token totals and cost for the current branch
- Last assistant output throughput in tokens/second
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
npm run check
```

If `pnpm` is already on your `PATH`, the equivalent commands also work:

```bash
pnpm install
pnpm check
```

`check` runs strict TypeScript validation and the lifecycle, stale-context,
terminal-safety, Unicode-width, and reload smoke suite.

The package manifest exposes `./pi-mystatusline.ts` through the `pi.extensions` field for optional package-style loading. Runtime dependencies on Pi core packages are declared as peer dependencies because Pi provides them when loading extensions.

## Safety notes

The extension only reads Pi session and footer metadata. It does not launch Git commands, execute repository-configured helpers, modify global Pi config, commit files, or change the current repository.
