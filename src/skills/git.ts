async function git(dir: string, args: string[]) {
  const child = Bun.spawn(
    ["git", "-c", `safe.directory=${dir}`, "-C", dir, ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${err.trim()}`);
  return out;
}

export async function headRevision(dir: string) {
  return (await git(dir, ["rev-parse", "HEAD"])).trim();
}

export async function listFiles(dir: string, revision: string) {
  const out = await git(dir, ["ls-tree", "-r", "--name-only", "-z", revision]);
  return out.split("\0").filter(Boolean);
}

export async function readAt(dir: string, revision: string, path: string) {
  return await git(dir, ["show", `${revision}:${path}`]);
}
