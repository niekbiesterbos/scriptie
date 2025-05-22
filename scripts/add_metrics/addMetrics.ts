/**
 * @fileoverview
 * Script to compute code complexity metrics (cyclomatic complexity, Halstead metrics,
 * and maintainability index) for Python solutions stored in solutions.json.
 * Also identifies algorithmic strategies used in each solution.
 *
 * Steps:
 *  1. Remove `part2` from each solution.
 *  2. Check if `part1` is non-empty; if empty, skip.
 *  3. Aggressively pre-filter lines that appear non-Python (e.g., #include, std::, trailing semicolons).
 *  4. Sanitize code (remove non-breaking spaces, trailing whitespace, etc.).
 *  5. Attempt to compute metrics directly on sanitized code using Radon:
 *     - If Radon fails, run Black to fix indentation, then try Radon again.
 *  6. If both attempts fail, completely omit the solution from output.
 *  7. For valid solutions, perform AST analysis to identify algorithmic strategies.
 *  8. Write enriched data to solutions_with_metrics.json.
 *
 * Usage:
 *   1. Ensure solutions.json exists in the appropriate directory.
 *   2. Ensure Radon is installed (pip install radon) and is in PATH.
 *   3. Ensure Black is installed (pip install black) and is in PATH.
 *   4. Run with `npx ts-node compute_metrics.ts`
 */

import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

interface Solution {
  year: number;
  day: number;
  author: string;
  created_utc: string;
  score: number;
  permalink: string;
  language: string;
  part1: string;
  part2?: string;
  cyclomaticComplexity?: any;
  halsteadMetrics?: any;
  maintainabilityIndex?: number;
  algorithmicStrategies?: string[];
}

interface MetricsResult {
  cyclomaticComplexity: any;
  halsteadMetrics: any;
  maintainabilityIndex: any;
}

/**
 * Aggressive pre-filter to skip lines that appear to be non-Python (C++ includes, etc.).
 * If the code has too many suspicious lines, we skip the entire solution.
 */
function isLikelyNonPython(code: string): boolean {
  const lines = code.split("\n");
  let suspiciousCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Heuristics: if line has #include, using namespace std, or std:: or trailing semicolon, it's likely C++.
    if (
      trimmed.startsWith("#include") ||
      trimmed.startsWith("using namespace std") ||
      trimmed.includes("std::")
    ) {
      suspiciousCount++;
    }

    // Check if line ends with a semicolon in a suspicious way (like int x = 5;)
    // We exclude lines that might be a Python statement with a colon (like "if x == 5:")
    if (/;$/.test(trimmed) && !/:$/.test(trimmed)) {
      suspiciousCount++;
    }
  }

  // If more than, 1 suspicious lines, it's probably non-Python
  return suspiciousCount > 2;
}

/**
 * Basic sanitation to remove common problematic characters and trailing whitespace.
 */
function basicSanitize(code: string): string {
  let sanitized = code;

  // 1. Replace non-breaking space (U+00A0) with a regular space
  sanitized = sanitized.replace(/\u00A0/g, " ");

  // 2. Remove carriage returns (if any)
  sanitized = sanitized.replace(/\r/g, "");

  // 3. Trim trailing whitespace from each line
  sanitized = sanitized
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");

  return sanitized;
}

/**
 * Runs Radon (cc, hal, mi) on a Python file and returns the parsed JSON results.
 * Throws an error if any command fails or if JSON parsing fails.
 */
async function runRadonOnFile(filePath: string): Promise<MetricsResult> {
  // Cyclomatic Complexity
  const { stdout: ccStdout } = await execAsync(`radon cc -j ${filePath}`);
  const ccData = JSON.parse(ccStdout)[filePath];

  // Halstead Metrics
  const { stdout: halStdout } = await execAsync(`radon hal -j ${filePath}`);
  const halData = JSON.parse(halStdout)[filePath];

  // Maintainability Index
  const { stdout: miStdout } = await execAsync(`radon mi -j ${filePath}`);
  const miData = JSON.parse(miStdout)[filePath];

  // Check if any metric contains an error
  if (
    (ccData && typeof ccData === "object" && "error" in ccData) ||
    (halData && typeof halData === "object" && "error" in halData) ||
    (miData && typeof miData === "object" && "error" in miData)
  ) {
    throw new Error("Metrics computation contained errors");
  }

  return {
    cyclomaticComplexity: ccData,
    halsteadMetrics: halData,
    maintainabilityIndex: miData,
  };
}

/**
 * Attempt to run Black on the given file to fix formatting.
 * If it fails, we throw an error so we skip the solution.
 */
async function runBlack(filePath: string): Promise<void> {
  await execAsync(`black --quiet ${filePath}`);
}

