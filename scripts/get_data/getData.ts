/**
 * getData.ts
 *
 * Reads a JSON file (ids.json) with submission records, scrapes the corresponding Reddit submissions,
 * and enriches the solutions with complexity metrics.
 * It filters out non-Python submissions by:
 *   - Checking for a language tag that includes "python"
 *   - If no tag is present, by looking for Python indicators (such as "def ")
 *   - And by excluding comments typical for other languages (e.g., if they contain "defmodule" or a line
 *     that is exactly "end").
 *
 * It also supports Topaz-paste links (https://topaz.github.io/paste/#...) by
 * directly decoding the code embedded in the URL (no extra HTTP request needed).
 *
 * It writes a new output file (solutions.json) and sorts the final results by ascending year,
 * ascending day, and descending score.
 *
 * Usage: npm run start
 */

const snoowrap = require("snoowrap");
const fs = require("fs");
const path = require("path");
const { decompressFromBase64 } = require("lz-string");

// --- 1. Setup Multiple Reddit Clients ---
interface RedditCredentials {
  userAgent: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

const credentialsPool: RedditCredentials[] = [
  {
    userAgent: "AOC/1.0 by AOCscraper",
    clientId: "Vxo4vQ-6U3xO4OZINUuBQw",
    clientSecret: "9HqqdK80wCppkbkyfKyq3sWNipVe-w",
    username: "AOCscraper",
    password: "RijksuniversiteitGroningenAOC2025!#$",
  },
  {
    userAgent: "AOC2/1.0 by AOCscraper2",
    clientId: "ZqyrmkbR1hohpi1XKPZu9g",
    clientSecret: "tmJTfftdABDZ7MvWBJdhqehJeesZ5A",
    username: "AOCscraper",
    password: "RijksuniversiteitGroningenAOC2025!#$",
  },
  {
    userAgent: "AOC3/1.0 by AOCscraper2",
    clientId: "TMPDeWsHfJswMHDrVYon1g",
    clientSecret: "hRJ_1M_Kld-7Frckaw2-trt70QTi6A",
    username: "AOCscraper",
    password: "RijksuniversiteitGroningenAOC2025!#$",
  },
];

const redditClients = credentialsPool.map((creds) => new snoowrap(creds));

function getNextRedditClient(): typeof snoowrap {
  const client = redditClients.shift()!;
  redditClients.push(client);
  return client;
}

// --- 2. Interfaces for Submission and Processed Result ---
interface SubmissionRecord {
  year: number;
  day: number;
  id: string;
}

interface ProcessedResult {
  year: number;
  day: number;
  author: string;
  created_utc: string;
  score: number;
  permalink: string;
  language: string;
  part1: string;
  part2: string;
}

interface Comment {
  id: string;
  parent_id: string;
  body: string;
  author: { name: string };
  created_utc: number;
  score: number;
  permalink: string;
}

// --- 3. Regex Patterns and Helper Functions ---
const languageTagRegexGlobal = /\[language:\s*([^\]]+)\]/gi;
const fencedCodeRegex = /```([\s\S]*?)```/g;
const indentedCodeRegex = /^ {4}.*(\r?\n^(?: {4}|$).*)*/gm;
const topazLinkRegex =
  /https:\/\/topaz\.github\.io\/paste\/#([A-Za-z0-9+/=]+)/g;

function detectPartsInCode(code: string): {
  isPart1: boolean;
  isPart2: boolean;
} {
  const lower = code.toLowerCase();
  return {
    isPart1: lower.includes("part 1"),
    isPart2: lower.includes("part 2"),
  };
}

function parseDayAndYear(title: string): { day: number; year: number } | null {
  const match = title.match(/(\d{4}).*day\s+(\d+)/i);
  if (!match) return null;
  return { year: parseInt(match[1], 10), day: parseInt(match[2], 10) };
}

function extractAllCodeBlocks(commentBody: string): string[] {
  const codeBlocks: string[] = [];

  // fenced code
  let m: RegExpExecArray | null;
  while ((m = fencedCodeRegex.exec(commentBody)) !== null) {
    codeBlocks.push(m[1].trim());
  }
  fencedCodeRegex.lastIndex = 0;

  // indented code
  while ((m = indentedCodeRegex.exec(commentBody)) !== null) {
    const block = m[0]
      .split(/\r?\n/)
      .map((line) => line.replace(/^ {4}/, ""))
      .join("\n")
      .trim();
    if (block) codeBlocks.push(block);
  }
  indentedCodeRegex.lastIndex = 0;

  return codeBlocks;
}

