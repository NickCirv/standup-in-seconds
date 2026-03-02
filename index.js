#!/usr/bin/env node

/**
 * standup-in-seconds
 * Your git log is your standup. Stop pretending it isn't.
 *
 * Usage: node index.js [--format slack|teams|plain|jira|clipboard] [--since "2 days ago"] [--author "me"]
 */

import { execSync, execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';

// ─── CLI ARG PARSING ───────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag, defaultVal = null) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) {
    return args[idx + 1];
  }
  return defaultVal;
}

function hasFlag(flag) {
  return args.includes(flag);
}

const format = getArg('--format', 'plain');
const sinceArg = getArg('--since', null);
const authorArg = getArg('--author', null);
const copyToClipboard = hasFlag('--clipboard') || format === 'clipboard';
const showHelp = hasFlag('--help') || hasFlag('-h');

const VALID_FORMATS = ['slack', 'teams', 'plain', 'jira', 'clipboard'];

// ─── HELP ─────────────────────────────────────────────────────────────────

if (showHelp) {
  console.log(`
standup-in-seconds

Turn your git log into a standup update. No API keys. No config. Just git.

USAGE:
  node index.js [options]
  standup [options]          (if installed globally via npm link)

OPTIONS:
  --format     Output format: slack | teams | plain | jira | clipboard
               Default: plain
  --since      Timeframe for commits (git date syntax)
               Default: "24 hours ago" (auto-falls back to "2 days ago" if empty)
  --author     Filter by author name
               Default: your git config user.name
  --clipboard  Copy output to clipboard (pbcopy on mac, xclip on linux)
  --help       Show this help

EXAMPLES:
  node index.js
  node index.js --format slack
  node index.js --format jira --since "2 days ago"
  node index.js --author "Jane Doe"
  node index.js --format slack --clipboard
`);
  process.exit(0);
}

if (!VALID_FORMATS.includes(format)) {
  console.error(`Unknown format "${format}". Valid options: ${VALID_FORMATS.join(', ')}`);
  process.exit(1);
}

// ─── GIT HELPERS ─────────────────────────────────────────────────────────

