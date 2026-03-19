import fs from "fs";
import path from "path";
import Handlebars from "handlebars";
import colors from "../../themes/colors_commits.js";
import fetch from "node-fetch";

const username = process.env.GITHUB_USERNAME;
const token = process.env.ACCESS_TOKEN;
const GRAPHQL_API = "https://api.github.com/graphql";

if (!token) {
  console.error("Error: ACCESS_TOKEN is not defined in the environment variables.");
  process.exit(1);
}
if (!username) {
  console.error("Error: GITHUB_USERNAME is not defined in the environment variables.");
  process.exit(1);
}

function formatDateString(date) {
  const d = new Date(date);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function getTodayString() {
  return formatDateString(new Date());
}

async function fetchFromGitHub(query, variables = {}) {
  try {
    const response = await fetch(GRAPHQL_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("GitHub API Error:", errorText);
      throw new Error(`GitHub API returned status ${response.status}`);
    }
    const data = await response.json();
    if (data.errors) {
      console.error("GitHub API GraphQL Errors:", JSON.stringify(data.errors, null, 2));
      throw new Error("GraphQL errors in GitHub API response");
    }
    return data.data;
  } catch (error) {
    console.error("Error in fetchFromGitHub:", error);
    throw error;
  }
}

async function fetchUserCreationDate() {
  const query = `
    query ($username: String!) {
      user(login: $username) {
        createdAt
        login
      }
    }
  `;
  const data = await fetchFromGitHub(query, { username });
  if (!data.user) throw new Error(`User ${username} not found`);
  console.log(`User ${data.user.login} created at:`, data.user.createdAt);
  return new Date(data.user.createdAt);
}

async function fetchContributionsForPeriod(fromDate, toDate) {
  const query = `
    query ($username: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $username) {
        contributionsCollection(from: $from, to: $to, includePrivateContributions: true) {
          totalCommitContributions
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }
      }
    }
  `;
  const variables = {
    username,
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
  };
  const data = await fetchFromGitHub(query, variables);
  if (!data.user) throw new Error(`User ${username} not found`);
  return data.user.contributionsCollection;
}

async function fetchAllContributions(startDate, endDate) {
  let allContributionDays = [];
  let totalContributionsSum = 0;
  let currentStart = new Date(startDate);
  const now = new Date(endDate);

  while (currentStart < now) {
    const currentEnd = new Date(
      Math.min(
        new Date(currentStart.getFullYear() + 1, 0, 1).getTime(),
        now.getTime()
      )
    );
    const year = currentStart.getFullYear();
    console.log(`Fetching year: ${year}`);
    try {
      const contributions = await fetchContributionsForPeriod(currentStart, currentEnd);
      let yearSum = 0;
      contributions.contributionCalendar.weeks.forEach((week) => {
        week.contributionDays.forEach((day) => {
          allContributionDays.push({ date: day.date, contributionCount: day.contributionCount });
          yearSum += day.contributionCount;
        });
      });
      totalContributionsSum += yearSum;
      console.log(`Year ${year}: ${yearSum} contributions`);
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.error(`Error fetching contributions for year ${year}:`, error);
    }
    currentStart = new Date(currentEnd);
  }

  return { allContributionDays, totalContributionsSum };
}

function calculateStreaksAndTotals(allContributionDays) {
  if (!allContributionDays || allContributionDays.length === 0) {
    return { currentStreak: 0, currentStreakStart: null, longestStreak: 0, longestStreakStart: null, longestStreakEnd: null };
  }

  allContributionDays.sort((a, b) => new Date(a.date) - new Date(b.date));
  const today = getTodayString();

  let longestStreak = 0, longestStreakStart = null, longestStreakEnd = null;
  let currentStreakLength = 0, currentStreakStart = null, lastContributionDate = null;
  let activeStreak = 0, activeStreakStart = null;

  for (const { date, contributionCount } of allContributionDays) {
    if (date > today) continue;
    if (contributionCount > 0) {
      if (currentStreakLength === 0) {
        currentStreakLength = 1;
        currentStreakStart = date;
      } else {
        const diffDays = Math.floor(
          (new Date(date) - new Date(lastContributionDate)) / (1000 * 60 * 60 * 24)
        );
        if (diffDays === 1) {
          currentStreakLength++;
        } else {
          currentStreakLength = 1;
          currentStreakStart = date;
        }
      }
      if (currentStreakLength > longestStreak) {
        longestStreak = currentStreakLength;
        longestStreakStart = currentStreakStart;
        longestStreakEnd = date;
      }
      lastContributionDate = date;
    } else {
      currentStreakLength = 0;
      currentStreakStart = null;
    }
  }

  if (lastContributionDate && currentStreakLength > 0) {
    const daysSinceLastContrib = Math.floor(
      (new Date(today) - new Date(lastContributionDate)) / (1000 * 60 * 60 * 24)
    );
    if (daysSinceLastContrib <= 1) {
      activeStreak = currentStreakLength;
      activeStreakStart = currentStreakStart;
    }
  }

  return { currentStreak: activeStreak, currentStreakStart: activeStreakStart, longestStreak, longestStreakStart, longestStreakEnd };
}

function formatDate(date) {
  if (!date) return "N/A";
  return new Date(date).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" });
}

function formatLastUpdate() {
  return new Date().toLocaleString('fr-FR', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris'
  }) + " (french time)";
}

