import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';

const commandSpec = (command, args) => {
  if (!isWindows) return { command, args };
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', [command, ...args].join(' ')],
  };
};

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const spec = commandSpec(command, args);
    const child = spawn(spec.command, spec.args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: 'inherit',
    });

    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed${signal ? ` via ${signal}` : ` with code ${code}`}`));
      }
    });
  });

await run(isWindows ? 'pnpm.cmd' : 'pnpm', ['build:client']);
await run(isWindows ? 'cargo.exe' : 'cargo', [
  'build',
  '--manifest-path',
  'server-rs/Cargo.toml',
  '--release',
]);
