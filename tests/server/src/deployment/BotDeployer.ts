/**
 * BotDeployer - Build and deploy the main bot to the private server
 *
 * Handles:
 * - Running the rollup build process
 * - Reading the built output
 * - Deploying to the server via ServerController
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { ServerController } from "../server/ServerController";
import { BotHandle } from "../types";

export interface DeploymentResult {
  success: boolean;
  modules: Record<string, string>;
  buildTime: number;
  error?: string;
}

export interface DeployOptions {
  /** Name for the spawn structure */
  spawnName?: string;
  /** GCL level (default: 1) */
  gcl?: number;
  /** CPU limit (default: 100) */
  cpu?: number;
  /** Available CPU bucket (default: 10000) */
  cpuAvailable?: number;
  /** Position in the room (default: { x: 25, y: 25 }) */
  position?: { x: number; y: number };
}

/**
 * Deploys the main bot code to a Screeps private server
 */
export class BotDeployer {
  private projectRoot: string;
  private distPath: string;
  private cachedModules: Record<string, string> | null = null;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
    this.distPath = path.join(this.projectRoot, "dist");
  }

  /**
   * Build the bot using rollup
   */
  async build(): Promise<DeploymentResult> {
    const startTime = Date.now();

    try {
      // Run the build command
      // Use shell: true for Windows compatibility
      execSync("npm run build", {
        cwd: this.projectRoot,
        stdio: "pipe",
        shell: true as unknown as string,
      });

      // Read the built output
      const modules = await this.readBuiltModules();

      const buildTime = Date.now() - startTime;

      // Cache the modules
      this.cachedModules = modules;

      return {
        success: true,
        modules,
        buildTime,
      };
    } catch (error) {
      const buildTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        success: false,
        modules: {},
        buildTime,
        error: errorMessage,
      };
    }
  }

  /**
   * Get the built modules (builds if not cached)
   */
  async getModules(): Promise<Record<string, string>> {
    if (this.cachedModules) {
      return this.cachedModules;
    }

    const result = await this.build();
    if (!result.success) {
      throw new Error(`Build failed: ${result.error}`);
    }

    return result.modules;
  }

  /**
   * Read the built modules from dist/
   */
  private async readBuiltModules(): Promise<Record<string, string>> {
    const mainJsPath = path.join(this.distPath, "main.js");

    if (!fs.existsSync(mainJsPath)) {
      throw new Error(`Build output not found at ${mainJsPath}`);
    }

    const mainJs = fs.readFileSync(mainJsPath, "utf-8");

    return {
      main: mainJs,
    };
  }

  /**
   * Deploy the bot to a server
   */
  async deployTo(
    server: ServerController,
    username: string,
    room: string,
    options: DeployOptions = {}
  ): Promise<BotHandle> {
    const modules = await this.getModules();

    const handle = await server.deployBot(
      username,
      modules,
      room,
      options.position || { x: 25, y: 25 },
      {
        spawnName: options.spawnName || "Spawn1",
        gcl: options.gcl || 1,
        cpu: options.cpu || 100,
        cpuAvailable: options.cpuAvailable || 10000,
      }
    );

    return handle;
  }

  /**
   * Clear the cached modules (forces rebuild on next deploy)
   */
  clearCache(): void {
    this.cachedModules = null;
  }

  /**
   * Check if the build output exists
   */
  hasBuildOutput(): boolean {
    const mainJsPath = path.join(this.distPath, "main.js");
    return fs.existsSync(mainJsPath);
  }

  /**
   * Get the build output path
   */
  getBuildOutputPath(): string {
    return this.distPath;
  }
}

/**
 * Create a deployer with the default project root (two levels up from tests/server)
 */
export function createDefaultDeployer(): BotDeployer {
  // Assuming we're in tests/server/src/deployment/
  const projectRoot = path.resolve(__dirname, "..", "..", "..", "..");
  return new BotDeployer(projectRoot);
}
