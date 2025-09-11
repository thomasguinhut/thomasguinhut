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

// Fonction utilitaire pour formater les dates
function formatDateString(date) {
  const d = new Date(date);
  return d.getFullYear() + '-' + 
    String(d.getMonth() + 1).padStart(2, '0') + '-' + 
    String(d.getDate()).padStart(2, '0');
}

// Fonction utilitaire pour obtenir la date d'aujourd'hui
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
  
  const variables = { username };
  const data = await fetchFromGitHub(query, variables);
  
  if (!data.user) {
    throw new Error(`User ${username} not found`);
  }
  
  console.log(`Debug - User ${data.user.login} created at:`, data.user.createdAt);
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
  
  if (!data.user) {
    throw new Error(`User ${username} not found`);
  }
  
  return data.user.contributionsCollection;
}

async function fetchAllContributions(startDate, endDate) {
  let allContributionDays = [];
  let yearlyTotals = {};
  let totalContributionsSum = 0;

  let currentStart = new Date(startDate);
  const now = new Date(endDate);

  console.log('Debug - Fetching contributions from:', formatDateString(currentStart));
  console.log('Debug - Fetching contributions to:', formatDateString(now));

  while (currentStart < now) {
    // Récupérer une année à la fois
    const currentEnd = new Date(
      Math.min(
        new Date(currentStart.getFullYear() + 1, 0, 1).getTime(), // 1er janvier de l'année suivante
        now.getTime()
      )
    );

    const year = currentStart.getFullYear();
    console.log(`Debug - Fetching year: ${year} (${formatDateString(currentStart)} to ${formatDateString(currentEnd)})`);
    
    try {
      const contributions = await fetchContributionsForPeriod(currentStart, currentEnd);

      let yearSum = 0;
      let dayCount = 0;
      
      contributions.contributionCalendar.weeks.forEach((week) => {
        week.contributionDays.forEach((day) => {
          allContributionDays.push({
            date: day.date,
            contributionCount: day.contributionCount
          });
          yearSum += day.contributionCount;
          dayCount++;
        });
      });

      yearlyTotals[year] = yearSum;
      totalContributionsSum += yearSum;
      
      console.log(`Debug - Year ${year}: ${yearSum} contributions across ${dayCount} days`);
      
      // Petit délai pour éviter de surcharger l'API
      await new Promise(resolve => setTimeout(resolve, 100));

    } catch (error) {
      console.error(`Error fetching contributions for year ${year}:`, error);
      // Continuer avec l'année suivante même en cas d'erreur
    }

    currentStart = new Date(currentEnd);
  }

  console.log(`Debug - Total: ${totalContributionsSum} contributions across ${allContributionDays.length} days`);

  return {
    allContributionDays,
    totalContributionsSum,
    yearlyTotals,
  };
}