// Safe exec using execFileSync — arguments are passed as array, no shell injection
function git(...gitArgs) {
  try {
    return execFileSync('git', gitArgs, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

// For simple system commands (grep, wc, etc.) — all args are static literals
function runShell(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function assertGitRepo() {
  const result = git('rev-parse', '--is-inside-work-tree');
  if (result !== 'true') {
    console.error(`
Not a git repo. standup-in-seconds must be run from inside a git repository.

"No git history? Must have been a very productive meeting day."
`);
    process.exit(1);
  }
}

function getAuthor() {
  if (authorArg && authorArg !== 'me') return authorArg;
  const name = git('config', 'user.name');
  if (name) return name;
  // fallback: system user
  return runShell('whoami') || 'unknown';
}

function getCurrentBranch() {
  return git('branch', '--show-current') || git('rev-parse', '--abbrev-ref', 'HEAD') || 'main';
}

function getRepoName() {
  const remoteUrl = git('config', '--get', 'remote.origin.url');
  if (remoteUrl) {
    const match = remoteUrl.match(/[/:]([^/:]+?)(?:\.git)?$/);
    if (match) return match[1];
  }
  const toplevel = git('rev-parse', '--show-toplevel');
  if (toplevel) return toplevel.split('/').pop();
  return 'this-repo';
}

// ─── COMMIT FETCHING ──────────────────────────────────────────────────────

function fetchCommits(since, author) {
  // all args as array — safe from shell injection
  const gitArgs = [
    'log',
    `--since=${since}`,
    `--author=${author}`,
    '--format=%H|%s|%ai',
    '--no-merges',
  ];

  const raw = git(...gitArgs);
  if (!raw) return [];

  return raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [hash, subject, date] = line.split('|');
      return {
        hash: (hash || '').trim(),
        subject: (subject || '').trim(),
        date: (date || '').trim(),
      };
    })
    .filter(c => c.hash && c.subject);
}

// ─── COMMIT PARSING / CATEGORISATION ─────────────────────────────────────

const PREFIXES = {
  feat:     { verb: 'Built',               category: 'features' },
  feature:  { verb: 'Built',               category: 'features' },
  add:      { verb: 'Added',               category: 'features' },
  fix:      { verb: 'Fixed',               category: 'fixes' },
  bugfix:   { verb: 'Fixed',               category: 'fixes' },
  hotfix:   { verb: 'Fixed (hotfix)',       category: 'fixes' },
  refactor: { verb: 'Refactored',          category: 'improvements' },
  perf:     { verb: 'Improved performance of', category: 'improvements' },
  improve:  { verb: 'Improved',            category: 'improvements' },
  docs:     { verb: 'Updated docs for',   category: 'docs' },
  doc:      { verb: 'Updated docs for',   category: 'docs' },
  test:     { verb: 'Added tests for',    category: 'tests' },
  tests:    { verb: 'Added tests for',    category: 'tests' },
  chore:    { verb: 'Maintenance:',        category: 'chores' },
  ci:       { verb: 'CI/CD:',             category: 'chores' },
  build:    { verb: 'Build:',             category: 'chores' },
  style:    { verb: 'Styled',             category: 'improvements' },
  revert:   { verb: 'Reverted',           category: 'fixes' },
  wip:      { verb: 'WIP:',              category: 'wip' },
  release:  { verb: 'Released',           category: 'releases' },
  remove:   { verb: 'Removed',            category: 'improvements' },
  delete:   { verb: 'Deleted',            category: 'improvements' },
  update:   { verb: 'Updated',            category: 'improvements' },
};

function parseCommit(subject) {
  // conventional commit format: type(scope): description
  const conventionalMatch = subject.match(/^(\w+)(?:\(([^)]+)\))?\s*!?\s*:\s*(.+)$/);

  if (conventionalMatch) {
    const [, type, scope, description] = conventionalMatch;
    const prefixInfo = PREFIXES[type.toLowerCase()];
    const verb = prefixInfo ? prefixInfo.verb : capitalize(type) + ':';
    const category = prefixInfo ? prefixInfo.category : 'other';
    const scopeStr = scope ? ` ${scope}` : '';
    return {
      verb,
      category,
      description: description.trim(),
      scope: scope || null,
      formatted: `${verb}${scopeStr ? ' ' + scopeStr : ''} ${description.trim()}`,
    };
  }

  // no prefix — keep as-is but capitalise
  return {
    verb: '',
    category: 'other',
    description: subject,
    scope: null,
    formatted: capitalize(subject),
  };
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ─── DEDUPLICATION ────────────────────────────────────────────────────────

function similarity(a, b) {
  const la = (a || '').toLowerCase();
  const lb = (b || '').toLowerCase();

  if (la === lb) return 1;
  if (!la || !lb) return 0;

  const longer = la.length >= lb.length ? la : lb;
  const shorter = la.length >= lb.length ? lb : la;

  if (longer.length === 0) return 1;

  let matches = 0;
  let si = 0;
  for (let i = 0; i < longer.length && si < shorter.length; i++) {
    if (longer[i] === shorter[si]) {
      matches++;
      si++;
    }
  }
  return matches / longer.length;
}

function deduplicate(items) {
  const result = [];
  const counts = new Map();

  for (const item of items) {
    let merged = false;
    for (const existing of result) {
      if (similarity(item.formatted, existing.formatted) >= 0.8) {
        counts.set(existing.formatted, (counts.get(existing.formatted) || 1) + 1);
        merged = true;
        break;
      }
    }
    if (!merged) {
      result.push(item);
      counts.set(item.formatted, 1);
    }
  }

  return result.map(item => {
    const count = counts.get(item.formatted) || 1;
    return {
      ...item,
      formatted: count > 1 ? `${item.formatted} (x${count})` : item.formatted,
    };
  });
}

// ─── WIP DETECTION ───────────────────────────────────────────────────────

function getWIPInfo() {
  const status = git('status', '--porcelain');
  const stash = git('stash', 'list');

  const modified = [];
  const staged = [];

  for (const line of (status || '').split('\n').filter(Boolean)) {
    const flag = line.slice(0, 2);
    const filePath = line.slice(3).trim().split(' -> ').pop() || '';

    // skip noise
    if (
      filePath.includes('node_modules') ||
      filePath.endsWith('.lock') ||
      filePath.endsWith('.log') ||
      filePath.endsWith('.map')
    ) continue;

    if (flag[0] !== ' ' && flag[0] !== '?') staged.push(filePath);
    else if (flag[1] === 'M' || flag[1] === 'D' || flag[1] === 'A') modified.push(filePath);
  }

  const stashLines = (stash || '').split('\n').filter(Boolean);
  const stashCount = stashLines.length;

  return {
    modified,
    staged,
    stashCount,
    hasWIP: modified.length > 0 || staged.length > 0,
  };
}

// ─── TODO DETECTION ──────────────────────────────────────────────────────

function getTODOs() {
  const recentFilesRaw = git('diff', '--name-only', 'HEAD~5', 'HEAD');
  const stagedRaw = git('diff', '--name-only', '--cached');
  const allFiles = [...new Set([
    ...(recentFilesRaw || '').split('\n'),
    ...(stagedRaw || '').split('\n'),
  ])].filter(f => f && !f.includes('node_modules') && existsSync(f));

  const todos = [];
  const blocked = [];

  for (const file of allFiles.slice(0, 10)) {
    try {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        const todoMatch = line.match(/TODO\s*:?\s*(.+)/i);
        if (todoMatch) {
          const text = todoMatch[1].trim().slice(0, 80);
          if (/BLOCKED/i.test(text)) {
            blocked.push(`${text} (${file}:${i + 1})`);
          } else {
            todos.push(text);
          }
        }
      });
    } catch {
      // file unreadable — skip
    }
  }

  return { todos: todos.slice(0, 4), blocked: blocked.slice(0, 3) };
}

