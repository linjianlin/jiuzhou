import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';

const children = [];

const commandSpec = (command, args) => {
  if (!isWindows) return { command, args };
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', [command, ...args].join(' ')],
  };
};

const run = (name, command, args) => {
  const spec = commandSpec(command, args);
  const child = spawn(spec.command, spec.args, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: 'inherit',
  });

  children.push(child);

  child.on('exit', (code, signal) => {
    if (signal) {
      console.log(`${name} exited via ${signal}`);
    } else if (code !== 0 && code !== null) {
      console.error(`${name} exited with code ${code}`);
    }
    shutdown(child);
    process.exit(code ?? 0);
  });
};

const shutdown = (except) => {
  for (const child of children) {
    if (child === except || child.killed) continue;
    child.kill('SIGTERM');
  }
};

process.on('SIGINT', () => {
  shutdown();
  process.exit(130);
});

process.on('SIGTERM', () => {
  shutdown();
  process.exit(143);
});

run('client', isWindows ? 'pnpm.cmd' : 'pnpm', ['--filter', './client', 'dev', '--port', '6010']);
run('server-rs', isWindows ? 'cargo.exe' : 'cargo', [
  'run',
  '--manifest-path',
  'server-rs/Cargo.toml',
  '--bin',
  'server-rs',
]);
