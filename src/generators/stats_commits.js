import fs from "fs";
import path from "path";
import Handlebars from "handlebars";
import colors from "../../themes/colors_commits.js";
import fetch from "node-fetch";

const username = process.env.GITHUB_USERNAME || "thomasguinhut";
const token = process.env.ACCESS_TOKEN;
const GRAPHQL_API = "https://api.github.com/graphql";

if (!token) {
  console.error("Error: ACCESS_TOKEN is not defined in the environment variables.");
  process.exit(1);
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
  if (!response.ok) {
    const errorText = await response.text();
    console.error("GitHub API Error:", errorText);
    throw new Error("Failed to fetch data from GitHub API.");
  }
  const data = await response.json();
  if (data.errors) {
    console.error("GitHub API Error:", JSON.stringify(data.errors, null, 2));
    throw new Error("Failed to fetch data from GitHub API.");
  }
  return data.data;
}

async function fetchUserCreationDate() {
  const query = `
    query ($username: String!) {
      user(login: $username) {
        createdAt
      }
    }
  `;
  const variables = { username };
  const data = await fetchFromGitHub(query, variables);
  return new Date(data.user.createdAt);
}

async function fetchContributionsForPeriod(fromDate, toDate) {
  const query = `
    query ($username: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $username) {
        contributionsCollection(from: $from, to: $to) {
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
          totalPullRequestReviewContributions
          totalRepositoryContributions
          totalContributions
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
  return data.user.contributionsCollection;
}

async function fetchAllContributions(username, startDate, endDate) {
  let allContributionDays = [];
  let yearlyTotals = {};
  let totalContributionsSum = 0;

  let currentStart = new Date(startDate);
  const now = new Date(endDate);

  while (currentStart < now) {
    const currentEnd = new Date(
      Math.min(
        new Date(
          currentStart.getFullYear() + 1,
          currentStart.getMonth(),
          currentStart.getDate()
        ).getTime(),
        now.getTime()
      )
    );

    const contributions = await fetchContributionsForPeriod(currentStart, currentEnd);

    let yearSum = 0;
    contributions.contributionCalendar.weeks.forEach((week) => {
      week.contributionDays.forEach((day) => {
        allContributionDays.push(day);
        yearSum += day.contributionCount;   // ✅ somme des carrés verts par année
      });
    });

    yearlyTotals[currentStart.getFullYear()] = yearSum;
    totalContributionsSum += yearSum;

    currentStart = currentEnd;
  }

  return {
    allContributionDays,
    totalContributionsSum,
    yearlyTotals,
  };
}


function calculateStreaksAndTotals(allContributionDays) {
  allContributionDays.sort((a, b) => new Date(a.date) - new Date(b.date));
  let longestStreak = 0;
  let longestStreakStart = null;
  let longestStreakEnd = null;
  let currentStreak = 0;
  let currentStreakStart = null;
  let lastContributionDate = null;
  const today = new Date().toISOString().split("T")[0];

  for (const { date, contributionCount } of allContributionDays) {
    if (date > today) continue;
    if (contributionCount > 0) {
      if (!lastContributionDate) {
        currentStreak = 1;
        currentStreakStart = date;
      } else {
        const prev = new Date(lastContributionDate);
        const curr = new Date(date);
        const diffDays = Math.floor((curr - prev) / (1000 * 60 * 60 * 24));
        if (diffDays === 1) {
          currentStreak++;
        } else {
          currentStreak = 1;
          currentStreakStart = date;
        }
      }
      if (currentStreak > longestStreak) {
        longestStreak = currentStreak;
        longestStreakStart = currentStreakStart;
        longestStreakEnd = date;
      }
      lastContributionDate = date;
    }
  }

  // Vérifie si la dernière contribution est aujourd'hui
  let isCurrentStreakActive = lastContributionDate && new Date(lastContributionDate).toISOString().split("T")[0] === today;
  let currentStreakValue = isCurrentStreakActive ? currentStreak : 0;
  let currentStreakStartValue = isCurrentStreakActive ? currentStreakStart : null;

  return {
    currentStreak: currentStreakValue,
    currentStreakStart: currentStreakStartValue,
    longestStreak,
    longestStreakStart,
    longestStreakEnd,
  };
}

function formatDate(date) {
  if (!date) return "N/A";
  const options = { year: "numeric", month: "short", day: "numeric" };
  return new Date(date).toLocaleDateString("en", options);
}

// Fonction pour formater la date de mise à jour - TOUJOURS actuelle
function formatLastUpdate() {
  return new Date().toLocaleString('fr-FR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Paris'
  }) + " (french time)";
}

async function generateSVG() {
  try {
    console.log('Starting SVG generation at:', new Date().toISOString());
    
    const userCreationDate = await fetchUserCreationDate();
    const now = new Date();
    const { allContributionDays, totalContributionsSum } = await fetchAllContributions(userCreationDate, now);
    const {
      currentStreak,
      currentStreakStart,
      longestStreak,
      longestStreakStart,
      longestStreakEnd,
    } = calculateStreaksAndTotals(allContributionDays);

    const mostRecentCommitDate = now;
    const commitDateRange = userCreationDate
      ? `${formatDate(userCreationDate)} - ${formatDate(mostRecentCommitDate)}`
      : "N/A";

    const longestStreakDates =
      longestStreak > 0 && longestStreakStart && longestStreakEnd
        ? `${formatDate(longestStreakStart)} - ${formatDate(longestStreakEnd)}`
        : "N/A";

    // CORRECTION : retourner null au lieu de chaîne vide
    const currentStreakDateRange =
      currentStreak > 0 && currentStreakStart
        ? `${formatDate(currentStreakStart)} - ${formatDate(mostRecentCommitDate)}`
        : "N/A";

    // CORRECTION : utiliser la nouvelle fonction de formatage
    const lastUpdate = formatLastUpdate();

    console.log('Debug - currentStreak:', currentStreak);
    console.log('Debug - currentStreakDateRange:', currentStreakDateRange);
    console.log('Debug - lastUpdate:', lastUpdate);

    const templateData = {
      ...colors.light,
      ...Object.fromEntries(
        Object.entries(colors.dark).map(([k, v]) => [k + "Dark", v])
      ),
      totalContributions: totalContributionsSum,
      commitDateRange,
      currentStreak,
      currentStreakDateRange,
      longestStreak,
      longestStreakDateRange: longestStreakDates,
      lastUpdate,
    };

    const __dirname = path.dirname(new URL(import.meta.url).pathname);
    const templatePath = path.resolve(__dirname, "..", "templates", "template_commits.hbs");
    const svgContent = Handlebars.compile(fs.readFileSync(templatePath, "utf8"))(templateData);
    const svgDir = path.resolve(__dirname, "..", "..", "output");
    if (!fs.existsSync(svgDir)) {
      fs.mkdirSync(svgDir, { recursive: true });
    }
    const outputPath = path.join(svgDir, "stats_commits.svg");
    fs.writeFileSync(outputPath, svgContent);
    console.log(`SVG file created: ${outputPath}`);
    console.log('SVG generation completed at:', new Date().toISOString());
  } catch (error) {
    console.error("Error generating SVG:", error);
  }
}

generateSVG();
