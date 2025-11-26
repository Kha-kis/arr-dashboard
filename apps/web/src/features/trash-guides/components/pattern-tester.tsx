/**
 * Pattern Tester Component
 *
 * Test regex patterns against sample text to see if they match
 * - Live pattern validation
 * - Sample text input
 * - Match highlighting
 * - Common test cases
 */

"use client";

import { useState, useMemo } from "react";
import { Alert, AlertDescription, Button, Input } from "../../../components/ui";
import { CheckCircle, XCircle, Info, AlertTriangle, AlertCircle } from "lucide-react";

interface PatternTesterProps {
	pattern: string;
	negate?: boolean;
	onClose?: () => void;
}

// Common test cases for different pattern types
const COMMON_TEST_CASES = {
	resolution: [
		"Movie.Name.2023.2160p.WEB-DL.DDP5.1.H.265",
		"Movie.Name.2023.1080p.BluRay.x264",
		"Movie.Name.2023.720p.HDTV.x264",
		"Movie.Name.2023.4320p.UHD.BluRay.x265",
	],
	hdr: [
		"Movie.Name.2023.2160p.UHD.BluRay.DV.HDR10Plus.x265",
		"Movie.Name.2023.2160p.WEB-DL.HDR10.H.265",
		"Movie.Name.2023.2160p.BluRay.Dolby.Vision.HEVC",
		"Movie.Name.2023.2160p.WEB-DL.SDR.x265",
	],
	audio: [
		"Movie.Name.2023.1080p.BluRay.DTS-HD.MA.7.1.x264",
		"Movie.Name.2023.1080p.BluRay.TrueHD.Atmos.7.1.x264",
		"Movie.Name.2023.1080p.WEB-DL.DD5.1.x264",
		"Movie.Name.2023.1080p.BluRay.FLAC.2.0.x264",
	],
	source: [
		"Movie.Name.2023.1080p.BluRay.x264",
		"Movie.Name.2023.1080p.WEB-DL.x264",
		"Movie.Name.2023.1080p.HDTV.x264",
		"Movie.Name.2023.1080p.REMUX.x264",
	],
	releaseGroup: [
		"Movie.Name.2023.1080p.BluRay.x264-FraMeSToR",
		"Movie.Name.2023.1080p.WEB-DL.x264-NTb",
		"Movie.Name.2023.1080p.BluRay.x264-SPARKS",
		"Movie.Name.2023.1080p.WEB-DL.x264-GGEZ",
	],
};

