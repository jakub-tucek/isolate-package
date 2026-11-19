import fs from "fs-extra";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { isolate } from "./isolate";

const execFileAsync = promisify(execFile);

async function pnpm(cwd: string, ...args: string[]) {
  return execFileAsync("pnpm", args, { cwd });
}

it.skipIf(!process.env.TEST_PNPM_V13)(
  "isolates a v13 workspace without changing its locked peer bindings",
  async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "isolate-v13-test-"));
    try {
      const { stdout: pnpmVersion } = await pnpm(root, "--version");
      await fs.writeJson(path.join(root, "package.json"), {
        name: "workspace",
        private: true,
        packageManager: `pnpm@${pnpmVersion.trim()}`,
      });
      const workspaceConfig = path.join(root, "pnpm-workspace.yaml");
      const config = "packages:\n  - 'apps/*'\nlockfile:\n  format: v13\n";
      await fs.writeFile(workspaceConfig, config);

      const app = path.join(root, "apps", "app");
      await fs.outputJson(path.join(app, "package.json"), {
        name: "app",
        version: "1.0.0",
        main: "index.js",
        files: ["index.js"],
        dependencies: { react: "18.3.1", "react-dom": "18.3.1" },
      });
      await fs.writeFile(path.join(app, "index.js"), "module.exports = {};\n");
      await fs.outputJson(path.join(root, "apps", "other", "package.json"), {
        name: "other",
        dependencies: { react: "19.2.0", "react-dom": "19.2.0" },
      });

      await pnpm(root, "install", "--lockfile-only", "--ignore-scripts");
      const lockfilePath = path.join(root, "pnpm-lock.yaml");
      const source = await fs.readFile(lockfilePath, "utf8");
      expect(source).toContain('"lockfileVersion": "13.0"');

      const output = await isolate({
        targetPackagePath: app,
        buildDirName: ".",
      });
      const lockfile = await fs.readFile(
        path.join(output, "pnpm-lock.yaml"),
        "utf8",
      );
      const [env, project] = parseAllDocuments(lockfile).map((document) =>
        document.toJS(),
      );
      expect(env.importers["."].packageManagerDependencies.pnpm.version).toBe(
        pnpmVersion.trim(),
      );
      expect(project.importers["."].dependencies["react-dom"].version).toBe(
        "18.3.1(react@18.3.1)",
      );
      expect(Object.keys(project.snapshots)).not.toContain(
        "react-dom@19.2.0(react@19.2.0)",
      );
      await pnpm(
        output,
        "install",
        "--frozen-lockfile",
        "--lockfile-only",
        "--ignore-scripts",
      );
      await expect(fs.readFile(lockfilePath, "utf8")).resolves.toBe(source);
      await expect(fs.readFile(workspaceConfig, "utf8")).resolves.toBe(config);

      const appManifest = path.join(app, "package.json");
      const manifest = await fs.readJson(appManifest);
      manifest.dependencies.react = "19.2.0";
      await fs.writeJson(appManifest, manifest);
      await expect(
        isolate({ targetPackagePath: app, buildDirName: "." }),
      ).rejects.toThrow("Cannot convert pnpm v13 lockfile");
      await expect(fs.readFile(lockfilePath, "utf8")).resolves.toBe(source);
    } finally {
      await fs.remove(root);
    }
  },
  60_000,
);
