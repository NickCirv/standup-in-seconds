# standup-in-seconds

Your standup is in your git log. Stop pretending it isn't.

```bash
cd your-project && node /path/to/standup-in-seconds/index.js
```

*Yesterday: Fixed auth bug in login flow, Refactored user service*
*Today: Continuing API rate limiting work*
*Blockers: None*

Zero config. Zero API keys. Works from any git repo. Reads your commits, detects WIP, formats for wherever your standup lives.

---

## Install

```bash
# Run directly
node index.js

# Or install globally
npm install -g standup-in-seconds
standup
```

## Usage

```
node index.js [options]

OPTIONS:
  --format     Output format: slack | teams | plain | jira | clipboard
               Default: plain
  --since      Time window (git date syntax)
               Default: "24 hours ago" (auto-extends to 2 days if no results)
  --author     Filter by author name
               Default: your git config user.name
  --clipboard  Copy to clipboard (pbcopy on mac, xclip on linux)
  --help       Show help
```

## Format Examples

### Slack (`--format slack`)
```
*Yesterday*
• Fixed auth token expiry in login flow
• Refactored user service to use dependency injection

*Today*
• Continuing work on feature/rate-limiting
• In progress: src/middleware/rateLimit.js

*Blockers*
• None
```

### Microsoft Teams (`--format teams`)
```
**Yesterday**
1. Fixed auth token expiry in login flow
2. Refactored user service to use dependency injection

**Today**
1. Continuing work on feature/rate-limiting

**Blockers**
1. None
```

### Jira (`--format jira`)
```
*Yesterday*
* Fixed auth token expiry in login flow
* Refactored user service to use dependency injection

*Today*
* Continuing work on feature/rate-limiting

*Blockers*
* None
----
// Generated from 2 commits on feature/rate-limiting branch in myproject by Jane Doe
```

### Clipboard (`--format clipboard` or `--clipboard`)
Copies plain-text version to clipboard automatically.

## How It Works

**Commits (Yesterday section)**
- Reads `git log --since="24 hours ago"` filtered to your author
- Falls back to `--since="2 days ago"` automatically if nothing found
- Parses conventional commit prefixes: `feat:`, `fix:`, `refactor:`, `docs:`, etc.
- Deduplicates similar messages with fuzzy matching (80% similarity threshold)
- Groups multi-branch work when commits span multiple branches

**WIP Detection (Today section)**
- `git status --porcelain` for staged + modified files
- `git stash list` for stashed work
- Filters out noise (node_modules, lock files, map files)

**TODO Scanning**
- Scans recently changed files for `TODO:` comments
- Detects `BLOCKED:` TODOs and surfaces them as blockers

## Smart Grouping

Conventional commits are automatically mapped to human-readable verbs:

| Prefix | Output |
|--------|--------|
| `feat:` | Built |
| `fix:` | Fixed |
| `refactor:` | Refactored |
| `docs:` | Updated docs for |
| `test:` | Added tests for |
| `chore:` | Maintenance: |
| `perf:` | Improved performance of |

No prefix? The message is used as-is (capitalised).

## Edge Cases

- **No commits yesterday**: Outputs a friendly message instead of an empty section
- **Not a git repo**: Clear error with a sarcastic note
- **Multiple branches**: Groups and notes branches worked across
- **Duplicate commits**: Merges similar messages with a count (x2, x3)

## Examples

```bash
# Default plain text
node index.js

# Slack format, copy to clipboard
node index.js --format slack --clipboard

# Look back 3 days
node index.js --since "3 days ago"

# Another author's standup
node index.js --author "Jane Doe"

# Jira wiki markup
node index.js --format jira
```

## Philosophy

No config files. No `.standuprc`. No API keys. No LLMs.

Your commits already tell the story. This tool just formats it for whatever meeting platform your company insists on using.

## License

MIT
