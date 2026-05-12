# Contributing

Use `pnpm` for all JavaScript and TypeScript work and `uv` for the Python gate wrapper.

```bash
pnpm install
pnpm verify
uv run devtools/gate.py
```

Public behavior changes update code, tests, `ARCH.md`, and `README.md` together. Plugin packaging changes must prove the installed plugin launcher, not only source `dist` files.

Do not commit generated dependency bundles into `plugin/bin`. The plugin launcher is intentionally small and delegates to the pinned npm runtime package.

Refresh packaged delegate roles only through:

```bash
pnpm roles:sync
pnpm roles:check
```
