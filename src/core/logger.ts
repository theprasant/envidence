import ora, { type Ora } from "ora";
import pc from "picocolors";

export type LoggerOptions = {
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
};

export class Logger {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly verbose: boolean;

  constructor(options: LoggerOptions = {}) {
    this.json = options.json === true;
    this.quiet = options.quiet === true;
    this.verbose = options.verbose === true;
  }

  info(message: string): void {
    if (this.json || this.quiet) return;
    process.stdout.write(`${message}\n`);
  }

  step(message: string): void {
    this.info(`${pc.cyan("›")} ${message}`);
  }

  success(message: string): void {
    if (this.json || this.quiet) return;
    process.stdout.write(`${pc.green("✓")} ${message}\n`);
  }

  warn(message: string): void {
    if (this.quiet) return;
    process.stderr.write(`${pc.yellow("!")} ${message}\n`);
  }

  error(message: string): void {
    process.stderr.write(`${pc.red("✗")} ${message}\n`);
  }

  debug(message: string): void {
    if (!this.verbose || this.json) return;
    process.stderr.write(`${pc.dim("·")} ${pc.dim(message)}\n`);
  }

  raw(message: string): void {
    if (this.quiet) return;
    process.stdout.write(`${message}\n`);
  }

  blank(): void {
    if (this.json || this.quiet) return;
    process.stdout.write("\n");
  }

  header(title: string): void {
    if (this.json || this.quiet) return;
    process.stdout.write(`\n${pc.bold(title)}\n`);
  }

  dim(message: string): string {
    return pc.dim(message);
  }

  bold(message: string): string {
    return pc.bold(message);
  }

  cyan(message: string): string {
    return pc.cyan(message);
  }

  amber(message: string): string {
    return pc.yellow(message);
  }

  coral(message: string): string {
    return pc.red(message);
  }

  teal(message: string): string {
    return pc.green(message);
  }

  spinner(text: string): Spinner {
    if (this.json || this.quiet || !process.stdout.isTTY) {
      return new Spinner(null, text, this);
    }
    const instance = ora({ text, stream: process.stderr, discardStdin: false }).start();
    return new Spinner(instance, text, this);
  }
}

export class Spinner {
  private instance: Ora | null;
  private text: string;
  private readonly logger: Logger;

  constructor(instance: Ora | null, text: string, logger: Logger) {
    this.instance = instance;
    this.text = text;
    this.logger = logger;
  }

  update(text: string): void {
    this.text = text;
    this.instance?.start();
    if (this.instance) this.instance.text = text;
    else this.logger.debug(text);
  }

  stop(): void {
    this.instance?.stop();
    this.instance = null;
  }

  succeed(text?: string): void {
    if (this.instance) {
      this.instance.succeed(text ?? this.text);
      this.instance = null;
    } else {
      this.logger.success(text ?? this.text);
    }
  }

  fail(text?: string): void {
    if (this.instance) {
      this.instance.fail(text ?? this.text);
      this.instance = null;
    } else {
      this.logger.error(text ?? this.text);
    }
  }

  warn(text?: string): void {
    if (this.instance) {
      this.instance.warn(text ?? this.text);
      this.instance = null;
    } else {
      this.logger.warn(text ?? this.text);
    }
  }
}

export function renderBar(value: number, width = 12): string {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * width);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

export function confidenceLabel(value: "high" | "medium" | "low"): string {
  if (value === "high") return pc.green("high");
  if (value === "medium") return pc.yellow("medium");
  return pc.dim("low");
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}
