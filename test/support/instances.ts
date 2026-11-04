// Instâncias do app como processos separados do sistema operacional (não threads, não o mesmo
// processo do teste), todas contra o mesmo PostgreSQL e o mesmo SQS.
import type { Subprocess } from 'bun';

export interface Instance {
  name: string;
  url: string;
  logs: string[];
  exited: Promise<number>;
  /** Mata o processo na hora, sem desligamento limpo (no Windows é TerminateProcess). */
  kill(): Promise<void>;
}

let nextPort = 3200 + Math.floor(Math.random() * 500);

export async function spawnInstance(name: string, env: Record<string, string> = {}): Promise<Instance> {
  const port = nextPort++;
  const proc: Subprocess<'ignore', 'pipe', 'pipe'> = Bun.spawn(['bun', 'run', 'src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      LOG_LEVEL: 'info',
      WORKERS: '',
      FAIL_AFTER_COMMIT: '',
      ...env,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const logs: string[] = [];
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      logs.push(...lines.filter(Boolean));
    }
    if (pending) logs.push(pending);
  };
  void collect(proc.stdout);
  void collect(proc.stderr);

  const url = `http://localhost:${port}`;
  const instance: Instance = {
    name,
    url,
    logs,
    exited: proc.exited,
    async kill() {
      proc.kill(9);
      await proc.exited;
    },
  };
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`${name} exited during startup:\n${logs.join('\n')}`);
    try {
      if ((await fetch(`${url}/health/live`)).ok) return instance;
    } catch {
      // ainda subindo
    }
    await Bun.sleep(100);
  }
  await instance.kill();
  throw new Error(`${name} did not start:\n${logs.join('\n')}`);
}

/** Espera uma condição ficar verdadeira, conferindo de tempos em tempos. */
export async function waitUntil(description: string, condition: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for: ${description}`);
}

/** Linhas de log JSON de uma instância que tenham o campo `event` (ou a mensagem) indicado. */
export function logLines(instance: Instance, match: (entry: Record<string, unknown>) => boolean): Record<string, unknown>[] {
  return instance.logs.flatMap((line) => {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      return match(entry) ? [entry] : [];
    } catch {
      return [];
    }
  });
}
