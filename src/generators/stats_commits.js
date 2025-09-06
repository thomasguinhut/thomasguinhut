import fs from "fs";
import path from "path";
import Handlebars from "handlebars";
import colors from "../../themes/colors_commits.js";

const username = process.env.GITHUB_ACTOR;
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

async function fetchAllContributions(userCreationDate, now) {
  let currentStart = new Date(userCreationDate);
  let allContributionDays = [];
  let totalContributionsSum = 0;

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
    totalContributionsSum = contributions.totalContributions; // Utilise le total complet
    contributions.contributionCalendar.weeks.forEach((week) => {
      week.contributionDays.forEach((day) => {
        allContributionDays.push(day);
      });
    });
    currentStart = currentEnd;
  }

  return { allContributionDays, totalContributionsSum };
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

// Fonction pour formater la date de mise à jour de façon plus robuste
function formatLastUpdate() {
  const now = new Date();
  // Utiliser UTC puis ajuster pour Paris (+2h en été, +1h en hiver)
  const parisTime = new Date(now.getTime() + (2 * 60 * 60 * 1000)); // Ajustement pour UTC+2
  
  const day = parisTime.getUTCDate().toString().padStart(2, '0');
  const monthNames = ['jan', 'fév', 'mar', 'avr', 'mai', 'juin', 
                      'juil', 'août', 'sept', 'oct', 'nov', 'déc'];
  const month = monthNames[parisTime.getUTCMonth()];
  const year = parisTime.getUTCFullYear();
  const hours = parisTime.getUTCHours().toString().padStart(2, '0');
  const minutes = parisTime.getUTCMinutes().toString().padStart(2, '0');
  
  return `${day} ${month} ${year} ${hours}:${minutes}`;
}

async function generateSVG() {
  try {
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

    // Correction pour currentStreakDateRange - toujours retourner quelque chose ou null
    const currentStreakDateRange =
      currentStreak > 0 && currentStreakStart
        ? `${formatDate(currentStreakStart)} - ${formatDate(mostRecentCommitDate)}`
        : null; // null au lieu de chaîne vide

    const lastUpdate = formatLastUpdate();

    const templateData = {
      ...colors.light,
      ...Object.fromEntries(
        Object.entries(colors.dark).map(([k, v]) => [k + "Dark", v])
      ),
      totalContributions: totalContributionsSum,
      commitDateRange,
      currentStreak,
      currentStreakDateRange, // Maintenant null quand pas de streak
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
    fs.writeFileSync(svgContent, outputPath);
    console.log(`SVG file created: ${outputPath}`);
  } catch (error) {
    console.error("Error generating SVG:", error);
  }
}

generateSVG();