// ─── FORMATTERS ──────────────────────────────────────────────────────────

function bulletList(items, style) {
  switch (style) {
    case 'slack':  return items.map(i => `\u2022 ${i}`).join('\n');
    case 'teams':  return items.map((i, n) => `${n + 1}. ${i}`).join('\n');
    case 'jira':   return items.map(i => `* ${i}`).join('\n');
    default:       return items.map(i => `- ${i}`).join('\n');
  }
}

function bold(text, style) {
  switch (style) {
    case 'slack': return `*${text}*`;
    case 'teams': return `**${text}**`;
    case 'jira':  return `*${text}*`;
    default:      return text.toUpperCase();
  }
}

function buildOutput({ yesterdayItems, todayItems, blockers, meta, style }) {
  const effectiveStyle = style === 'clipboard' ? 'plain' : style;
  const lines = [];

  // Yesterday
  lines.push(bold('Yesterday', effectiveStyle));
  if (yesterdayItems.length === 0) {
    lines.push(bulletList(
      ['No commits found — either a meeting day or the code lives in your head rent-free'],
      effectiveStyle
    ));
  } else {
    lines.push(bulletList(yesterdayItems, effectiveStyle));
  }

  lines.push('');

  // Today
  lines.push(bold('Today', effectiveStyle));
  if (todayItems.length === 0) {
    lines.push(bulletList(['Planning / picking up where I left off'], effectiveStyle));
  } else {
    lines.push(bulletList(todayItems, effectiveStyle));
  }

  lines.push('');

  // Blockers
  lines.push(bold('Blockers', effectiveStyle));
  lines.push(bulletList(blockers.length > 0 ? blockers : ['None'], effectiveStyle));

  if (effectiveStyle === 'jira') {
    lines.push('');
    lines.push('----');
  }

  lines.push('');
  lines.push(`// ${meta}`);

  return lines.join('\n');
}

// ─── CLIPBOARD ───────────────────────────────────────────────────────────