/**
 * Tries to compute complexity metrics on sanitized code.
 * If Radon fails, run Black and try again.
 * If that fails, return null (skip).
 */
async function computeComplexityMetrics(
  code: string
): Promise<MetricsResult | null> {
  const sanitizedCode = basicSanitize(code);
  const tempFile = path.join(__dirname, "temp_pre.py");
  fs.writeFileSync(tempFile, sanitizedCode, "utf-8");

  try {
    // 1) First attempt with Radon
    const metrics = await runRadonOnFile(tempFile);
    fs.unlinkSync(tempFile);
    return metrics;
  } catch (firstErr) {
    // 2) Try Black, then Radon again
    try {
      await runBlack(tempFile);
      const metrics = await runRadonOnFile(tempFile);
      fs.unlinkSync(tempFile);
      return metrics;
    } catch (errSecond) {
      fs.unlinkSync(tempFile);
      return null;
    }
  }
}

/**
 * Analyzes the Python code using AST to identify algorithmic strategies
 */
async function identifyAlgorithmicStrategies(code: string): Promise<string[]> {
  const tempFile = path.join(__dirname, "temp_ast.py");
  const astAnalyzerFile = path.join(__dirname, "ast_analyzer.py");

  fs.writeFileSync(tempFile, code, "utf-8");

  try {
    const { stdout } = await execAsync(
      `python3 ${astAnalyzerFile} ${tempFile}`
    );
    const strategies = JSON.parse(stdout);

    // Clean up
    fs.unlinkSync(tempFile);

    return strategies;
  } catch (error) {
    console.log("Error in AST analysis:", error);
    // Clean up on error
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);

    return ["Unknown"];
  }
}

async function processSolutions() {
  try {
    const inputPath = path.join(__dirname, "solutions.json");
    const outputPath = "/data/solutions_with_metrics.json";

    const fileContent = fs.readFileSync(inputPath, "utf-8");
    const solutions: Solution[] = JSON.parse(fileContent);

    const validSolutions: Solution[] = [];

    for (const sol of solutions) {
      // 1. Remove part2, as it's no longer used
      delete sol.part2;

      // 2. Check if part1 is valid
      if (!sol.part1 || sol.part1.trim() === "") {
        console.warn(`No valid code for ${sol.year} Day ${sol.day}, skipping.`);
        continue;
      }

      // 3. Aggressive pre-filter: skip if code is likely non-Python
      if (isLikelyNonPython(sol.part1)) {
        console.warn(
          `Likely non-Python code for ${sol.year} Day ${sol.day}, skipping.`
        );
        continue;
      }

      // 4. Attempt to compute metrics
      const metrics = await computeComplexityMetrics(sol.part1);
      if (!metrics) {
        console.warn(
          `Couldn't compute metrics for ${sol.year} Day ${sol.day}, skipping.`
        );
        continue;
      }

      // 5. Identify algorithmic strategies
      let strategies: string[] = [];
      try {
        strategies = await identifyAlgorithmicStrategies(sol.part1);
      } catch (astError) {
        console.error(
          `AST error for ${sol.year} Day ${sol.day}, defaulting to ["None"].`
        );
        strategies = ["None"];
      }

      // If the code is "SyntaxError" from the analyzer, skip
      if (strategies.includes("SyntaxError")) {
        console.warn(
          `SyntaxError in AST parse for ${sol.year} Day ${sol.day}, skipping.`
        );
        continue;
      }

      // Everything is good, add to final solutions
      sol.cyclomaticComplexity = metrics.cyclomaticComplexity;
      sol.halsteadMetrics = metrics.halsteadMetrics;
      sol.maintainabilityIndex = metrics.maintainabilityIndex;
      sol.algorithmicStrategies = strategies;

      validSolutions.push(sol);
      console.log(`Processed ${sol.year} Day ${sol.day} by ${sol.author}`);
    }

    // Sort final solutions
    validSolutions.sort(
      (a, b) => a.year - b.year || a.day - b.day || b.score - a.score
    );

    fs.writeFileSync(
      outputPath,
      JSON.stringify(validSolutions, null, 2),
      "utf-8"
    );
    console.log(`Enriched data saved to ${outputPath}`);
    console.log(
      `Total solutions processed: ${validSolutions.length} out of ${solutions.length}`
    );
  } catch (error) {
    console.error("Error processing solutions:", error);
    process.exit(1);
  }
}

/**
 * Main function to kick off the processing
 */
async function main() {
  console.log("Starting to process solutions...");
  try {
    await processSolutions();
    console.log("Processing completed successfully!");
  } catch (error) {
    console.error("Processing failed:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
