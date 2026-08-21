# Pi configuration

Reproducible configuration for [`pi`](https://pi.dev), installed by
`mise bootstrap` through the `bootstrap:pi` task.

Tracked here:

- Pi settings and pinned package sources
- custom keybindings (e.g. Opt+Enter inserts a newline)
- approval-guardian policy
- local TypeScript extensions, plus the tooling to check them

## Checking the extensions

```sh
bin/pi-ext-check                  # typecheck + smoke tests
bin/pi-ext-check --typecheck-only
bin/pi-ext-check --test-only
```

The extensions are typechecked against the globally installed pi rather than a
vendored dependency: `pi-ext-check` symlinks `.pi-agent/node_modules` to that
install (`@earendil-works/pi-coding-agent`, `pi-tui`, `@types/node`) and runs
`tsc` from `npx`. `tsconfig.json` sets `erasableSyntaxOnly`, because pi loads
`.ts` extensions through Node's type stripping — syntax that needs real
compilation (parameter properties, enums, namespaces) fails at load time
otherwise.

`tsconfig.json`, `package.json` and `test/` deliberately sit beside
`extensions/` rather than inside it: mise links that directory into
`~/.pi/agent/extensions` with `symlink-each`, so anything in it becomes
something pi tries to load.

Intentionally left as machine-local runtime state:

- `auth.json` and other credentials
- `sessions/`
- downloaded `npm/` and `git/` packages
- generated model catalog and cache files
- `models.json`, which may contain machine-specific provider configuration
- trust decisions and web-search credentials
- `.pi-agent/node_modules/`, the symlinks `bin/pi-ext-check` creates
