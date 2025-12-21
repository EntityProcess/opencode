#!/usr/bin/env bun

/**
 * Compare GitHub Copilot GPT-5.2 outputs between:
 * - Chat Completions API (no reasoning)
 * - Responses API with reasoningEffort: "high"
 *
 * Goal: Prove that Chat Completions API does not perform reasoning
 * while Responses API with high reasoning effort produces higher quality responses.
 *
 * This script makes DIRECT API calls to both endpoints to bypass the SDK's
 * automatic routing based on model ID.
 */

import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, "../..")
const pkgDir = path.resolve(repoRoot, "packages/opencode")

process.chdir(pkgDir)

type Args = {
	providerID: string
	modelID: string
	timeoutMs: number
}

function parseArgs(argv: string[]): Args {
	let providerID = "github-copilot"
	let modelID = "gpt-5.2"
	let timeoutMs = 120_000

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		switch (arg) {
			case "--provider":
			case "-p": {
				const value = argv[++i]
				if (!value) throw new Error("Missing value for --provider")
				providerID = value
				break
			}
			case "--model":
			case "-m": {
				const value = argv[++i]
				if (!value) throw new Error("Missing value for --model")
				modelID = value
				break
			}
			case "--timeout-ms": {
				const value = argv[++i]
				if (!value) throw new Error("Missing value for --timeout-ms")
				timeoutMs = Number(value)
				break
			}
			case "--help":
			case "-h": {
				printHelp()
				process.exit(0)
			}
		}
	}

	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be > 0")

	return { providerID, modelID, timeoutMs }
}

function printHelp() {
	process.stdout.write(
		[
			"Compare GitHub Copilot reasoning between Chat Completions API and Responses API.",
			"",
			"This script tests whether Responses API with high reasoning effort produces",
			"better outputs than Chat Completions API (which has no reasoning support).",
			"",
			"Usage:",
			"  bun run fork/copilot-reasoning/compare-copilot-reasoning.ts [options]",
			"",
			"Options:",
			"  -p, --provider <id>   Provider ID (default: github-copilot)",
			"  -m, --model <id>      Model ID (default: gpt-5.2)",
			"      --timeout-ms <n>  Per-request timeout (default: 120000)",
			"  -h, --help            Show help",
			"",
		].join("\n"),
	)
	process.stdout.write("\n")
}

// Test prompts that benefit from reasoning
const TEST_PROMPTS: { name: string; prompt: string; expectedBehavior: string }[] = [
	{
		name: "Math Reasoning",
		prompt: `Solve this step by step: A farmer has 17 sheep. All but 9 run away. How many sheep does the farmer have left?

Important: Show your reasoning process clearly.`,
		expectedBehavior: "Should show reasoning steps and arrive at 9 (a common trick question)",
	},
	{
		name: "Logic Puzzle",
		prompt: `There are three boxes: one contains only apples, one contains only oranges, and one contains both apples and oranges. The boxes are labeled incorrectly so that no label is correct. You can pick one fruit from one box. How can you determine the contents of all boxes?

Think through this step by step and explain your reasoning.`,
		expectedBehavior: "Should explain the logical deduction process",
	},
	{
		name: "Code Analysis",
		prompt: `Analyze this code and explain what it does, including any bugs:

function mystery(n) {
  if (n <= 0) return 1;
  return n * mystery(n - 2);
}
console.log(mystery(5));

What is the output? Is there a bug? Explain your reasoning.`,
		expectedBehavior: "Should analyze recursively and identify potential infinite recursion for even numbers",
	},
]

interface TestResult {
	name: string
	api: "chat" | "responses"
	reasoningEffort?: string
	success: boolean
	response?: string
	reasoningTokens?: number
	inputTokens?: number
	outputTokens?: number
	totalTokens?: number
	error?: string
	durationMs: number
}

