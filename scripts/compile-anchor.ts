/**
 * Compiles contracts/TrendAnchor.sol with solc-js and emits
 * src/generated/anchor.json (abi + bytecode). Deterministic output that is
 * committed to the repo so runtime never needs the compiler.
 *
 * Run: npm run compile:anchor
 */
import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'contracts', 'TrendAnchor.sol');
const outPath = path.join(root, 'src', 'generated', 'anchor.json');

const source = fs.readFileSync(sourcePath, 'utf8');

const input = {
  language: 'Solidity',
  sources: { 'TrendAnchor.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
  errors?: Array<{ severity: string; formattedMessage: string }>;
  contracts?: Record<string, Record<string, { abi: unknown; evm: { bytecode: { object: string } } }>>;
};

const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
if (errors.length > 0) {
  console.error(errors.map((e) => e.formattedMessage).join('\n'));
  process.exit(1);
}

const contract = output.contracts?.['TrendAnchor.sol']?.['TrendAnchor'];
if (!contract) {
  console.error('TrendAnchor contract not found in solc output');
  process.exit(1);
}

const artifact = {
  contractName: 'TrendAnchor',
  compiler: { solc: (solc.version() as string) ?? 'unknown', settings: 'optimizer enabled, 200 runs' },
  abi: contract.abi,
  bytecode: `0x${contract.evm.bytecode.object}`,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`TrendAnchor compiled → ${path.relative(root, outPath)} (bytecode ${Math.floor(artifact.bytecode.length / 2)} bytes)`);
