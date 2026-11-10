/**
 * Strict secret audit (Requirement: zero private keys in tracked files).
 *
 * Checks:
 *  1. .gitignore blocks .env / .env.local / .env.* while allowing .env.example
 *  2. .env.local exists locally but is NOT tracked by git
 *  3. NO tracked file contains a hex private key (64 hex chars after 0x),
 *     PEM key headers, or a real-looking TEST_USER_PRIVATE_KEY assignment
 *  4. .env.example contains only zero-key placeholders
 *
 * Run: npm run audit:secrets   (exit 1 on any leak)
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

let failures = 0;
const fail = (msg: string): void => {
  failures += 1;
  console.error(`  ❌ ${msg}`);
};
const pass = (msg: string): void => {
  console.log(`  ✅ ${msg}`);
};

const HEX_KEY_EXACT = /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
const PLACEHOLDER_KEY = /^0x0{64}$/i;
/** keccak256("") — a public constant, never a key. */
const KNOWN_PUBLIC_CONSTANTS = new Set(['0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470']);
/** Compiler artifacts whose long hex is contract BYTECODE, not key material. */
const BYTECODE_ARTIFACT_DIRS = ['src/generated'];
/**
 * Evidence/docs legitimately contain PUBLIC on-chain identifiers (tx hashes,
 * keccak observation hashes, ruleHash/proofDigest — all verifiable on
 * PharosScan). The generic hex-shape scan is exempt there, but the PRECISE
 * checks (actual .env.local secret value, PEM blocks, non-placeholder
 * PRIVATE_KEY assignments) still apply to every tracked file without exception.
 */
const PUBLIC_ID_DOCS = ['evidence/', 'SUBMISSION_EVIDENCE.md', 'README.md'];

function gitTrackedFiles(): string[] {
  try {
    const out = execSync('git ls-files -z', { cwd: root, encoding: 'utf8' });
    return out.split('\0').filter(Boolean);
  } catch {
    // not a git repo (yet) — fall back to walking the tree minus ignore rules
    const skip = new Set(['node_modules', '.next', '.git', '.data', 'evidence', '.env.local']);
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else files.push(path.relative(root, p));
      }
    };
    walk(root);
    return files;
  }
}

console.log('Pharos Trend Watcher — secret audit');
console.log('='.repeat(60));

// 1. .gitignore policy
const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
const hasEnvLocal = /^\.env\.local$/m.test(gitignore);
const hasEnvStar = /^\.env\.\*$/m.test(gitignore);
const allowsExample = /^!\.env\.example$/m.test(gitignore);
if (hasEnvLocal && hasEnvStar && allowsExample) pass('.gitignore blocks .env.local / .env.* and keeps .env.example');
else fail(`.gitignore policy incomplete (local=${hasEnvLocal} star=${hasEnvStar} example=${allowsExample})`);

// 2. .env.local present locally, never tracked
const envLocalPath = path.join(root, '.env.local');
if (fs.existsSync(envLocalPath)) pass('.env.local exists on disk (secrets live only here)');
else fail('.env.local missing — copy .env.example to .env.local before running live verification');

const tracked = gitTrackedFiles();
if (tracked.some((f) => f === '.env.local')) fail('.env.local IS TRACKED — remove it from git immediately!');
else pass('.env.local is NOT tracked by git');

// 3. scan every tracked file for key material
let scanned = 0;

/** The single most precise check: the ACTUAL secret value must appear nowhere. */
const envLocalContent = fs.existsSync(envLocalPath) ? fs.readFileSync(envLocalPath, 'utf8') : '';
const actualSecret = /^[A-Z_]*PRIVATE_KEY[A-Z_]*\s*=\s*(\S+)/m.exec(envLocalContent)?.[1]?.trim() ?? null;
const actualSecretNormalized = actualSecret && actualSecret !== '' && !PLACEHOLDER_KEY.test(actualSecret) ? actualSecret.toLowerCase() : null;

for (const rel of tracked) {
  const abs = path.join(root, rel);
  let content: string;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  scanned += 1;

  if (actualSecretNormalized && content.toLowerCase().includes(actualSecretNormalized)) {
    fail(`${rel}: contains THE ACTUAL .env.local private key — CRITICAL LEAK`);
  }

  const pem = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content);
  if (pem) fail(`${rel}: contains a PEM private key block`);

  const isArtifact = BYTECODE_ARTIFACT_DIRS.some((d) => rel.replaceAll('\\', '/').startsWith(d));
  const isPublicIdDoc = PUBLIC_ID_DOCS.some((d) => rel.replaceAll('\\', '/').startsWith(d));

  for (const match of content.matchAll(HEX_KEY_EXACT)) {
    const candidate = match[0];
    if (PLACEHOLDER_KEY.test(candidate)) continue; // documented zero placeholder
    if (KNOWN_PUBLIC_CONSTANTS.has(candidate.toLowerCase())) continue; // public hash constants
    if (isArtifact) continue; // contract bytecode artifacts
    if (isPublicIdDoc) continue; // public tx/keccak identifiers (precise checks below stay global)
    fail(`${rel}: contains a 64-hex private-key-like literal (${candidate.slice(0, 10)}…${candidate.slice(-4)})`);
  }

  const keyAssign = /^[A-Z_]*PRIVATE_KEY[A-Z_]*\s*=\s*(.+)$/gm;
  for (const m of content.matchAll(keyAssign)) {
    const value = (m[1] ?? '').trim();
    if (PLACEHOLDER_KEY.test(value) || value === '' || value.startsWith('<')) continue;
    fail(`${rel}: non-placeholder PRIVATE_KEY assignment`);
  }
}
if (failures === 0) pass(`scanned ${scanned} tracked files — no key material found (actual secret also checked)`);

// 4. .env.example placeholders only
const examplePath = path.join(root, '.env.example');
if (fs.existsSync(examplePath)) {
  const example = fs.readFileSync(examplePath, 'utf8');
  const exampleKeys = [...example.matchAll(HEX_KEY_EXACT)].map((m) => m[0]);
  if (exampleKeys.length > 0 && exampleKeys.every((k) => PLACEHOLDER_KEY.test(k))) {
    pass('.env.example contains only all-zero placeholder keys');
  } else if (exampleKeys.length === 0) {
    pass('.env.example contains no key literals at all');
  } else {
    fail('.env.example contains a non-placeholder key!');
  }
} else {
  fail('.env.example missing');
}

console.log('='.repeat(60));
if (failures > 0) {
  console.error(`AUDIT FAILED: ${failures} problem(s) — fix before committing.`);
  process.exit(1);
}
console.log(`AUDIT PASSED: no secrets in tracked files (${scanned} files scanned).`);