// Get auth token by refreshing from GitHub Copilot API
async function getAuthToken(providerID: string): Promise<string> {
	const { Auth } = await import("../../packages/opencode/src/auth")

	const auth = await Auth.get(providerID)
	if (!auth) {
		throw new Error(`No authentication found for provider: ${providerID}. Run 'opencode auth' first.`)
	}

	if (auth.type !== "oauth") {
		throw new Error(`Expected OAuth auth for ${providerID}, got ${auth.type}`)
	}

	// Check if token is still valid
	if (auth.access && auth.expires > Date.now()) {
		return auth.access
	}

	// Token expired, need to refresh
	process.stdout.write("Token expired, refreshing...\n")

	const COPILOT_API_KEY_URL = "https://api.github.com/copilot_internal/v2/token"
	const HEADERS = {
		"User-Agent": "GitHubCopilotChat/0.32.4",
		"Editor-Version": "vscode/1.105.1",
		"Editor-Plugin-Version": "copilot-chat/0.32.4",
		"Copilot-Integration-Id": "vscode-chat",
		Accept: "application/json",
	}

	const response = await fetch(COPILOT_API_KEY_URL, {
		headers: {
			...HEADERS,
			Authorization: `Bearer ${auth.refresh}`,
		},
	})

	if (!response.ok) {
		const text = await response.text()
		throw new Error(`Token refresh failed: ${response.status} - ${text}`)
	}

	const tokenData = (await response.json()) as { token: string; expires_at: number }

	// Save the new token
	await Auth.set(providerID, {
		type: "oauth",
		refresh: auth.refresh,
		access: tokenData.token,
		expires: tokenData.expires_at * 1000,
	})

	process.stdout.write("Token refreshed successfully.\n")
	return tokenData.token
}

// Get base URL for the provider
function getBaseUrl(providerID: string): string {
	if (providerID === "github-copilot" || providerID === "github-copilot-enterprise") {
		return "https://api.githubcopilot.com"
	}
	throw new Error(`Unknown provider: ${providerID}`)
}

// Common headers for GitHub Copilot requests
const COPILOT_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.32.4",
	"Editor-Version": "vscode/1.105.1",
	"Editor-Plugin-Version": "copilot-chat/0.32.4",
	"Copilot-Integration-Id": "vscode-chat",
	"Openai-Intent": "conversation-edits",
}

