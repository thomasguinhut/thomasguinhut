import fs from "fs";
import path from "path";
import Handlebars from "handlebars";
import colors from "../../themes/colors_visitors.js";

const username = process.env.GITHUB_USERNAME;
const token = process.env.ACCESS_TOKEN;
const REST_API = "https://api.github.com";
const excludedRepos = process.env.EXCLUDED_REPOS
  ? process.env.EXCLUDED_REPOS.split(",").map((r) => r.trim().toLowerCase())
  : [];

if (!token) {
  console.error("Error: ACCESS_TOKEN is not defined in environment variables.");
  process.exit(1);
}
if (!username) {
  console.error("Error: GITHUB_USERNAME is not defined in environment variables.");
  process.exit(1);
}

class GitHubQueries {
  constructor(token) {
    this.token = token;
  }

  async queryRest(endpoint) {
    let response;
    let attempts = 0;
    do {
      if (attempts > 10) throw new Error("Too many 202 retries from GitHub API");
      response = await fetch(`${REST_API}${endpoint}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
      });
      if (response.status === 202) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        attempts++;
      } else if (!response.ok) {
        throw new Error(`Failed to get data from GitHub REST API: ${response.status}`);
      }
    } while (response.status === 202);
    return response.json();
  }
}

async function getRepos(username, queries) {
  const repos = [];
  let page = 1;

  while (repos.length < 5) {
    const response = await queries.queryRest(
      `/users/${username}/repos?page=${page}&per_page=100&sort=pushed&direction=desc`
    );
    if (response.length === 0) break;
    const filtered = response.filter(
      (repo) => !repo.private && !excludedRepos.includes(repo.name.toLowerCase())
    );
    repos.push(...filtered);
    page++;
  }

  return repos.slice(0, 5);
}

async function getRepoInfos(repos, queries) {
  const repoInfos = [];
  for (const repo of repos) {
    try {
      const repoData = await queries.queryRest(`/repos/${username}/${repo.name}`);
      const pushedAt = new Date(repoData.pushed_at);
      repoInfos.push({
        name: repo.name,
        updatedAt: pushedAt.toLocaleDateString("en-US", {
          month: "short", day: "numeric", year: "numeric",
        }),
        language: repoData.language || "Unknown",
      });
    } catch (error) {
      console.error(`Error fetching info for repo ${repo.name}:`, error);
    }
  }
  return repoInfos;
}

function buildTemplateData(colors, repos) {
  const rowCount = repos.length;
  const rowHeight = rowCount > 0 ? 100 / rowCount : 0;
  const animationDelays = calculateAnimationDelays(rowCount);
  const reposWithAnimation = repos.map((repo, index) => ({
    ...repo,
    animationDelay: animationDelays[index],
  }));
  return {
    ...colors.light,
    ...Object.fromEntries(Object.entries(colors.dark).map(([k, v]) => [k + "Dark", v])),
    repos: reposWithAnimation,
    rowHeight,
    animationDelays,
  };
}

function calculateAnimationDelays(count) {
  const startDelay = 1.4, endDelay = 2.9;
  const interval = count > 1 ? (endDelay - startDelay) / (count - 1) : 0;
  return Array.from({ length: count }, (_, i) =>
    i === count - 1 ? endDelay : startDelay + i * interval
  );
}

async function main() {
  try {
    const queries = new GitHubQueries(token);
    const repos = await getRepos(username, queries);
    const repoInfos = await getRepoInfos(repos, queries);

    const __dirname = path.dirname(new URL(import.meta.url).pathname);
    const templatePath = path.resolve(__dirname, "..", "templates", "template_recents.hbs");
    const svg = Handlebars.compile(fs.readFileSync(templatePath, "utf8"))(
      buildTemplateData(colors, repoInfos)
    );

    const svgDir = path.resolve(__dirname, "..", "..", "output");
    if (!fs.existsSync(svgDir)) fs.mkdirSync(svgDir, { recursive: true });

    fs.writeFileSync(path.join(svgDir, "stats_recents.svg"), svg);
    console.log('✅ stats_recents.svg created');
  } catch (error) {
    console.error("❌ Error generating SVG:", error);
    process.exit(1);
  }
}

main();