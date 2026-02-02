"use client";

import { useState, useCallback } from "react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "../../../components/ui/dialog";
import { Button } from "../../../components/ui";
import { PremiumTabs } from "../../../components/layout/premium-components";
import {
	Plus,
	FileJson,
	Server,
	Loader2,
	Check,
	AlertCircle,
	Upload,
} from "lucide-react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import {
	useCreateUserCustomFormat,
	useImportUserCFFromJson,
	useImportUserCFFromInstance,
} from "../hooks/use-custom-formats";
import { SpecificationBuilder, type SpecificationData } from "./specification-builder";
import { apiRequest } from "../../../lib/api-client/base";

interface UserCFImportDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	defaultServiceType?: "RADARR" | "SONARR";
}

export function UserCFImportDialog({
	open,
	onOpenChange,
	defaultServiceType = "RADARR",
}: UserCFImportDialogProps) {
	const { gradient } = useThemeGradient();
	const [activeTab, setActiveTab] = useState("create");

	const tabs = [
		{ id: "create", label: "Create", icon: Plus },
		{ id: "json", label: "Paste JSON", icon: FileJson },
		{ id: "instance", label: "From Instance", icon: Server },
	];

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Add Custom Format</DialogTitle>
					<DialogDescription>
						Create a new custom format, import from JSON, or pull from a connected instance.
					</DialogDescription>
				</DialogHeader>

				<PremiumTabs
					tabs={tabs}
					activeTab={activeTab}
					onTabChange={setActiveTab}
					className="w-full"
				/>

				<div className="mt-4">
					{activeTab === "create" && (
						<CreateTab
							defaultServiceType={defaultServiceType}
							onSuccess={() => onOpenChange(false)}
							gradient={gradient}
						/>
					)}
					{activeTab === "json" && (
						<JsonImportTab
							defaultServiceType={defaultServiceType}
							onSuccess={() => onOpenChange(false)}
							gradient={gradient}
						/>
					)}
					{activeTab === "instance" && (
						<InstanceImportTab
							onSuccess={() => onOpenChange(false)}
							gradient={gradient}
						/>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

// ============================================================================
// Tab 1: Create
// ============================================================================

function CreateTab({
	defaultServiceType,
	onSuccess,
	gradient,
}: {
	defaultServiceType: "RADARR" | "SONARR";
	onSuccess: () => void;
	gradient: { from: string; fromLight: string; fromMuted: string };
}) {
	const [name, setName] = useState("");
	const [serviceType, setServiceType] = useState<"RADARR" | "SONARR">(defaultServiceType);
	const [description, setDescription] = useState("");
	const [includeInRenaming, setIncludeInRenaming] = useState(false);
	const [defaultScore, setDefaultScore] = useState(0);
	const [specifications, setSpecifications] = useState<SpecificationData[]>([]);

	const createMutation = useCreateUserCustomFormat();

	const handleSubmit = () => {
		if (!name.trim() || specifications.length === 0) return;

		createMutation.mutate(
			{
				name: name.trim(),
				serviceType,
				description: description.trim() || undefined,
				includeCustomFormatWhenRenaming: includeInRenaming,
				specifications: specifications.map((s) => ({
					...s,
					fields: s.fields || {},
				})),
				defaultScore,
			},
			{ onSuccess },
		);
	};

	return (
		<div className="space-y-4">
			{/* Name + Service Type */}
			<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
				<div>
					<label className="text-sm font-medium text-foreground">Name *</label>
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="My Custom Format"
						className="mt-1 w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-hidden focus:ring-2 focus:ring-primary/20"
					/>
				</div>
				<div>
					<label className="text-sm font-medium text-foreground">Service Type *</label>
					<select
						value={serviceType}
						onChange={(e) => setServiceType(e.target.value as "RADARR" | "SONARR")}
						className="mt-1 w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-hidden focus:ring-2 focus:ring-primary/20"
					>
						<option value="RADARR">Radarr</option>
						<option value="SONARR">Sonarr</option>
					</select>
				</div>
			</div>

			{/* Description */}
			<div>
				<label className="text-sm font-medium text-foreground">Description</label>
				<textarea
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					placeholder="Optional description of what this format matches..."
					rows={2}
					className="mt-1 w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-hidden focus:ring-2 focus:ring-primary/20 resize-none"
				/>
			</div>

			{/* Score + Renaming */}
			<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
				<div>
					<label className="text-sm font-medium text-foreground">Default Score</label>
					<input
						type="number"
						value={defaultScore}
						onChange={(e) => setDefaultScore(Number(e.target.value) || 0)}
						className="mt-1 w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-hidden focus:ring-2 focus:ring-primary/20"
					/>
				</div>
				<div className="flex items-end pb-2">
					<label className="flex items-center gap-2 text-sm cursor-pointer">
						<input
							type="checkbox"
							checked={includeInRenaming}
							onChange={(e) => setIncludeInRenaming(e.target.checked)}
							className="h-4 w-4 rounded border-border bg-muted text-primary focus:ring-primary"
						/>
						<span className="text-foreground">Include in renaming</span>
					</label>
				</div>
			</div>

			{/* Specifications */}
			<SpecificationBuilder
				specifications={specifications}
				onChange={setSpecifications}
			/>

			{/* Error */}
			{createMutation.isError && (
				<div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
					<AlertCircle className="h-4 w-4 shrink-0" />
					{createMutation.error instanceof Error
						? createMutation.error.message
						: "Failed to create custom format"}
				</div>
			)}

			{/* Submit */}
			<div className="flex justify-end pt-2">
				<Button
					onClick={handleSubmit}
					disabled={!name.trim() || specifications.length === 0 || createMutation.isPending}
					style={{ backgroundColor: gradient.from }}
					className="text-white"
				>
					{createMutation.isPending ? (
						<Loader2 className="h-4 w-4 animate-spin mr-2" />
					) : (
						<Plus className="h-4 w-4 mr-2" />
					)}
					Create Custom Format
				</Button>
			</div>
		</div>
	);
}

// ============================================================================
// Tab 2: JSON Import
// ============================================================================

function JsonImportTab({
	defaultServiceType,
	onSuccess,
	gradient,
}: {
	defaultServiceType: "RADARR" | "SONARR";
	onSuccess: () => void;
	gradient: { from: string; fromLight: string };
}) {
	const [jsonInput, setJsonInput] = useState("");
	const [serviceType, setServiceType] = useState<"RADARR" | "SONARR">(defaultServiceType);
	const [defaultScore, setDefaultScore] = useState(0);
	const [parseError, setParseError] = useState<string | null>(null);
	const [preview, setPreview] = useState<Array<{ name: string }> | null>(null);

	const importMutation = useImportUserCFFromJson();

	const parseJson = useCallback(() => {
		setParseError(null);
		setPreview(null);

		if (!jsonInput.trim()) {
			setParseError("Please paste JSON content");
			return;
		}

		try {
			const parsed = JSON.parse(jsonInput.trim());

			// Handle both single CF and array of CFs
			const cfs = Array.isArray(parsed) ? parsed : [parsed];

			// Validate basic structure
			const valid = cfs.filter(
				(cf: any) => cf.name && typeof cf.name === "string",
			);

			if (valid.length === 0) {
				setParseError(
					"No valid custom formats found. Each must have at least a 'name' field.",
				);
				return;
			}

			setPreview(valid.map((cf: any) => ({ name: cf.name })));
		} catch {
			setParseError("Invalid JSON. Please check the format and try again.");
		}
	}, [jsonInput]);

	const handleImport = () => {
		if (!jsonInput.trim()) return;

		try {
			const parsed = JSON.parse(jsonInput.trim());
			const cfs = Array.isArray(parsed) ? parsed : [parsed];

			importMutation.mutate(
				{
					serviceType,
					customFormats: cfs.map((cf: any) => ({
						name: cf.name,
						includeCustomFormatWhenRenaming: cf.includeCustomFormatWhenRenaming,
						specifications: cf.specifications,
					})),
					defaultScore,
				},
				{ onSuccess },
			);
		} catch {
			setParseError("Failed to parse JSON");
		}
	};

	return (
		<div className="space-y-4">
			{/* Service Type + Score */}
			<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
				<div>
					<label className="text-sm font-medium text-foreground">Service Type</label>
					<select
						value={serviceType}
						onChange={(e) => setServiceType(e.target.value as "RADARR" | "SONARR")}
						className="mt-1 w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-hidden focus:ring-2 focus:ring-primary/20"
					>
						<option value="RADARR">Radarr</option>
						<option value="SONARR">Sonarr</option>
					</select>
				</div>
				<div>
					<label className="text-sm font-medium text-foreground">Default Score</label>
					<input
						type="number"
						value={defaultScore}
						onChange={(e) => setDefaultScore(Number(e.target.value) || 0)}
						className="mt-1 w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-hidden focus:ring-2 focus:ring-primary/20"
					/>
				</div>
			</div>

			{/* JSON Input */}
			<div>
				<label className="text-sm font-medium text-foreground">
					Paste Custom Format JSON
				</label>
				<p className="text-xs text-muted-foreground mt-0.5 mb-1">
					Export a custom format from Sonarr/Radarr (Settings → Custom Formats → Export) and paste it here.
				</p>
				<textarea
					value={jsonInput}
					onChange={(e) => {
						setJsonInput(e.target.value);
						setPreview(null);
						setParseError(null);
					}}
					placeholder='[{"name": "My Format", "specifications": [...]}]'
					rows={8}
					className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-xs font-mono text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-hidden focus:ring-2 focus:ring-primary/20 resize-none"
				/>
			</div>

			{/* Parse button */}
			{!preview && (
				<Button variant="outline" onClick={parseJson} disabled={!jsonInput.trim()}>
					<FileJson className="h-4 w-4 mr-2" />
					Preview
				</Button>
			)}

			{/* Parse error */}
			{parseError && (
				<div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
					<AlertCircle className="h-4 w-4 shrink-0" />
					{parseError}
				</div>
			)}

			{/* Preview */}
			{preview && (
				<div
					className="rounded-lg border p-3 space-y-2"
					style={{
						borderColor: gradient.fromLight,
						backgroundColor: gradient.fromLight,
					}}
				>
					<p className="text-sm font-medium text-foreground">
						Found {preview.length} custom format{preview.length !== 1 ? "s" : ""}:
					</p>
					<ul className="space-y-1">
						{preview.map((cf, i) => (
							<li key={i} className="flex items-center gap-2 text-sm text-foreground">
								<Check className="h-3.5 w-3.5 shrink-0" style={{ color: gradient.from }} />
								{cf.name}
							</li>
						))}
					</ul>
				</div>
			)}

			{/* Import result */}
			{importMutation.isSuccess && importMutation.data && (
				<div className="rounded-lg bg-green-500/10 p-3 space-y-1 text-sm">
					{importMutation.data.created.length > 0 && (
						<p className="text-green-400">
							✓ Created: {importMutation.data.created.join(", ")}
						</p>
					)}
					{importMutation.data.skipped.length > 0 && (
						<p className="text-amber-400">
							⊘ Skipped (already exists): {importMutation.data.skipped.join(", ")}
						</p>
					)}
					{importMutation.data.failed.length > 0 && (
						<p className="text-red-400">
							✗ Failed: {importMutation.data.failed.map((f) => f.name).join(", ")}
						</p>
					)}
				</div>
			)}

			{/* Import error */}
			{importMutation.isError && (
				<div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
					<AlertCircle className="h-4 w-4 shrink-0" />
					{importMutation.error instanceof Error
						? importMutation.error.message
						: "Import failed"}
				</div>
			)}

			{/* Import button */}
			{preview && (
				<div className="flex justify-end">
					<Button
						onClick={handleImport}
						disabled={importMutation.isPending}
						style={{ backgroundColor: gradient.from }}
						className="text-white"
					>
						{importMutation.isPending ? (
							<Loader2 className="h-4 w-4 animate-spin mr-2" />
						) : (
							<Upload className="h-4 w-4 mr-2" />
						)}
						Import {preview.length} Format{preview.length !== 1 ? "s" : ""}
					</Button>
				</div>
			)}
		</div>
	);
}

// ============================================================================
// Tab 3: Import from Instance
// ============================================================================

function InstanceImportTab({
	onSuccess,
	gradient,
}: {
	onSuccess: () => void;
	gradient: { from: string; fromLight: string };
}) {
	const [selectedInstanceId, setSelectedInstanceId] = useState("");
	const [instanceCFs, setInstanceCFs] = useState<
		Array<{ id: number; name: string; checked: boolean }>
	>([]);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [defaultScore, setDefaultScore] = useState(0);

	const { data: services } = useServicesQuery();
	const importMutation = useImportUserCFFromInstance();

	// Filter to only Radarr and Sonarr instances
	// Note: service values are lowercase in frontend (API's formatServiceInstance lowercases them)
	const arrInstances = (services || []).filter(
		(s: any) => s.service === "radarr" || s.service === "sonarr",
	);

	const loadInstanceCFs = async () => {
		if (!selectedInstanceId) return;
		setLoading(true);
		setLoadError(null);
		setInstanceCFs([]);

		try {
			// Use the instance's custom format endpoint
			const instance = arrInstances.find((s: any) => s.id === selectedInstanceId);
			if (!instance) throw new Error("Instance not found");

			const response = await apiRequest<any>(
				`/api/trash-guides/user-custom-formats/instance-cfs/${selectedInstanceId}`,
			);

			if (!response.success || !response.data) {
				throw new Error(response.error || "Failed to fetch custom formats");
			}

			setInstanceCFs(
				(response.data as any[]).map((cf: any) => ({
					id: cf.id,
					name: cf.name || `CF-${cf.id}`,
					checked: false,
				})),
			);
		} catch (error) {
			setLoadError(
				error instanceof Error ? error.message : "Failed to load custom formats",
			);
		} finally {
			setLoading(false);
		}
	};

	const toggleCF = (id: number) => {
		setInstanceCFs((prev) =>
			prev.map((cf) => (cf.id === id ? { ...cf, checked: !cf.checked } : cf)),
		);
	};

	const toggleAll = (checked: boolean) => {
		setInstanceCFs((prev) => prev.map((cf) => ({ ...cf, checked })));
	};

	const selectedCount = instanceCFs.filter((cf) => cf.checked).length;

	const handleImport = () => {
		const selectedCFIds = instanceCFs.filter((cf) => cf.checked).map((cf) => cf.id);
		if (selectedCFIds.length === 0) return;

		importMutation.mutate(
			{
				instanceId: selectedInstanceId,
				cfIds: selectedCFIds,
				defaultScore,
			},
			{ onSuccess },
		);
	};

	return (
		<div className="space-y-4">
			{/* Instance selector */}
			<div>
				<label className="text-sm font-medium text-foreground">Select Instance</label>
				<div className="flex gap-2 mt-1">
					<select
						value={selectedInstanceId}
						onChange={(e) => {
							setSelectedInstanceId(e.target.value);
							setInstanceCFs([]);
							setLoadError(null);
						}}
						className="flex-1 rounded-lg border border-border/50 bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-hidden focus:ring-2 focus:ring-primary/20"
					>
						<option value="">Choose an instance...</option>
						{arrInstances.map((instance: any) => (
							<option key={instance.id} value={instance.id}>
								{instance.label} ({instance.service})
							</option>
						))}
					</select>
					<Button
						variant="outline"
						onClick={loadInstanceCFs}
						disabled={!selectedInstanceId || loading}
					>
						{loading ? (
							<Loader2 className="h-4 w-4 animate-spin" />
						) : (
							<Server className="h-4 w-4" />
						)}
					</Button>
				</div>
			</div>

			{/* Default score */}
			<div>
				<label className="text-sm font-medium text-foreground">Default Score</label>
				<input
					type="number"
					value={defaultScore}
					onChange={(e) => setDefaultScore(Number(e.target.value) || 0)}
					className="mt-1 w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-hidden focus:ring-2 focus:ring-primary/20"
				/>
			</div>

			{/* Load error */}
			{loadError && (
				<div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
					<AlertCircle className="h-4 w-4 shrink-0" />
					{loadError}
				</div>
			)}

			{/* CF list */}
			{instanceCFs.length > 0 && (
				<div className="space-y-2">
					<div className="flex items-center justify-between">
						<span className="text-sm text-muted-foreground">
							{instanceCFs.length} custom formats found
						</span>
						<div className="flex gap-2">
							<button
								type="button"
								onClick={() => toggleAll(true)}
								className="text-xs text-primary hover:text-primary/80 transition"
							>
								Select all
							</button>
							<button
								type="button"
								onClick={() => toggleAll(false)}
								className="text-xs text-muted-foreground hover:text-foreground transition"
							>
								Clear
							</button>
						</div>
					</div>

					<div className="max-h-60 overflow-y-auto rounded-lg border border-border/50 divide-y divide-border/30">
						{instanceCFs.map((cf) => (
							<label
								key={cf.id}
								className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/50 transition"
							>
								<input
									type="checkbox"
									checked={cf.checked}
									onChange={() => toggleCF(cf.id)}
									className="h-4 w-4 rounded border-border bg-muted text-primary focus:ring-primary"
								/>
								<span className="text-sm text-foreground">{cf.name}</span>
							</label>
						))}
					</div>
				</div>
			)}

			{/* Import result */}
			{importMutation.isSuccess && importMutation.data && (
				<div className="rounded-lg bg-green-500/10 p-3 space-y-1 text-sm">
					{importMutation.data.created.length > 0 && (
						<p className="text-green-400">
							✓ Created: {importMutation.data.created.join(", ")}
						</p>
					)}
					{importMutation.data.skipped.length > 0 && (
						<p className="text-amber-400">
							⊘ Skipped: {importMutation.data.skipped.join(", ")}
						</p>
					)}
				</div>
			)}

			{/* Import error */}
			{importMutation.isError && (
				<div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
					<AlertCircle className="h-4 w-4 shrink-0" />
					{importMutation.error instanceof Error
						? importMutation.error.message
						: "Import failed"}
				</div>
			)}

			{/* Import button */}
			{selectedCount > 0 && (
				<div className="flex justify-end">
					<Button
						onClick={handleImport}
						disabled={importMutation.isPending}
						style={{ backgroundColor: gradient.from }}
						className="text-white"
					>
						{importMutation.isPending ? (
							<Loader2 className="h-4 w-4 animate-spin mr-2" />
						) : (
							<Upload className="h-4 w-4 mr-2" />
						)}
						Import {selectedCount} Format{selectedCount !== 1 ? "s" : ""}
					</Button>
				</div>
			)}
		</div>
	);
}