function copyToClip(text) {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      execFileSync('pbcopy', [], { input: text });
      return true;
    } else if (platform === 'linux') {
      try {
        execFileSync('xclip', ['-selection', 'clipboard'], { input: text });
        return true;
      } catch {
        execFileSync('xsel', ['--clipboard', '--input'], { input: text });
        return true;
      }
    } else if (platform === 'win32') {
      execFileSync('clip', [], { input: text });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

// ─── MULTI-BRANCH HANDLING ────────────────────────────────────────────────

function detectMultipleBranches(since, author) {
  const raw = git(
    'log', '--all',
    `--since=${since}`,
    `--author=${author}`,
    '--format=%D',
    '--no-merges'
  );

  const branches = new Set();
  for (const line of (raw || '').split('\n').filter(Boolean)) {
    for (const ref of line.split(',').map(r => r.trim())) {
      const match = ref.match(/^(?:HEAD -> |origin\/)?(.+)$/);
      if (match && !match[1].includes('HEAD')) {
        branches.add(match[1].replace(/^origin\//, ''));
      }
    }
  }

  return [...branches].filter(Boolean);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────

function main() {
  assertGitRepo();

  const author = getAuthor();
  const branch = getCurrentBranch();
  const repoName = getRepoName();

  // determine time window
  const sinceWindow = sinceArg || '24 hours ago';
  let commits = fetchCommits(sinceWindow, author);

  // fallback: extend to 2 days if nothing found with default window
  if (commits.length === 0 && !sinceArg) {
    commits = fetchCommits('2 days ago', author);
  }

  // detect multiple branches
  const allBranches = detectMultipleBranches(sinceArg || '2 days ago', author);
  const isMultiBranch = allBranches.length > 1;

  // parse and deduplicate commits for "yesterday" section
  const parsedCommits = commits.map(c => ({ ...c, ...parseCommit(c.subject) }));
  const uniqueCommits = deduplicate(parsedCommits);
  let yesterdayItems = uniqueCommits.map(c => c.formatted);

  // if multiple branches, note it
  if (isMultiBranch) {
    yesterdayItems = [
      `(Work across ${allBranches.length} branches: ${allBranches.slice(0, 3).join(', ')}${allBranches.length > 3 ? '...' : ''})`,
      ...yesterdayItems,
    ];
  }

  // today section
  const wip = getWIPInfo();
  const todayItems = [];

  todayItems.push(`Continuing work on ${branch}`);

  if (wip.staged.length > 0) {
    const fileList = wip.staged.slice(0, 3).join(', ') + (wip.staged.length > 3 ? ` (+${wip.staged.length - 3} more)` : '');
    todayItems.push(`Staged: ${fileList}`);
  }

  if (wip.modified.length > 0) {
    const fileList = wip.modified.slice(0, 3).join(', ') + (wip.modified.length > 3 ? ` (+${wip.modified.length - 3} more)` : '');
    todayItems.push(`In progress: ${fileList}`);
  }

  if (wip.stashCount > 0) {
    todayItems.push(`${wip.stashCount} stashed change${wip.stashCount > 1 ? 's' : ''} to revisit`);
  }

  // TODOs
  const { todos, blocked } = getTODOs();

  if (todos.length > 0) {
    todayItems.push(`Pending TODOs: ${todos.slice(0, 2).join('; ')}`);
  }

  // blockers
  const blockers = [...blocked];

  // meta line
  const fileCount = commits.length > 0
    ? parseInt(git('diff', `--since=${sinceWindow}`, '--name-only').split('\n').filter(Boolean).length, 10) || commits.length
    : 0;

  const meta = [
    `Generated from ${commits.length} commit${commits.length !== 1 ? 's' : ''}`,
    `on ${branch} branch`,
    `in ${repoName}`,
    `by ${author}`,
  ].join(' ');

  const output = buildOutput({
    yesterdayItems,
    todayItems,
    blockers,
    meta,
    style: format,
  });

  // print
  console.log('\n' + output + '\n');

  // clipboard
  if (copyToClipboard) {
    const copied = copyToClip(output);
    if (copied) {
      console.log('Copied to clipboard');
    } else {
      console.log('Could not copy to clipboard — install pbcopy (mac) or xclip (linux)');
    }
  }
}

main();
