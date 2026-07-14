import { Command } from "commander";

export function createCli(name: string, description: string): Command {
  return new Command().name(name).description(description).version("0.1.0");
}

export function runCli(program: Command): void {
  program.parseAsync(process.argv).catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
