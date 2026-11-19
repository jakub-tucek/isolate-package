import fs from "fs-extra";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import { getPnpmLockfileDir } from "#/lib/utils";

const lockfileName = "pnpm-lock.yaml";
const workspaceConfigName = "pnpm-workspace.yaml";
const v13Version =
  /^(?:[ \t]+"|["']?)lockfileVersion["']?:[ \t]*["']?13\.0["']?(?:,|[ \t\r]*$)/m;

export async function withNormalizedPnpmLockfile<T>(
  workspaceRootDir: string,
  useLockfile: (lockfileDir: string) => Promise<T>,
): Promise<T> {
  const lockfileDir = getPnpmLockfileDir(workspaceRootDir);
  const lockfilePath = path.join(lockfileDir, lockfileName);
  if (!(await fs.pathExists(lockfilePath))) return useLockfile(lockfileDir);

  const lockfile = await fs.readFile(lockfilePath, "utf8");
  if (!v13Version.test(lockfile)) return useLockfile(lockfileDir);

  const scratch = await fs.mkdtemp(
    path.join(tmpdir(), "isolate-pnpm-lockfile-"),
  );
  try {
    await stageWorkspace(workspaceRootDir, scratch, lockfile);
    await convertLockfile(scratch, lockfilePath);
    return await useLockfile(scratch);
  } finally {
    await fs.remove(scratch);
  }
}

async function stageWorkspace(root: string, scratch: string, lockfile: string) {
  const configPath = path.join(root, workspaceConfigName);
  const config = parseDocument(
    (await fs.pathExists(configPath))
      ? await fs.readFile(configPath, "utf8")
      : "{}",
  );
  const [configError] = config.errors;
  if (configError) throw configError;
  config.setIn(["lockfile", "format"], "v9");

  for (const name of await fs.readdir(root)) {
    if (
      [".git", "node_modules", lockfileName, workspaceConfigName].includes(name)
    ) {
      continue;
    }
    const source = path.join(root, name);
    const destination = path.join(scratch, name);

    const stat = await fs.stat(source).catch(() => null);
    if (!stat) continue;

    if (stat.isDirectory()) {
      await fs.symlink(source, destination, "junction");
    } else if (name === "package.json" || process.platform === "win32") {
      await fs.copyFile(source, destination);
    } else {
      await fs.symlink(source, destination, "file");
    }
  }

  await Promise.all([
    fs.writeFile(path.join(scratch, lockfileName), lockfile),
    fs.writeFile(path.join(scratch, workspaceConfigName), config.toString()),
  ]);
}

async function convertLockfile(scratch: string, sourcePath: string) {
  const args = [
    "install",
    "--lockfile-only",
    "--frozen-lockfile",
    "--lockfile-dir",
    ".",
    "--ignore-scripts",
  ];
  const windows = process.platform === "win32";
  const command = windows ? (process.env.ComSpec ?? "cmd.exe") : "pnpm";
  const commandArgs = windows ? ["/d", "/c", "pnpm", ...args] : args;
  await new Promise<void>((resolve, reject) => {
    execFile(command, commandArgs, { cwd: scratch }, (error) => {
      if (error) {
        reject(
          new Error(
            `Cannot convert pnpm v13 lockfile at ${sourcePath}. Run pnpm install in the workspace with a pnpm version that supports v13 and try again.`,
            { cause: error },
          ),
        );
      } else {
        resolve();
      }
    });
  });
  const converted = await fs.readFile(path.join(scratch, lockfileName), "utf8");
  if (v13Version.test(converted)) {
    throw new Error(
      `Cannot convert pnpm v13 lockfile at ${sourcePath}: pnpm did not write a v9 lockfile.`,
    );
  }
}
