#!/usr/bin/env bun

import path from "path"
import { fileURLToPath } from "url"
import { generateText, type ModelMessage } from "ai"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const pkgDir = path.resolve(__dirname, "..")

process.chdir(pkgDir)

type Args = {
	providerIDs: string[]
	timeoutMs: number
	delayMs: number
	limit: number | undefined
	includeMini: boolean
}

function parseArgs(argv: string[]): Args {
	const providerIDs: string[] = []
	let timeoutMs = 20_000
	let delayMs = 250
	let limit: number | undefined
	let includeMini = false

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		switch (arg) {
			case "--provider":
			case "-p": {
				const value = argv[++i]
				if (!value) throw new Error("Missing value for --provider")
				providerIDs.push(value)
				break
			}
			case "--timeout-ms": {
				const value = argv[++i]
				if (!value) throw new Error("Missing value for --timeout-ms")
				timeoutMs = Number(value)
				break
			}
			case "--delay-ms": {
				const value = argv[++i]
				if (!value) throw new Error("Missing value for --delay-ms")
				delayMs = Number(value)
				break
			}
			case "--limit": {
				const value = argv[++i]
				if (!value) throw new Error("Missing value for --limit")
				limit = Number(value)
				break
			}
			case "--include-mini": {
				includeMini = true
				break
			}
			case "--help":
			case "-h": {
				printHelp()
				process.exit(0)
			}
		}
	}

	if (providerIDs.length === 0) {
		providerIDs.push("github-copilot")
	}

	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be > 0")
	if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("--delay-ms must be >= 0")
	if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) throw new Error("--limit must be > 0")

	return { providerIDs, timeoutMs, delayMs, limit, includeMini }
}

function printHelp() {
	process.stdout.write(
		[
			"Verify GitHub Copilot model support for OpenAI Responses API routing.",
			"",
			"This script runs real requests against the GitHub Copilot backend.",
			"Results can vary by account/region/feature flags.",
			"",
			"Usage:",
			"  bun run script/verify-copilot-responses.ts [options]",
			"",
			"Options:",
			"  -p, --provider <id>   Provider ID to test (repeatable). Default: github-copilot",
			"      --timeout-ms <n>  Per-model timeout (default: 20000)",
			"      --delay-ms <n>    Delay between models (default: 250)",
			"      --limit <n>       Only test the first N models per provider",
			"      --include-mini    Also test gpt-5-mini (expected to fail for some users)",
			"  -h, --help            Show help",
			"",
			"Notes:",
			"- The script forces provider.github-copilot.options.useResponsesApi=true via OPENCODE_CONFIG_CONTENT.",
			"- Ensure you're authenticated for GitHub Copilot in OpenCode before running.",
		].join("\n"),
	)
	process.stdout.write("\n")
}

function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function getGptMajor(modelID: string): number | undefined {
	const match = /^gpt-(\d+)/.exec(modelID)
	if (!match) return undefined
	return Number(match[1])
}

function buildConfigOverlayJSON(providerIDs: string[]): string {
	// Merge into any existing OPENCODE_CONFIG_CONTENT the user provided.
	const existingRaw = process.env.OPENCODE_CONFIG_CONTENT
	const existing = existingRaw ? safeJsonParse(existingRaw) : {}
	const overlay = {
		provider: Object.fromEntries(
			providerIDs.map((providerID) => [
				providerID,
				{
					options: {
						useResponsesApi: true,
					},
				},
			]),
		),
	}
	return JSON.stringify(deepMerge(existing, overlay))
}

function safeJsonParse(text: string): any {
	try {
		return JSON.parse(text)
	} catch {
		return {}
	}
}

function isPlainObject(value: any): value is Record<string, any> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function deepMerge(a: any, b: any): any {
	if (isPlainObject(a) && isPlainObject(b)) {
		const out: Record<string, any> = { ...a }
		for (const [key, value] of Object.entries(b)) {
			out[key] = deepMerge(out[key], value)
		}
		return out
	}
	return b
}

async function probeModel(input: {
	providerID: string
	modelID: string
	timeoutMs: number
}): Promise<{ ok: boolean; error?: string }> {
	const messages: ModelMessage[] = [
		{
			role: "user",
			content: "ping",
		},
	]

	try {
		const { Provider } = await import("../src/provider/provider")
		const model = await Provider.getModel(input.providerID, input.modelID)
		const language = await Provider.getLanguage(model)

		// GitHub Copilot Responses API currently requires max_output_tokens >= 16.
		await generateText({
			model: language,
			messages,
			maxOutputTokens: 16,
			abortSignal: AbortSignal.timeout(input.timeoutMs),
		})

		return { ok: true }
	} catch (e: any) {
		const message = e?.message ? String(e.message) : String(e)
		return { ok: false, error: message }
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2))

	// IMPORTANT: Provider/Config uses Instance.state caching. Ensure config is set BEFORE importing Provider.
	process.env.OPENCODE_CONFIG_CONTENT = buildConfigOverlayJSON(args.providerIDs)

	const { Instance } = await import("../src/project/instance")
	const { Provider } = await import("../src/provider/provider")

	process.stdout.write("# Copilot Responses API Probe\n")
	process.stdout.write(`Providers: ${args.providerIDs.join(", ")}\n`)
	process.stdout.write(`Timeout: ${args.timeoutMs}ms, Delay: ${args.delayMs}ms\n\n`)

	let hadFailure = false
	await Instance.provide({
		directory: process.cwd(),
		async fn() {
			for (const providerID of args.providerIDs) {
				const provider = await Provider.getProvider(providerID)
				if (!provider) {
					process.stdout.write(`\n## ${providerID}\n`)
					process.stdout.write("Provider not found in current config / environment.\n")
					continue
				}

				const modelIDs = Object.keys(provider.models)
					.filter((id) => {
						const major = getGptMajor(id)
						if (major === undefined || major < 5) return false
						if (!args.includeMini && id === "gpt-5-mini") return false
						return true
					})
					.sort((a, b) => a.localeCompare(b))

				const selected = args.limit ? modelIDs.slice(0, args.limit) : modelIDs

				process.stdout.write(`\n## ${providerID}\n`)
				process.stdout.write(`Testing ${selected.length} model(s)\n`)

				let okCount = 0
				let failCount = 0

				for (const modelID of selected) {
					process.stdout.write(`- ${providerID}/${modelID}: `)
					const result = await probeModel({
						providerID,
						modelID,
						timeoutMs: args.timeoutMs,
					})

					if (result.ok) {
						okCount++
						process.stdout.write("OK\n")
					} else {
						failCount++
						hadFailure = true
						process.stdout.write(`FAIL (${result.error})\n`)
					}

					if (args.delayMs > 0) {
						await sleep(args.delayMs)
					}
				}

				process.stdout.write(`Summary: ${okCount} OK, ${failCount} FAIL\n`)
			}
		},
	})

	// Important: OpenCode may start background servers/plugins that keep the event loop alive.
	// Dispose all instance state and exit explicitly.
	await Instance.disposeAll()
	process.exit(hadFailure ? 1 : 0)
}

await main()
