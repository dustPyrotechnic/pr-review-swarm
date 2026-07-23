const KNOWN_COMMANDS = new Set(['deploy']);

export function parseArgs(argv) {
  const positional = [];
  let help = false;
  let deepseekKey;
  let directPush = false;
  let force = false;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg.startsWith('--deepseek-key=')) {
      deepseekKey = arg.slice('--deepseek-key='.length);
    } else if (arg === '--direct-push') {
      directPush = true;
    } else if (arg === '--force') {
      force = true;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    } else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }

  const command = positional[0];

  if (!command) {
    if (help) return { command: undefined, help, deepseekKey, directPush, force };
    throw new Error('no command given — run with --help to see usage');
  }

  if (!KNOWN_COMMANDS.has(command)) {
    throw new Error(`unknown command: ${command}`);
  }

  return { command, help, deepseekKey, directPush, force };
}