async function generateSVG() {
  try {
    console.log('=== Starting SVG generation ===');
    console.log('Username:', username);

    const userCreationDate = await fetchUserCreationDate();
    const now = new Date();
    const { allContributionDays, totalContributionsSum } = await fetchAllContributions(userCreationDate, now);

    if (totalContributionsSum === 0) {
      console.warn('Warning: No contributions found. Check your username and token.');
    }

    const streakData = calculateStreaksAndTotals(allContributionDays);
    const commitDateRange = `${formatDate(userCreationDate)} - ${formatDate(now)}`;
    const longestStreakDates = streakData.longestStreak > 0 && streakData.longestStreakStart && streakData.longestStreakEnd
      ? `${formatDate(streakData.longestStreakStart)} - ${formatDate(streakData.longestStreakEnd)}`
      : "N/A";
    const currentStreakDateRange = streakData.currentStreak > 0 && streakData.currentStreakStart
      ? `${formatDate(streakData.currentStreakStart)} - ${formatDate(now)}`
      : "N/A";

    const templateData = {
      ...colors.light,
      ...Object.fromEntries(Object.entries(colors.dark).map(([k, v]) => [k + "Dark", v])),
      totalContributions: totalContributionsSum,
      commitDateRange,
      currentStreak: streakData.currentStreak,
      currentStreakDateRange,
      longestStreak: streakData.longestStreak,
      longestStreakDateRange: longestStreakDates,
      lastUpdate: formatLastUpdate(),
    };

    console.log('Total contributions:', templateData.totalContributions);
    console.log('Current streak:', templateData.currentStreak);
    console.log('Longest streak:', templateData.longestStreak);

    const __dirname = path.dirname(new URL(import.meta.url).pathname);
    const templatePath = path.resolve(__dirname, "..", "templates", "template_commits.hbs");
    if (!fs.existsSync(templatePath)) throw new Error(`Template not found: ${templatePath}`);

    const svgContent = Handlebars.compile(fs.readFileSync(templatePath, "utf8"))(templateData);
    const svgDir = path.resolve(__dirname, "..", "..", "output");
    if (!fs.existsSync(svgDir)) fs.mkdirSync(svgDir, { recursive: true });

    fs.writeFileSync(path.join(svgDir, "stats_commits.svg"), svgContent);
    console.log('✅ stats_commits.svg created');
  } catch (error) {
    console.error("❌ Error generating SVG:", error);
    process.exit(1);
  }
}

generateSVG();