// Direct Chat Completions API call
async function callChatCompletionsApi(input: {
	baseUrl: string
	token: string
	modelID: string
	prompt: string
	timeoutMs: number
}): Promise<{
	success: boolean
	response?: string
	inputTokens?: number
	outputTokens?: number
	reasoningTokens?: number
	error?: string
}> {
	const url = `${input.baseUrl}/chat/completions`

	const body = {
		model: input.modelID,
		messages: [{ role: "user", content: input.prompt }],
		max_tokens: 4096,
	}

	const response = await fetch(url, {
		method: "POST",
		headers: {
			...COPILOT_HEADERS,
			Authorization: `Bearer ${input.token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(input.timeoutMs),
	})

	if (!response.ok) {
		const text = await response.text()
		return { success: false, error: `HTTP ${response.status}: ${text}` }
	}

	const data = await response.json() as any

	return {
		success: true,
		response: data.choices?.[0]?.message?.content ?? "",
		inputTokens: data.usage?.prompt_tokens,
		outputTokens: data.usage?.completion_tokens,
		reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
	}
}

// Direct Responses API call
async function callResponsesApi(input: {
	baseUrl: string
	token: string
	modelID: string
	prompt: string
	reasoningEffort: string
	timeoutMs: number
}): Promise<{
	success: boolean
	response?: string
	inputTokens?: number
	outputTokens?: number
	reasoningTokens?: number
	error?: string
}> {
	const url = `${input.baseUrl}/responses`

	const body: Record<string, any> = {
		model: input.modelID,
		input: [{ role: "user", content: input.prompt }],
		max_output_tokens: 4096,
		reasoning: {
			effort: input.reasoningEffort,
			summary: "auto",
		},
		include: ["reasoning.encrypted_content"],
	}

	const response = await fetch(url, {
		method: "POST",
		headers: {
			...COPILOT_HEADERS,
			Authorization: `Bearer ${input.token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(input.timeoutMs),
	})

	if (!response.ok) {
		const text = await response.text()
		return { success: false, error: `HTTP ${response.status}: ${text}` }
	}

	const data = await response.json() as any

	// Extract text from response output
	let responseText = ""
	for (const item of data.output ?? []) {
		if (item.type === "message") {
			for (const content of item.content ?? []) {
				if (content.type === "output_text") {
					responseText += content.text
				}
			}
		}
	}

	return {
		success: true,
		response: responseText,
		inputTokens: data.usage?.input_tokens,
		outputTokens: data.usage?.output_tokens,
		reasoningTokens: data.usage?.output_tokens_details?.reasoning_tokens,
	}
}

async function runChatTest(input: {
	baseUrl: string
	token: string
	modelID: string
	prompt: string
	timeoutMs: number
}): Promise<TestResult> {
	const startTime = Date.now()

	try {
		const result = await callChatCompletionsApi(input)
		const durationMs = Date.now() - startTime

		if (!result.success) {
			return {
				name: "",
				api: "chat",
				success: false,
				error: result.error,
				durationMs,
			}
		}

		return {
			name: "",
			api: "chat",
			success: true,
			response: result.response,
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
			reasoningTokens: result.reasoningTokens,
			totalTokens: (result.inputTokens ?? 0) + (result.outputTokens ?? 0),
			durationMs,
		}
	} catch (e: any) {
		const durationMs = Date.now() - startTime
		return {
			name: "",
			api: "chat",
			success: false,
			error: e?.message ?? String(e),
			durationMs,
		}
	}
}

async function runResponsesTest(input: {
	baseUrl: string
	token: string
	modelID: string
	prompt: string
	reasoningEffort: string
	timeoutMs: number
}): Promise<TestResult> {
	const startTime = Date.now()

	try {
		const result = await callResponsesApi(input)
		const durationMs = Date.now() - startTime

		if (!result.success) {
			return {
				name: "",
				api: "responses",
				reasoningEffort: input.reasoningEffort,
				success: false,
				error: result.error,
				durationMs,
			}
		}

		return {
			name: "",
			api: "responses",
			reasoningEffort: input.reasoningEffort,
			success: true,
			response: result.response,
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
			reasoningTokens: result.reasoningTokens,
			totalTokens: (result.inputTokens ?? 0) + (result.outputTokens ?? 0),
			durationMs,
		}
	} catch (e: any) {
		const durationMs = Date.now() - startTime
		return {
			name: "",
			api: "responses",
			reasoningEffort: input.reasoningEffort,
			success: false,
			error: e?.message ?? String(e),
			durationMs,
		}
	}
}

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text
	return text.slice(0, maxLength) + "..."
}

async function main() {
	const args = parseArgs(process.argv.slice(2))

	process.stdout.write("=".repeat(80) + "\n")
	process.stdout.write("GitHub Copilot Reasoning Comparison\n")
	process.stdout.write("=".repeat(80) + "\n")
	process.stdout.write(`Provider: ${args.providerID}\n`)
	process.stdout.write(`Model: ${args.modelID}\n`)
	process.stdout.write(`Timeout: ${args.timeoutMs}ms\n`)
	process.stdout.write("=".repeat(80) + "\n\n")

	const { Instance } = await import("../../packages/opencode/src/project/instance")

	const allResults: TestResult[] = []

	await Instance.provide({
		directory: process.cwd(),
		async fn() {
			// Get auth token
			process.stdout.write("Fetching authentication token...\n")
			let token: string
			try {
				token = await getAuthToken(args.providerID)
				process.stdout.write("Authentication successful.\n\n")
			} catch (e: any) {
				process.stdout.write(`ERROR: ${e.message}\n`)
				process.exit(1)
			}

			const baseUrl = getBaseUrl(args.providerID)

			for (const testCase of TEST_PROMPTS) {
				process.stdout.write("\n" + "-".repeat(80) + "\n")
				process.stdout.write(`TEST: ${testCase.name}\n`)
				process.stdout.write("-".repeat(80) + "\n")
				process.stdout.write(`Expected: ${testCase.expectedBehavior}\n\n`)

				// Test 1: Chat Completions API (no reasoning)
				process.stdout.write(">>> Testing Chat Completions API (no reasoning support)...\n")
				const chatResult = await runChatTest({
					baseUrl,
					token,
					modelID: args.modelID,
					prompt: testCase.prompt,
					timeoutMs: args.timeoutMs,
				})
				chatResult.name = testCase.name

				if (chatResult.success) {
					process.stdout.write(`    Endpoint: ${baseUrl}/chat/completions\n`)
					process.stdout.write(`    Duration: ${chatResult.durationMs}ms\n`)
					process.stdout.write(`    Input Tokens: ${chatResult.inputTokens ?? "N/A"}\n`)
					process.stdout.write(`    Output Tokens: ${chatResult.outputTokens ?? "N/A"}\n`)
					process.stdout.write(`    Reasoning Tokens: ${chatResult.reasoningTokens ?? "N/A (not supported)"}\n`)
					process.stdout.write(`    Response:\n`)
					process.stdout.write("    " + truncateText(chatResult.response ?? "", 500).replace(/\n/g, "\n    ") + "\n")
				} else {
					process.stdout.write(`    FAILED: ${chatResult.error}\n`)
				}
				allResults.push(chatResult)

				// Test 2: Responses API with low reasoning effort
				process.stdout.write("\n>>> Testing Responses API (reasoningEffort: low)...\n")
				const responsesLowResult = await runResponsesTest({
					baseUrl,
					token,
					modelID: args.modelID,
					prompt: testCase.prompt,
					reasoningEffort: "low",
					timeoutMs: args.timeoutMs,
				})
				responsesLowResult.name = testCase.name

				if (responsesLowResult.success) {
					process.stdout.write(`    Endpoint: ${baseUrl}/responses\n`)
					process.stdout.write(`    Duration: ${responsesLowResult.durationMs}ms\n`)
					process.stdout.write(`    Input Tokens: ${responsesLowResult.inputTokens ?? "N/A"}\n`)
					process.stdout.write(`    Output Tokens: ${responsesLowResult.outputTokens ?? "N/A"}\n`)
					process.stdout.write(`    Reasoning Tokens: ${responsesLowResult.reasoningTokens ?? "N/A"}\n`)
					process.stdout.write(`    Response:\n`)
					process.stdout.write("    " + truncateText(responsesLowResult.response ?? "", 500).replace(/\n/g, "\n    ") + "\n")
				} else {
					process.stdout.write(`    FAILED: ${responsesLowResult.error}\n`)
				}
				allResults.push(responsesLowResult)

				// Test 3: Responses API with medium reasoning effort
				process.stdout.write("\n>>> Testing Responses API (reasoningEffort: medium)...\n")
				const responsesMediumResult = await runResponsesTest({
					baseUrl,
					token,
					modelID: args.modelID,
					prompt: testCase.prompt,
					reasoningEffort: "medium",
					timeoutMs: args.timeoutMs,
				})
				responsesMediumResult.name = testCase.name

				if (responsesMediumResult.success) {
					process.stdout.write(`    Endpoint: ${baseUrl}/responses\n`)
					process.stdout.write(`    Duration: ${responsesMediumResult.durationMs}ms\n`)
					process.stdout.write(`    Input Tokens: ${responsesMediumResult.inputTokens ?? "N/A"}\n`)
					process.stdout.write(`    Output Tokens: ${responsesMediumResult.outputTokens ?? "N/A"}\n`)
					process.stdout.write(`    Reasoning Tokens: ${responsesMediumResult.reasoningTokens ?? "N/A"}\n`)
					process.stdout.write(`    Response:\n`)
					process.stdout.write("    " + truncateText(responsesMediumResult.response ?? "", 500).replace(/\n/g, "\n    ") + "\n")
				} else {
					process.stdout.write(`    FAILED: ${responsesMediumResult.error}\n`)
				}
				allResults.push(responsesMediumResult)

				// Test 4: Responses API with high reasoning effort
				process.stdout.write("\n>>> Testing Responses API (reasoningEffort: high)...\n")
				const responsesHighResult = await runResponsesTest({
					baseUrl,
					token,
					modelID: args.modelID,
					prompt: testCase.prompt,
					reasoningEffort: "high",
					timeoutMs: args.timeoutMs,
				})
				responsesHighResult.name = testCase.name

				if (responsesHighResult.success) {
					process.stdout.write(`    Endpoint: ${baseUrl}/responses\n`)
					process.stdout.write(`    Duration: ${responsesHighResult.durationMs}ms\n`)
					process.stdout.write(`    Input Tokens: ${responsesHighResult.inputTokens ?? "N/A"}\n`)
					process.stdout.write(`    Output Tokens: ${responsesHighResult.outputTokens ?? "N/A"}\n`)
					process.stdout.write(`    Reasoning Tokens: ${responsesHighResult.reasoningTokens ?? "N/A"}\n`)
					process.stdout.write(`    Response:\n`)
					process.stdout.write("    " + truncateText(responsesHighResult.response ?? "", 500).replace(/\n/g, "\n    ") + "\n")
				} else {
					process.stdout.write(`    FAILED: ${responsesHighResult.error}\n`)
				}
				allResults.push(responsesHighResult)
			}
		},
	})

	// Print summary
	process.stdout.write("\n" + "=".repeat(80) + "\n")
	process.stdout.write("SUMMARY\n")
	process.stdout.write("=".repeat(80) + "\n\n")

	process.stdout.write("| Test            | API       | Reasoning Effort | Reasoning Tokens | Duration   |\n")
	process.stdout.write("|-----------------|-----------|------------------|------------------|------------|\n")

	for (const result of allResults) {
		const reasoningTokens = result.reasoningTokens !== undefined ? String(result.reasoningTokens) : "N/A"
		const status = result.success ? "" : " (FAILED)"
		process.stdout.write(
			`| ${result.name.slice(0, 15).padEnd(15)} | ${result.api.padEnd(9)} | ${(result.reasoningEffort ?? "none").padEnd(16)} | ${reasoningTokens.padEnd(16)} | ${String(result.durationMs).padEnd(6)}ms${status} |\n`,
		)
	}

	process.stdout.write("\n")
	process.stdout.write("=".repeat(80) + "\n")
	process.stdout.write("KEY FINDINGS\n")
	process.stdout.write("=".repeat(80) + "\n\n")

	// Analyze results
	const chatResults = allResults.filter((r) => r.api === "chat" && r.success)
	const responsesLowResults = allResults.filter((r) => r.api === "responses" && r.reasoningEffort === "low" && r.success)
	const responsesMediumResults = allResults.filter((r) => r.api === "responses" && r.reasoningEffort === "medium" && r.success)
	const responsesHighResults = allResults.filter((r) => r.api === "responses" && r.reasoningEffort === "high" && r.success)

	const chatHasReasoning = chatResults.some((r) => r.reasoningTokens && r.reasoningTokens > 0)
	const responsesLowHasReasoning = responsesLowResults.some((r) => r.reasoningTokens && r.reasoningTokens > 0)
	const responsesMediumHasReasoning = responsesMediumResults.some((r) => r.reasoningTokens && r.reasoningTokens > 0)
	const responsesHighHasReasoning = responsesHighResults.some((r) => r.reasoningTokens && r.reasoningTokens > 0)

	// Calculate totals
	const chatTotalReasoningTokens = chatResults.reduce((sum, r) => sum + (r.reasoningTokens ?? 0), 0)
	const lowTotalReasoningTokens = responsesLowResults.reduce((sum, r) => sum + (r.reasoningTokens ?? 0), 0)
	const mediumTotalReasoningTokens = responsesMediumResults.reduce((sum, r) => sum + (r.reasoningTokens ?? 0), 0)
	const highTotalReasoningTokens = responsesHighResults.reduce((sum, r) => sum + (r.reasoningTokens ?? 0), 0)

	// Calculate average durations
	const avgChatDuration = chatResults.length > 0
		? chatResults.reduce((sum, r) => sum + r.durationMs, 0) / chatResults.length
		: 0
	const avgLowDuration = responsesLowResults.length > 0
		? responsesLowResults.reduce((sum, r) => sum + r.durationMs, 0) / responsesLowResults.length
		: 0
	const avgMediumDuration = responsesMediumResults.length > 0
		? responsesMediumResults.reduce((sum, r) => sum + r.durationMs, 0) / responsesMediumResults.length
		: 0
	const avgHighDuration = responsesHighResults.length > 0
		? responsesHighResults.reduce((sum, r) => sum + r.durationMs, 0) / responsesHighResults.length
		: 0

	process.stdout.write("1. CHAT COMPLETIONS API (/chat/completions):\n")
	process.stdout.write(`   - Total reasoning tokens: ${chatTotalReasoningTokens}\n`)
	process.stdout.write(`   - Avg duration: ${(avgChatDuration / 1000).toFixed(2)}s\n`)
	process.stdout.write(`   - Has reasoning capability: ${chatHasReasoning ? "YES" : "NO"}\n`)
	process.stdout.write("\n")

	process.stdout.write("2. RESPONSES API with LOW effort (/responses, effort=low):\n")
	process.stdout.write(`   - Total reasoning tokens: ${lowTotalReasoningTokens}\n`)
	process.stdout.write(`   - Avg duration: ${(avgLowDuration / 1000).toFixed(2)}s\n`)
	process.stdout.write(`   - Has reasoning capability: ${responsesLowHasReasoning ? "YES" : "NO"}\n`)
	process.stdout.write("\n")

	process.stdout.write("3. RESPONSES API with MEDIUM effort (/responses, effort=medium):\n")
	process.stdout.write(`   - Total reasoning tokens: ${mediumTotalReasoningTokens}\n`)
	process.stdout.write(`   - Avg duration: ${(avgMediumDuration / 1000).toFixed(2)}s\n`)
	process.stdout.write(`   - Has reasoning capability: ${responsesMediumHasReasoning ? "YES" : "NO"}\n`)
	process.stdout.write("\n")

	process.stdout.write("4. RESPONSES API with HIGH effort (/responses, effort=high):\n")
	process.stdout.write(`   - Total reasoning tokens: ${highTotalReasoningTokens}\n`)
	process.stdout.write(`   - Avg duration: ${(avgHighDuration / 1000).toFixed(2)}s\n`)
	process.stdout.write(`   - Has reasoning capability: ${responsesHighHasReasoning ? "YES" : "NO"}\n`)
	process.stdout.write("\n")

	process.stdout.write("-".repeat(80) + "\n")
	process.stdout.write("CONCLUSION:\n")
	process.stdout.write("-".repeat(80) + "\n")

	// Duration comparison to detect hidden reasoning
	process.stdout.write("\n>>> DURATION ANALYSIS (to detect hidden reasoning):\n")
	process.stdout.write(`    Chat Completions:    ${(avgChatDuration / 1000).toFixed(2)}s avg\n`)
	process.stdout.write(`    Responses (low):     ${(avgLowDuration / 1000).toFixed(2)}s avg\n`)
	process.stdout.write(`    Responses (medium):  ${(avgMediumDuration / 1000).toFixed(2)}s avg\n`)
	process.stdout.write(`    Responses (high):    ${(avgHighDuration / 1000).toFixed(2)}s avg\n`)

	// Check if chat duration is closer to medium than to low
	const chatToLowDiff = Math.abs(avgChatDuration - avgLowDuration)
	const chatToMediumDiff = Math.abs(avgChatDuration - avgMediumDuration)
	const chatToHighDiff = Math.abs(avgChatDuration - avgHighDuration)

	process.stdout.write("\n")
	if (avgChatDuration > avgLowDuration * 1.1) {
		process.stdout.write("    OBSERVATION: Chat is SLOWER than low reasoning effort!\n")
		if (chatToMediumDiff < chatToLowDiff && chatToMediumDiff < chatToHighDiff) {
			process.stdout.write("    >>> Chat duration is closest to MEDIUM effort.\n")
			process.stdout.write("    >>> This suggests Chat Completions may use MEDIUM reasoning internally.\n")
		} else if (chatToHighDiff < chatToLowDiff) {
			process.stdout.write("    >>> Chat duration is closer to HIGH effort than LOW.\n")
			process.stdout.write("    >>> This suggests Chat Completions may use significant reasoning internally.\n")
		}
	}

	process.stdout.write("\n>>> REASONING TOKEN ANALYSIS:\n")
	if (!chatHasReasoning && (responsesLowHasReasoning || responsesMediumHasReasoning || responsesHighHasReasoning)) {
		process.stdout.write("    Chat Completions API does NOT report reasoning tokens.\n")
		process.stdout.write("    Responses API DOES report reasoning tokens when enabled.\n")
		process.stdout.write(`\n    Reasoning tokens by effort level:\n`)
		process.stdout.write(`      Low:    ${lowTotalReasoningTokens}\n`)
		process.stdout.write(`      Medium: ${mediumTotalReasoningTokens}\n`)
		process.stdout.write(`      High:   ${highTotalReasoningTokens}\n`)
	} else if (chatHasReasoning) {
		process.stdout.write("    UNEXPECTED: Chat Completions API shows reasoning tokens!\n")
	} else {
		process.stdout.write("    Neither API reports reasoning tokens in usage statistics.\n")
	}

	process.stdout.write("\n")
	await Instance.disposeAll()
	process.exit(0)
}

await main()
