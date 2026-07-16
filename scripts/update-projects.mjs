// Fetches your public, non-forked repos from the GitHub API and writes
// a pin-card link for each one into README.md, between the marker comments.
// Runs inside the GitHub Action — no local setup or manual editing needed.

const USERNAME = "562922";
const README_PATH = "README.md";
const START_MARKER = "<!--START_SECTION:projects-->";
const END_MARKER = "<!--END_SECTION:projects-->";

// Repos to always skip (e.g. this profile repo itself).
const EXCLUDE = new Set([USERNAME.toLowerCase()]);

async function fetchRepos() {
  const res = await fetch(
    `https://api.github.com/users/${USERNAME}/repos?per_page=100&sort=updated`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        // A token avoids the low unauthenticated rate limit; the Action
        // supplies this automatically via secrets.GITHUB_TOKEN.
        ...(process.env.GH_TOKEN
          ? { Authorization: `Bearer ${process.env.GH_TOKEN}` }
          : {}),
      },
    }
  );

  if (!res.ok) {
    throw new Error(`GitHub API request failed: ${res.status} ${res.statusText}`);
  }

  const repos = await res.json();

  return repos
    .filter((r) => !r.fork && !r.private && !EXCLUDE.has(r.name.toLowerCase()))
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));
}

function escapeMd(text) {
  // Neutralize characters that would break markdown rendering.
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

function buildCardMarkdown(repo) {
  const desc = repo.description
    ? escapeMd(repo.description)
    : "_No description set on this repo yet._";
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

  const cards = repos.map(buildCardMarkdown).join("\n\n---\n\n");
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