function calculateStreaksAndTotals(allContributionDays) {
  if (!allContributionDays || allContributionDays.length === 0) {
    console.log('Debug - No contribution days provided');
    return {
      currentStreak: 0,
      currentStreakStart: null,
      longestStreak: 0,
      longestStreakStart: null,
      longestStreakEnd: null,
    };
  }

  // Trier par date
  allContributionDays.sort((a, b) => new Date(a.date) - new Date(b.date));
  
  const today = getTodayString();
  console.log('Debug - Today:', today);
  console.log('Debug - Processing', allContributionDays.length, 'days');

  let longestStreak = 0;
  let longestStreakStart = null;
  let longestStreakEnd = null;
  
  let currentStreakLength = 0;
  let currentStreakStart = null;
  let lastContributionDate = null;
  
  // Variables pour le streak en cours (celui qui peut être encore actif)
  let activeStreak = 0;
  let activeStreakStart = null;

  for (let i = 0; i < allContributionDays.length; i++) {
    const { date, contributionCount } = allContributionDays[i];
    
    // Ne traiter que les dates jusqu'à aujourd'hui inclus
    if (date > today) continue;

    if (contributionCount > 0) {
      if (currentStreakLength === 0) {
        // Début d'un nouveau streak
        currentStreakLength = 1;
        currentStreakStart = date;
      } else {
        // Vérifier la continuité avec le jour précédent
        const prevDate = new Date(lastContributionDate);
        const currDate = new Date(date);
        const diffDays = Math.floor((currDate - prevDate) / (1000 * 60 * 60 * 24));
        
        if (diffDays === 1) {
          // Streak continue
          currentStreakLength++;
        } else {
          // Gap détecté, nouveau streak
          currentStreakLength = 1;
          currentStreakStart = date;
        }
      }
      
      // Mettre à jour le plus long streak
      if (currentStreakLength > longestStreak) {
        longestStreak = currentStreakLength;
        longestStreakStart = currentStreakStart;
        longestStreakEnd = date;
      }
      
      lastContributionDate = date;
    } else {
      // Jour sans contribution = fin du streak
      currentStreakLength = 0;
      currentStreakStart = null;
    }
  }

  // Déterminer le streak actuel (seulement s'il est encore "vivant")
  if (lastContributionDate && currentStreakLength > 0) {
    const lastDate = new Date(lastContributionDate);
    const todayDate = new Date(today);
    const daysSinceLastContrib = Math.floor((todayDate - lastDate) / (1000 * 60 * 60 * 24));
    
    console.log('Debug - Last contribution:', lastContributionDate);
    console.log('Debug - Days since last contribution:', daysSinceLastContrib);
    console.log('Debug - Current streak length:', currentStreakLength);
    
    // Le streak est considéré comme actuel si la dernière contribution était aujourd'hui ou hier
    if (daysSinceLastContrib <= 1) {
      activeStreak = currentStreakLength;
      activeStreakStart = currentStreakStart;
    }
  }

  console.log('Debug - Results:');
  console.log('  - Current streak:', activeStreak);
  console.log('  - Longest streak:', longestStreak);
  console.log('  - Longest streak period:', longestStreakStart, 'to', longestStreakEnd);

  return {
    currentStreak: activeStreak,
    currentStreakStart: activeStreakStart,
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
    console.log('=== Starting SVG generation ===');
    console.log('Time:', new Date().toISOString());
    console.log('Username:', username);
    
    // Récupérer la date de création du compte
    const userCreationDate = await fetchUserCreationDate();
    const now = new Date();
    
    // Récupérer toutes les contributions
    console.log('Fetching all contributions...');
    const { allContributionDays, totalContributionsSum, yearlyTotals } = 
      await fetchAllContributions(userCreationDate, now);
    
    if (totalContributionsSum === 0) {
      console.warn('Warning: No contributions found. Check your username and token.');
    }
    
    // Calculer les streaks
    console.log('Calculating streaks...');
    const streakData = calculateStreaksAndTotals(allContributionDays);
    
    // Préparer les données pour le template
    const commitDateRange = `${formatDate(userCreationDate)} - ${formatDate(now)}`;
    
    const longestStreakDates = streakData.longestStreak > 0 && 
      streakData.longestStreakStart && streakData.longestStreakEnd
        ? `${formatDate(streakData.longestStreakStart)} - ${formatDate(streakData.longestStreakEnd)}`
        : "N/A";

    const currentStreakDateRange = streakData.currentStreak > 0 && 
      streakData.currentStreakStart
        ? `${formatDate(streakData.currentStreakStart)} - ${formatDate(now)}`
        : "N/A";

    const lastUpdate = formatLastUpdate();
    
    // Données pour le template
    const templateData = {
      ...colors.light,
      ...Object.fromEntries(
        Object.entries(colors.dark).map(([k, v]) => [k + "Dark", v])
      ),
      totalContributions: totalContributionsSum,
      commitDateRange,
      currentStreak: streakData.currentStreak,
      currentStreakDateRange,
      longestStreak: streakData.longestStreak,
      longestStreakDateRange: longestStreakDates,
      lastUpdate,
    };

    console.log('Template data summary:');
    console.log('  - Total contributions:', templateData.totalContributions);
    console.log('  - Current streak:', templateData.currentStreak);
    console.log('  - Longest streak:', templateData.longestStreak);
    console.log('  - Last update:', templateData.lastUpdate);

    // Générer le SVG
    const __dirname = path.dirname(new URL(import.meta.url).pathname);
    const templatePath = path.resolve(__dirname, "..", "templates", "template_commits.hbs");
    
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Template file not found: ${templatePath}`);
    }
    
    const templateContent = fs.readFileSync(templatePath, "utf8");
    const svgContent = Handlebars.compile(templateContent)(templateData);
    
    // Sauvegarder le fichier
    const svgDir = path.resolve(__dirname, "..", "..", "output");
    if (!fs.existsSync(svgDir)) {
      fs.mkdirSync(svgDir, { recursive: true });
    }
    
    const outputPath = path.join(svgDir, "stats_commits.svg");
    fs.writeFileSync(outputPath, svgContent);
    
    console.log(`✅ SVG file created successfully: ${outputPath}`);
    console.log('=== SVG generation completed ===');
    
  } catch (error) {
    console.error("❌ Error generating SVG:", error);
    console.error("Stack trace:", error.stack);
    process.exit(1);
  }
}

// Exécuter le script
generateSVG();