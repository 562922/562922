// Fetches your public, non-forked repos from the GitHub API and writes
// a pin-card link for each one into README.md, between the marker comments.
// Runs inside the GitHub Action — no local setup or manual editing needed.

const USERNAME = "562922";
const README_PATH = "README.md";
const START_MARKER = "<!--START_SECTION:projects-->";
const END_MARKER = "<!--END_SECTION:projects-->";

// Repos to always skip (e.g. this profile repo itself).
const EXCLUDE = new Set([USERNAME.toLowerCase()]);

const CACHE_PATH = "scripts/description-cache.json";

// Source files worth reading when there's no README to summarize.
// Ordered by how likely each is to reveal what the project actually does.
const ENTRY_CANDIDATES = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "CMakeLists.txt",
  "main.py",
  "main.cpp",
  "main.c",
  "Program.cs",
  "index.js",
  "index.html",
  "src/main.js",
  "src/index.js",
  "src/App.jsx",
  "src/main.py",
];
const SKIP_DIR_PATTERN = /(^|\/)(node_modules|vendor|dist|build|\.git|target)(\/|$)/;
const MAX_SOURCE_CHARS = 6000;

function ghHeaders() {
  return {
    Accept: "application/vnd.github+json",
    // A token avoids the low unauthenticated rate limit; the Action
    // supplies this automatically via secrets.GITHUB_TOKEN.
    ...(process.env.GH_TOKEN
      ? { Authorization: `Bearer ${process.env.GH_TOKEN}` }
      : {}),
  };
}

async function fetchRepos() {
  const res = await fetch(
    `https://api.github.com/users/${USERNAME}/repos?per_page=100&sort=updated`,
    { headers: ghHeaders() }
  );

  if (!res.ok) {
    throw new Error(`GitHub API request failed: ${res.status} ${res.statusText}`);
  }

  const repos = await res.json();

  return repos
    .filter((r) => !r.fork && !r.private && !EXCLUDE.has(r.name.toLowerCase()))
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));
}

async function loadCache() {
  const fs = await import("node:fs/promises");
  try {
    const raw = await fs.readFile(CACHE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveCache(cache) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
}

function stripMarkdown(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images/badges
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> text
    .replace(/^#+\s*/gm, "")
    .replace(/[*_`>#-]/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function fetchReadmeSummary(repo) {
  const res = await fetch(
    `https://api.github.com/repos/${repo.full_name}/readme`,
    { headers: { ...ghHeaders(), Accept: "application/vnd.github.raw" } }
  );
  if (!res.ok) return null;

  const raw = await res.text();
  const lines = stripMarkdown(raw);
  // Skip the title line and any short tagline-less noise; find the first
  // real sentence-like paragraph.
  const candidate = lines.find((l) => l.length > 40) || lines[0];
  if (!candidate) return null;

  const trimmed = candidate.length > 200 ? candidate.slice(0, 197) + "..." : candidate;
  return trimmed;
}

async function fetchRepoTree(repo) {
  const res = await fetch(
    `https://api.github.com/repos/${repo.full_name}/git/trees/${repo.default_branch}?recursive=1`,
    { headers: ghHeaders() }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.tree || [])
    .filter((f) => f.type === "blob" && !SKIP_DIR_PATTERN.test(f.path))
    .map((f) => f.path);
}

async function fetchFileRaw(repo, path) {
  const res = await fetch(
    `https://api.github.com/repos/${repo.full_name}/contents/${encodeURIComponent(path)}`,
    { headers: { ...ghHeaders(), Accept: "application/vnd.github.raw" } }
  );
  if (!res.ok) return null;
  return res.text();
}

async function gatherSourceExcerpt(repo) {
  const paths = await fetchRepoTree(repo);
  if (paths.length === 0) return null;

  // Prefer known entry-point files; otherwise take a handful of the
  // shallowest, smallest-looking source files as a fallback sample.
  const known = ENTRY_CANDIDATES.filter((c) => paths.includes(c));
  const rest = paths
    .filter((p) => !known.includes(p))
    .sort((a, b) => a.split("/").length - b.split("/").length)
    .slice(0, 5);
  const targets = [...known, ...rest].slice(0, 6);

  let excerpt = "";
  for (const path of targets) {
    if (excerpt.length >= MAX_SOURCE_CHARS) break;
    const content = await fetchFileRaw(repo, path);
    if (!content) continue;
    excerpt += `\n--- ${path} ---\n${content.slice(0, 1500)}\n`;
  }

  return excerpt.trim() || null;
}

async function summarizeWithClaude(repo, excerpt) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content:
            `Here are some files from a GitHub repository named "${repo.name}":\n\n${excerpt}\n\n` +
            `Write one plain sentence (under 20 words) describing what this project does, ` +
            `for someone reading a portfolio README. No preamble, no quotes, no file names, just the sentence.`,
        },
      ],
    }),
  });

  if (!res.ok) return null;
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
  return text || null;
}

async function getDescription(repo, cache) {
  if (repo.description && repo.description.trim()) {
    return repo.description.trim();
  }

  const cached = cache[repo.full_name];
  if (cached && cached.pushed_at === repo.pushed_at) {
    return cached.description;
  }

  let description = await fetchReadmeSummary(repo);

  if (!description) {
    const excerpt = await gatherSourceExcerpt(repo);
    if (excerpt) {
      description = await summarizeWithClaude(repo, excerpt);
    }
  }

  description = description || "_No description available yet._";
  cache[repo.full_name] = { pushed_at: repo.pushed_at, description };
  return description;
}

function escapeMd(text) {
  // Neutralize characters that would break markdown rendering.
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

async function buildCardMarkdown(repo, cache) {
  const desc = escapeMd(await getDescription(repo, cache));
  const lang = repo.language ? `\`${repo.language}\`` : "";
  const stars = repo.stargazers_count > 0 ? `★ ${repo.stargazers_count}` : "";
  const meta = [lang, stars].filter(Boolean).join("&nbsp;&nbsp;·&nbsp;&nbsp;");

  return [
    `**[${repo.name}](${repo.html_url})**${meta ? `  \n${meta}` : ""}`,
    `${desc}`,
  ].join("  \n");
}

async function main() {
  const fs = await import("node:fs/promises");
  const repos = await fetchRepos();

  if (repos.length === 0) {
    console.log("No repos found — leaving section unchanged.");
    return;
  }

  const cache = await loadCache();
  const cardList = [];
  for (const repo of repos) {
    cardList.push(await buildCardMarkdown(repo, cache));
  }
  await saveCache(cache);

  const cards = cardList.join("\n\n---\n\n");
  const section = `${START_MARKER}\n${cards}\n${END_MARKER}`;

  const readme = await fs.readFile(README_PATH, "utf-8");
  const pattern = new RegExp(`${START_MARKER}[\\s\\S]*?${END_MARKER}`);

  if (!pattern.test(readme)) {
    throw new Error(
      `Could not find ${START_MARKER} / ${END_MARKER} markers in ${README_PATH}.`
    );
  }

  const updated = readme.replace(pattern, section);
  await fs.writeFile(README_PATH, updated);
  console.log(`Updated project section with ${repos.length} repo(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