function extractTopazCodeBlocks(commentBody: string): string[] {
  const decoded: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = topazLinkRegex.exec(commentBody)) !== null) {
    const fragment = m[1];
    const code = decompressFromBase64(fragment);
    if (code !== null) decoded.push(code);
  }
  topazLinkRegex.lastIndex = 0;
  return decoded;
}

function shouldSkipComment(commentBody: string): boolean {
  const lower = commentBody.toLowerCase();
  if (
    lower.includes("defmodule") ||
    lower.includes("clojure") ||
    lower.includes("rust")
  ) {
    return true;
  }
  const lines = commentBody.split(/\r?\n/).map((line) => line.trim());
  return lines.some((line) => line === "end");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- 4. Process Submissions with Retry and Client Rotation ---
async function processSubmissionWithRetry(
  submissionRecord: SubmissionRecord
): Promise<ProcessedResult[]> {
  const { id, year: yearFromFile, day: dayFromFile } = submissionRecord;
  const results: ProcessedResult[] = [];
  const maxRetries = 5;
  let attempts = 0;

  while (attempts < maxRetries) {
    const client = getNextRedditClient();
    try {
      const submission = await client.getSubmission(id).fetch();
      const meta = parseDayAndYear(submission.title ?? "") || {
        year: yearFromFile,
        day: dayFromFile,
      };

      const allComments: Comment[] = await submission.comments.fetchAll();
      const parentComments = allComments.filter(
        (c) => c.parent_id === `t3_${submission.id}`
      );

      for (const comment of parentComments) {
        if (shouldSkipComment(comment.body)) continue;

        // language detection
        const tags = [...comment.body.matchAll(languageTagRegexGlobal)];
        let rawLang = "";
        if (tags.length === 0) {
          if (comment.body.toLowerCase().includes("def ")) {
            rawLang = "Python";
          } else {
            continue;
          }
        } else {
          rawLang = tags[0][1].trim().replace(/\\+$/, "");
        }
        if (!rawLang.toLowerCase().includes("python")) continue;

        // extract code blocks + topaz blocks
        const codeBlocks = extractAllCodeBlocks(comment.body);
        const topazBlocks = extractTopazCodeBlocks(comment.body);
        const allBlocks = codeBlocks.concat(topazBlocks);
        if (allBlocks.length === 0) continue;

        // assign parts
        let part1 = "";
        let part2 = "";
        for (const block of allBlocks) {
          const { isPart1, isPart2 } = detectPartsInCode(block);
          if (isPart1 && isPart2) {
            if (!part1) part1 = block;
            if (!part2) part2 = block;
          } else if (isPart1 && !part1) {
            part1 = block;
          } else if (isPart2 && !part2) {
            part2 = block;
          }
        }
        if (!part1 && !part2) {
          // fallback first block as part1
          part1 = allBlocks[0];
        }

        results.push({
          year: meta.year,
          day: meta.day,
          author: comment.author.name,
          created_utc: new Date(comment.created_utc * 1000).toISOString(),
          score: comment.score,
          permalink: `https://www.reddit.com${comment.permalink}`,
          language: rawLang,
          part1,
          part2,
        });
      }
      break;
    } catch (err: any) {
      if (err.name === "RateLimitError") {
        const wait = err.timeout ? err.timeout * 1000 : 60000;
        await delay(wait);
        attempts++;
      } else {
        console.error(`Error on submission ${id}:`, err);
        break;
      }
    }
  }

  if (attempts === maxRetries) {
    console.error(`Max retries reached for ${id}, skipping.`);
  }

  return results;
}

// --- 5. Main Function ---
async function fetchAndProcessAllSubmissions(): Promise<void> {
  try {
    const idsPath = path.join(__dirname, "ids.json");
    const raw = fs.readFileSync(idsPath, "utf-8");
    let records: SubmissionRecord[] = JSON.parse(raw);

    // sort by year, day
    records = records.sort((a, b) => a.year - b.year || a.day - b.day);

    const outputPath = path.join(__dirname, "../../data/solutions.json");
    let allResults: ProcessedResult[] = [];

    for (const rec of records) {
      const res = await processSubmissionWithRetry(rec);
      console.log(`Fetching Reddit submissions for ${rec.year} and ${rec.day}`);
      allResults.push(...res);
    }

    // final sort: year ↑, day ↑, score ↓
    allResults.sort(
      (a, b) => a.year - b.year || a.day - b.day || b.score - a.score
    );

    fs.writeFileSync(outputPath, JSON.stringify(allResults, null, 2), "utf-8");
    console.log(`Data saved to ${outputPath}`);
  } catch (err) {
    console.error("Error in main:", err);
  }
}

// --- 6. Execute ---
fetchAndProcessAllSubmissions().catch((err) => {
  console.error("Unhandled error:", err);
});
