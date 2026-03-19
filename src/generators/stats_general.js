import fs from "fs";
import path from "path";
import Handlebars from "handlebars";
import colors from "../../themes/colors_general.js";

const username = process.env.GITHUB_USERNAME;
const token = process.env.ACCESS_TOKEN;
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

const GRAPHQL_API = "https://api.github.com/graphql";
const REST_API = "https://api.github.com";

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

class UserStats {
  constructor(username, queries, repos) {
    this.username = username;
    this.queries = queries;
    this.repos = repos;
    this._linesChanged = null;
    this._views = null;
  }

  async linesChanged() {
    if (this._linesChanged !== null) return this._linesChanged;
    let additions = 0, deletions = 0;
    for (const repo of await this.repos) {
      try {
        const r = await this.queries.queryRest(`/repos/${repo}/stats/contributors`);
        if (!Array.isArray(r)) continue;
        for (const authorObj of r) {
          if (!authorObj?.author?.login) continue;
          if (authorObj.author.login !== this.username) continue;
          for (const week of authorObj.weeks || []) {
            additions += week.a || 0;
            deletions += week.d || 0;
          }
        }
      } catch (error) {
        // ignore individual repo errors
      }
    }
    this._linesChanged = additions + deletions;
    return this._linesChanged;
  }

  async views() {
    if (this._views !== null) return this._views;
    let total = 0;
    for (const repo of await this.repos) {
      try {
        const r = await this.queries.queryRest(`/repos/${repo}/traffic/views`);
        if (!Array.isArray(r.views)) continue;
        for (const view of r.views) total += view.count || 0;
      } catch (error) {
        // ignore individual repo errors
      }
    }
    this._views = total;
    return total;
  }
}

async function fetchFromGitHub(query, variables = {}) {
  const response = await fetch(GRAPHQL_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`GitHub API returned status ${response.status}`);
  const data = await response.json();
  if (data.errors) throw new Error("GraphQL errors: " + JSON.stringify(data.errors));
  return data.data;
}

async function main() {
  try {
    const query = `
      query {
        user(login: "${username}") {
          name
          repositories(first: 100) {
            totalCount
            nodes {
              nameWithOwner
              stargazers { totalCount }
              forkCount
            }
          }
          contributionsCollection {
            totalCommitContributions
          }
        }
      }
    `;

    const data = await fetchFromGitHub(query);
    const user = data.user;

    const filteredRepoNodes = user.repositories.nodes.filter((repo) => {
      const full = repo.nameWithOwner.toLowerCase();
      const short = full.split("/")[1];
      return !excludedRepos.includes(full) && !excludedRepos.includes(short);
    });

    const repos = filteredRepoNodes.map((repo) => repo.nameWithOwner);
    const queries = new GitHubQueries(token);
    const userStats = new UserStats(username, queries, repos);
    const totalLinesChanged = await userStats.linesChanged();
    const views = await userStats.views();

    const stats = {
      name: user.name || username,
      stars: filteredRepoNodes.reduce((sum, repo) => sum + repo.stargazers.totalCount, 0),
      forks: filteredRepoNodes.reduce((sum, repo) => sum + repo.forkCount, 0),
      contributions: user.contributionsCollection.totalCommitContributions,
      linesChanged: totalLinesChanged,
      views,
      repos: filteredRepoNodes.length,
    };

    const templateData = {
      ...colors.light,
      ...Object.fromEntries(Object.entries(colors.dark).map(([k, v]) => [k + "Dark", v])),
      ...stats,
    };

    const __dirname = path.dirname(new URL(import.meta.url).pathname);
    const templatePath = path.resolve(__dirname, "..", "templates", "template_general.hbs");
    const svgContent = Handlebars.compile(fs.readFileSync(templatePath, "utf8"))(templateData);

    const svgDir = path.resolve(__dirname, "..", "..", "output");
    if (!fs.existsSync(svgDir)) fs.mkdirSync(svgDir, { recursive: true });

    fs.writeFileSync(path.join(svgDir, "stats_general.svg"), svgContent);
    console.log('✅ stats_general.svg created');
  } catch (error) {
    console.error("❌ Error generating SVG:", error);
    process.exit(1);
  }
}

main();