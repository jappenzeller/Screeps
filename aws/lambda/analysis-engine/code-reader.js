/**
 * Code Reader Module
 * Fetches code from GitHub repository for context-aware AI analysis
 */

import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const ssm = new SSMClient({});

let cachedToken = null;
let cachedRepo = null;

async function getGitHubConfig() {
  if (cachedRepo !== null) {
    return { token: cachedToken, repo: cachedRepo };
  }

  try {
    // Try to get repo (required)
    const repoRes = await ssm.send(
      new GetParameterCommand({
        Name: "/screeps-advisor/github-repo",
      })
    );
    cachedRepo = repoRes.Parameter?.Value || "";

    if (!cachedRepo) {
      throw new Error("GitHub repo not configured in SSM");
    }

    // Try to get token (optional for public repos)
    try {
      const tokenRes = await ssm.send(
        new GetParameterCommand({
          Name: "/screeps-advisor/github-token",
          WithDecryption: true,
        })
      );
      cachedToken = tokenRes.Parameter?.Value || null;
    } catch (tokenError) {
      console.log("GitHub token not configured, using unauthenticated access (60 req/hr limit)");
      cachedToken = null;
    }

    return { token: cachedToken, repo: cachedRepo };
  } catch (error) {
    console.warn("Failed to get GitHub config:", error.message);
    cachedRepo = "";
    cachedToken = null;
    return { token: null, repo: null };
  }
}

async function githubApi(endpoint) {
  const { token, repo } = await getGitHubConfig();

  if (!repo) {
    throw new Error("GitHub repo not configured");
  }

  const url = `https://api.github.com/repos/${repo}${endpoint}`;

  const headers = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "screeps-advisor",
  };

  // Add authorization header if token is available
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    // Check for rate limiting
    if (response.status === 403) {
      const remaining = response.headers.get("X-RateLimit-Remaining");
      if (remaining === "0") {
        throw new Error("GitHub API rate limit exceeded. Configure a token for higher limits.");
      }
    }
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * List files in a directory
 */
export async function listFiles(path = "") {
  const endpoint = `/contents/${path}`;
  const data = await githubApi(endpoint);

  if (!Array.isArray(data)) {
    return [data];
  }

  return data.map((item) => ({
    name: item.name,
    path: item.path,
    type: item.type,
    size: item.size,
    sha: item.sha,
  }));
}

/**
 * Get file content
 */
export async function fetchFile(path) {
  const endpoint = `/contents/${path}`;
  const data = await githubApi(endpoint);

  if (data.type !== "file") {
    throw new Error(`${path} is not a file`);
  }

  // GitHub returns base64 encoded content
  const content = Buffer.from(data.content, "base64").toString("utf-8");

  return {
    path: data.path,
    content,
    size: data.size,
    sha: data.sha,
  };
}

/**
 * Get multiple files at once (for context building)
 */
export async function fetchFiles(paths) {
  const results = new Map();

  // Check if GitHub is configured
  const { repo } = await getGitHubConfig();
  if (!repo) {
    console.warn("GitHub not configured, skipping code fetch");
    return results;
  }

  // Fetch in parallel, but limit concurrency
  const batchSize = 5;
  for (let i = 0; i < paths.length; i += batchSize) {
    const batch = paths.slice(i, i + batchSize);
    const contents = await Promise.all(
      batch.map(async (path) => {
        try {
          const file = await fetchFile(path);
          return { path, content: file.content };
        } catch (error) {
          console.warn(`Failed to fetch ${path}:`, error.message);
          return { path, content: null };
        }
      })
    );

    for (const { path, content } of contents) {
      if (content) {
        results.set(path, content);
      }
    }
  }

  return results;
}

/**
 * Get repository file structure (recursive)
 */
export async function getRepoStructure(path = "src") {
  const files = [];

  async function traverse(currentPath) {
    try {
      const items = await listFiles(currentPath);

      for (const item of items) {
        if (item.type === "file" && item.name.endsWith(".ts")) {
          files.push(item.path);
        } else if (item.type === "dir" && !item.name.startsWith(".")) {
          await traverse(item.path);
        }
      }
    } catch (error) {
      console.warn(`Failed to traverse ${currentPath}:`, error.message);
    }
  }

  await traverse(path);
  return files;
}

/**
 * Check if GitHub is configured
 */
export async function isGitHubConfigured() {
  try {
    const { repo } = await getGitHubConfig();
    return !!repo;
  } catch {
    return false;
  }
}