export function PatternTester({
	pattern,
	negate = false,
	onClose,
}: PatternTesterProps) {
	const [testText, setTestText] = useState("");
	const [selectedPreset, setSelectedPreset] = useState<string | null>(null);

	// Test if pattern matches the text
	const testResult = useMemo(() => {
		if (!pattern || !testText) {
			return {
				matches: false,
				valid: true,
				error: null,
				matchGroups: [],
			};
		}

		try {
			const regex = new RegExp(pattern, "i"); // Case insensitive
			const matches = regex.test(testText);
			const exec = regex.exec(testText);

			return {
				matches: negate ? !matches : matches,
				valid: true,
				error: null,
				matchGroups: exec ? Array.from(exec) : [],
			};
		} catch (error) {
			return {
				matches: false,
				valid: false,
				error: error instanceof Error ? error.message : "Invalid regex",
				matchGroups: [],
			};
		}
	}, [pattern, testText, negate]);

	// Load preset test cases
	const loadPreset = (preset: string, cases: string[]) => {
		setSelectedPreset(preset);
		setTestText(cases.join("\n"));
	};

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<h4 className="text-sm font-medium text-fg">Pattern Tester</h4>
				{onClose && (
					<Button size="sm" variant="ghost" onClick={onClose}>
						Close
					</Button>
				)}
			</div>

			{/* Pattern Display */}
			<div className="rounded bg-bg-subtle/40 p-3 border border-border/30">
				<div className="flex items-center gap-2 mb-2">
					<span className="text-xs font-medium text-fg-muted">Pattern:</span>
					{negate && (
						<span className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-300">
							Negated (must NOT match)
						</span>
					)}
				</div>
				<code className="text-sm font-mono text-fg break-all">{pattern}</code>

				{!testResult.valid && (
					<Alert variant="danger" className="mt-3">
						<AlertTriangle className="h-4 w-4" />
						<AlertDescription className="text-xs">
							{testResult.error}
						</AlertDescription>
					</Alert>
				)}
			</div>

			{/* Quick Presets */}
			<div className="space-y-2">
				<label className="text-xs font-medium text-fg-muted">Quick Test Cases:</label>
				<div className="flex flex-wrap gap-2">
					{Object.entries(COMMON_TEST_CASES).map(([key, cases]) => (
						<Button
							key={key}
							size="sm"
							variant={selectedPreset === key ? "primary" : "secondary"}
							onClick={() => loadPreset(key, cases)}
						>
							{key.charAt(0).toUpperCase() + key.slice(1)}
						</Button>
					))}
					<Button
						size="sm"
						variant="secondary"
						onClick={() => {
							setSelectedPreset(null);
							setTestText("");
						}}
					>
						Clear
					</Button>
				</div>
			</div>

			{/* Test Input */}
			<div className="space-y-2">
				<label className="text-sm font-medium text-fg">
					Test Text (one per line for multiple tests)
				</label>
				<textarea
					value={testText}
					onChange={(e) => {
						setTestText(e.target.value);
						setSelectedPreset(null);
					}}
					rows={6}
					className="w-full rounded-xl border border-border bg-bg-subtle px-4 py-3 text-sm font-mono text-fg placeholder:text-fg-muted/60 transition-all duration-200 hover:border-border/80 hover:bg-bg-subtle/80 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:bg-bg-subtle/80"
					placeholder="Enter release names or file names to test..."
				/>
			</div>

			{/* Results */}
			{testText && testResult.valid && (
				<div className="space-y-3">
					<h5 className="text-sm font-medium text-fg">Results</h5>

					{testText.split("\n").filter(Boolean).map((line, index) => {
						try {
							const regex = new RegExp(pattern, "i");
							const lineMatches = regex.test(line);
							const finalMatch = negate ? !lineMatches : lineMatches;
							const exec = regex.exec(line);

							return (
								<div
									key={index}
									className={`rounded border p-3 ${
										finalMatch
											? "border-green-500/30 bg-green-500/10"
											: "border-red-500/30 bg-red-500/10"
									}`}
								>
									<div className="flex items-start gap-3">
										{finalMatch ? (
											<CheckCircle className="h-5 w-5 text-green-400 flex-shrink-0 mt-0.5" />
										) : (
											<XCircle className="h-5 w-5 text-red-400 flex-shrink-0 mt-0.5" />
										)}

										<div className="flex-1 min-w-0">
											<code className="text-xs font-mono text-fg break-all">
												{line}
											</code>

											{exec && exec.length > 1 && lineMatches && (
												<div className="mt-2 space-y-1">
													<p className="text-xs text-fg-muted">Captured groups:</p>
													{exec.slice(1).map((group, groupIndex) => (
														<div key={groupIndex} className="text-xs">
															<span className="text-fg-muted">Group {groupIndex + 1}:</span>{" "}
															<code className="text-fg">{group}</code>
														</div>
													))}
												</div>
											)}
										</div>

										<div className="text-xs font-medium flex-shrink-0">
											{finalMatch ? (
												<span className="text-green-400">Match</span>
											) : (
												<span className="text-red-400">No Match</span>
											)}
										</div>
									</div>
								</div>
							);
						} catch (error) {
							// Show error indicator for lines that failed regex execution
							console.error(`Regex execution error for line "${line}":`, error);
							return (
								<div
									key={index}
									className="rounded border border-amber-500/30 bg-amber-500/10 p-3"
								>
									<div className="flex items-start gap-3">
										<AlertCircle className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
										<div className="flex-1 min-w-0">
											<code className="text-xs font-mono text-fg break-all">
												{line}
											</code>
											<p className="text-xs text-amber-300 mt-1">
												Error testing this line - check pattern syntax
											</p>
										</div>
									</div>
								</div>
							);
						}
					})}
				</div>
			)}

			{/* Help */}
			<Alert>
				<Info className="h-4 w-4" />
				<AlertDescription className="text-xs space-y-2">
					<p>
						<strong>Tips:</strong>
					</p>
					<ul className="list-disc list-inside space-y-1 ml-2">
						<li>Patterns are case-insensitive by default</li>
						<li>Use <code className="px-1 py-0.5 rounded bg-bg-subtle/60">\b</code> for word boundaries</li>
						<li>Use <code className="px-1 py-0.5 rounded bg-bg-subtle/60">|</code> for OR (e.g., <code className="px-1 py-0.5 rounded bg-bg-subtle/60">2160p|4320p</code>)</li>
						<li>Use <code className="px-1 py-0.5 rounded bg-bg-subtle/60">.*</code> to match any characters</li>
						<li>Use <code className="px-1 py-0.5 rounded bg-bg-subtle/60">[...]</code> for character sets (e.g., <code className="px-1 py-0.5 rounded bg-bg-subtle/60">[0-9]</code>)</li>
						{negate && <li className="text-amber-300"><strong>Negated mode:</strong> Pattern must NOT match for condition to pass</li>}
					</ul>
				</AlertDescription>
			</Alert>
		</div>
	);
}
