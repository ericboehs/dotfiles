# Pi configuration

Reproducible configuration for [`pi`](https://pi.dev), installed by
`mise bootstrap` through the `bootstrap:pi` task.

Tracked here:

- Pi settings and pinned package sources
- approval-guardian policy
- local TypeScript extensions
- pi-footer layout

Intentionally left as machine-local runtime state:

- `auth.json` and other credentials
- `sessions/`
- downloaded `npm/` and `git/` packages
- generated model catalog and cache files
- `models.json`, which may contain machine-specific provider configuration
- trust decisions and web-search credentials

The pi-footer package temporarily comes from
[`ericboehs/pi-footer`](https://github.com/ericboehs/pi-footer), pinned to the
commit containing configurable provider-based cost hiding. Return the package
source in `settings.json` to npm after the upstream change is released.
