# hidden-spec-cli-01-run-20261122-r2

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mitsukikun/hidden-spec-cli-01-run-20261122-r2/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mitsukikun/hidden-spec-cli-01-run-20261122-r2/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies AI-written edits to a tree of text files, in all four formats models use: unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON tool calls. It finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

A patch file, or standard input when no patch is given. `--format` picks one of `unified`, `search-replace`, `v4a` or `json` (`auto` detects it). `--check` reports what would change without writing anything. `--strict` matches lines exactly. Exit 0 lists the files changed, exit 1 lists every edit that failed, exit 2 is a usage, read, format or parse error.

---

<sub>Entered on [make.fun](https://make.fun/?ref=dr78ckwq&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
