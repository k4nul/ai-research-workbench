import "dotenv/config";

import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

import { closePool } from "../lib/db";
import { createOperator } from "../lib/services/auth";

class PromptOutput extends Writable {
  muted = false;

  _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    if (!this.muted) {
      process.stdout.write(chunk, encoding);
    }
    callback();
  }
}

async function readPipedInput(): Promise<{
  username: string;
  displayName?: string;
  password: string;
}> {
  const username = process.env.OPERATOR_USERNAME;
  if (!username) {
    throw new Error("OPERATOR_USERNAME is required when standard input is not a TTY.");
  }
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 2_100) {
      throw new Error("Password input is too long.");
    }
  }
  const [password = "", confirmation = ""] = input.replace(/\r\n/g, "\n").split("\n");
  if (!password || password !== confirmation) {
    throw new Error("Standard input must contain matching password and confirmation lines.");
  }
  return {
    username,
    displayName: process.env.OPERATOR_DISPLAY_NAME,
    password
  };
}

async function readInteractiveInput(): Promise<{
  username: string;
  displayName?: string;
  password: string;
}> {
  const output = new PromptOutput();
  const prompt = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const username = await prompt.question("Operator username: ");
    const displayName = await prompt.question("Display name (optional): ");

    process.stdout.write("Password: ");
    output.muted = true;
    const password = await prompt.question("");
    output.muted = false;
    process.stdout.write("\nConfirm password: ");
    output.muted = true;
    const confirmation = await prompt.question("");
    output.muted = false;
    process.stdout.write("\n");

    if (password !== confirmation) {
      throw new Error("Password confirmation does not match.");
    }
    return { username, displayName: displayName || undefined, password };
  } finally {
    output.muted = false;
    prompt.close();
  }
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    throw new Error(
      "operator:create does not accept command-line arguments. Use the interactive prompt or stdin."
    );
  }
  const input = process.stdin.isTTY
    ? await readInteractiveInput()
    : await readPipedInput();
  const operator = await createOperator(input);
  process.stdout.write(`Created operator ${operator.username} (${operator.id}).\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `Operator creation failed: ${error instanceof Error ? error.message : "Unknown error"}\n`
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
