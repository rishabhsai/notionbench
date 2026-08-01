# Notion CLI — team runbook

Half-written. The gaps are the bits I keep having to look up, and the bits CI
keeps getting wrong.

## Running `ntn` on the build box

The build box has no login keychain and no desktop session, so the CLI has to
keep credentials in a file instead of the OS keychain.

- env var: **TODO**
- value: **TODO**

Our CI images are also shared, so every job has to point the CLI's config and
auth state somewhere job-local rather than at the default location.

- env var: **TODO**

## Scripting against it

- `ntn whoami`, but machine-readable (the raw response, not the pretty table):
  **TODO**
- `ntn workers runs list`, but as tab-separated columns with no header row, so
  `cut -f1` works: **TODO**
- `ntn workers exec <key>`, but running the capability here on this machine
  instead of against the deployed worker: **TODO**

## Looking things up without leaving the terminal

- Print the full official markdown docs for an API endpoint straight from
  `ntn api`: **TODO**
- Turn a database id into the data source ids you can actually query:
  **TODO**
