# Repository Instructions

## Production configuration and data are not deployment inputs

- A bug fix or code deployment does not authorize resetting, regenerating,
  migrating, replacing or changing production configuration. Change a setting
  only when the user explicitly requests that setting change.
- Preserve `/mnt/data/qq-agent/data/config.json` and the entire production data
  directory, including persona cards, custom rules, credentials, chat settings,
  access lists, databases, runtime state and backups. Never replace them with
  repository defaults, local test configuration or an older deployment bundle.
- For code-only deployments, use an explicit allowlist of code files. Do not run
  `configure-linux.mjs`, initialization/import/reset scripts, or a full installer
  against an existing production data directory. Never delete or synchronize
  over `data/` with `git clean`, archive extraction or `rsync --delete`.
- Before deployment, make a restricted backup without changing the original;
  record the configuration SHA-256, owner and mode. Verify that the configuration
  bytes, owner and mode are unchanged after deployment and service restart.
  If they differ, stop and investigate; never silently restore an old backup
  over potentially newer user changes. Roll back code independently of data.
- Run production configuration tools only as the actual service user (`admin`
  on the current server), never as root. Never import the production config
  module in a root-run diagnostic: a seemingly read-only getter may persist.
- Tests must use a temporary `QQ_AGENT_DATA_DIR`; installer tests must also use
  an isolated home directory. Do not test against production data, credentials,
  running application ports or QQ accounts. Never replay an external write
  whose result is unknown.
- An unreadable or invalid existing config is an error, not a first install.
  Do not fall back to defaults and save them. Missing capability or an
  unsupported OneBot API must not cause configuration reset or automatic
  feature/credential changes.
- Do not print credentials or copy production config into Git. Report the
  deployed commit, validation results, backup location and config hash check.

When adding or changing an experimental feature, follow
[`docs/EXPERIMENTAL_FEATURE_STANDARD.md`](docs/EXPERIMENTAL_FEATURE_STANDARD.md).

In particular:

- treat each experimental feature as an independently owned module;
- keep the experiment settings page limited to enable/disable and graduation;
- give any feature with operational UI its own page;
- keep runtime enablement separate from the persistent `graduated` state;
- preserve data while disabled and never auto-retry unknown external writes.
