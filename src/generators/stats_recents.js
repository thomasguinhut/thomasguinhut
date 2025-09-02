import fs from "fs";
import path from "path";
import Handlebars from "handlebars";
import colors from "../../themes/colors_visitors.js";

const username = process.env.GITHUB_ACTOR;
const token = process.env.ACCESS_TOKEN;
const REST_API = "https://api.github.com";
const excludedRepos = process.env.EXCLUDED_REPOS
  ? process.env.EXCLUDED_REPOS.split(",").map((r) => r.trim().toLowerCase())
  : [];

if (!token) {
  console.error("Error: ACCESS_TOKEN is not defined in environment variables.");
  process.exit(1);
}

class GitHubQueries {
  constructor(token) {
    this.token = token;
  }

  async queryRest(endpoint) {
    let response;
    do {
      response = await fetch(`${REST_API}${endpoint}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
      });
      if (response.status === 202) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
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
      `/users/${username}/repos?page=${page}&per_page=100&sort=pushed&direction=desc`
    );
    if (response.length === 0) {
      hasMore = false;
    } else {
      const filteredRepos = response.filter(
        repo => !repo.private && !excludedRepos.includes(repo.name.toLowerCase())
      );
      repos.push(...filteredRepos);
      page++;
    }
  }
  console.log("Repos avant slice:", repos.map(r => ({ name: r.name, pushed_at: r.pushed_at }))); // Log pour vérifier l'ordre
  return repos.slice(0, 5);
}

async function getRepoInfos(repos, queries) {
  const repoInfos = [];
  for (const repo of repos) {
    try {
      const repoData = await queries.queryRest(`/repos/${username}/${repo.name}`);
      const updatedAt = new Date(repoData.updated_at);
      repoInfos.push({
        name: repo.name,
        updatedAt: updatedAt.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric'
        }),
        language: repoData.language || 'Unknown',
        rawDate: updatedAt, // Ajoute la date brute pour le tri
      });
    } catch (error) {
      console.error(`Error fetching info for repo ${repo.name}:`, error);
    }
  }
  // Trie par date décroissante (au cas où)
  repoInfos.sort((a, b) => b.rawDate - a.rawDate);
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
    ...Object.fromEntries(
      Object.entries(colors.dark).map(([k, v]) => [k + "Dark", v])
    ),
    repos: reposWithAnimation,
    rowHeight,
    animationDelays,
  };
}

function calculateAnimationDelays(count) {
  const startDelay = 1.4;
  const endDelay = 2.9;
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
    const templatePath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "templates",
      "template_recents.hbs"
    );
    const templateSvg = fs.readFileSync(templatePath, "utf8");
    const template = Handlebars.compile(templateSvg);
    const templateData = buildTemplateData(colors, repoInfos);
    const svg = template(templateData);
    const svgDir = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "..",
      "output"
    );
    if (!fs.existsSync(svgDir)) {
      fs.mkdirSync(svgDir, { recursive: true });
    }
    const svgFilePath = path.join(svgDir, "stats_recents.svg");
    fs.writeFileSync(svgFilePath, svg);
    console.log(`SVG file created: ${svgFilePath}`);
  } catch (error) {
    console.error("Error generating SVG:", error);
  }
}

main();
