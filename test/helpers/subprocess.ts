// What a piped child printed and how it ended, in one await: bun's Subprocess hands out the two
// streams and the exit separately, and a reader that awaits the exit first can deadlock on a
// child blocked writing to an unread pipe.
export interface ChildOutput {
  exitCode: number;
  signalCode: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

async function drain(stream: Bun.Subprocess["stdout"]): Promise<string> {
  if (!(stream instanceof ReadableStream)) return "";
  return await new Response(stream).text();
}

export async function outputOf(child: Bun.Subprocess): Promise<ChildOutput> {
  const [stdout, stderr, exitCode] = await Promise.all([
    drain(child.stdout),
    drain(child.stderr),
    child.exited,
  ]);
  return { exitCode, signalCode: child.signalCode, stdout, stderr };
}
