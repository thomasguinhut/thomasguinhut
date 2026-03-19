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
  let hasMore = true;
  while (hasMore) {
    const response = await queries.queryRest(
      `/users/${username}/repos?page=${page}&per_page=100`
    );
    if (response.length === 0) {
      hasMore = false;
    } else {
      repos.push(...response.map((repo) => repo.name));
      page++;
    }
  }
  return repos;
}

async function getRepoViews(repos, queries) {
  const repoStats = [];
  for (const repo of repos) {
    try {
      const r = await queries.queryRest(`/repos/${username}/${repo}/traffic/views`);
      if (r.uniques && r.uniques > 0) {
        const firstView = r.views[0];
        const lastView = r.views[r.views.length - 1];
        const formatDate = (timestamp) => {
          const date = new Date(timestamp);
          return `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}`;
        };
        repoStats.push({
          name: repo,
          uniques: r.uniques,
          dateRange: firstView && lastView
            ? `${formatDate(firstView.timestamp)} - ${formatDate(lastView.timestamp)}`
            : "N/A",
        });
      }
    } catch (error) {
      // ignore individual repo errors
    }
  }
  return repoStats;
}

function buildTemplateData(colors, repos) {
  const topRepos = repos.sort((a, b) => b.uniques - a.uniques).slice(0, 5);
  const rowCount = topRepos.length;
  const rowHeight = rowCount > 0 ? 100 / rowCount : 0;
  const animationDelays = calculateAnimationDelays(rowCount);
  const reposWithAnimation = topRepos.map((repo, index) => ({
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
    let repos = await getRepos(username, queries);
    repos = repos.filter((repo) => !excludedRepos.includes(repo.toLowerCase()));
    const repoStats = await getRepoViews(repos, queries);

    const __dirname = path.dirname(new URL(import.meta.url).pathname);
    const templatePath = path.resolve(__dirname, "..", "templates", "template_visitors.hbs");
    const svg = Handlebars.compile(fs.readFileSync(templatePath, "utf8"))(
      buildTemplateData(colors, repoStats)
    );

    const svgDir = path.resolve(__dirname, "..", "..", "output");
    if (!fs.existsSync(svgDir)) fs.mkdirSync(svgDir, { recursive: true });

    fs.writeFileSync(path.join(svgDir, "stats_visitors.svg"), svg);
    console.log('✅ stats_visitors.svg created');
  } catch (error) {
    console.error("❌ Error generating SVG:", error);
    process.exit(1);
  }
}

main();