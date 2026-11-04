import { Logger } from '@nestjs/common';

/**
 * Executa `tick` em laço até ser parado. Se o tick não achou trabalho, espera `idleMs`; se falhou,
 * espera `errorMs` (o erro é registrado e o laço continua). `stop()` interrompe a espera e aguarda o
 * tick em andamento terminar.
 */
export class BackgroundLoop {
  private running = false;
  private wake?: () => void;
  private done?: Promise<void>;
  private readonly logger: Logger;

  constructor(
    readonly name: string,
    private readonly tick: () => Promise<number>,
    private readonly idleMs = 500,
    private readonly errorMs = 2_000,
  ) {
    this.logger = new Logger(name);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.done = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.done;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let wait = 0;
      try {
        const handled = await this.tick();
        if (handled === 0) wait = this.idleMs;
      } catch (error) {
        this.logger.error(`${this.name} failed: ${error instanceof Error ? error.message : String(error)}`);
        wait = this.errorMs;
      }
      if (wait > 0 && this.running) await this.sleep(wait);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
