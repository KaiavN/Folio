import { NativeModules, Platform } from "react-native";

import { MODEL_ARTIFACTS } from "./catalog.ts";
import { normalizeModelFamily } from "./display.ts";
import type {
	ArtifactManifest,
	ArtifactReadiness,
	BackendArtifactDescriptor,
	BackendId,
	GenerationParams,
	ModelArtifactDescriptor,
	ModelInputModality,
	PackageFormatId,
	PromptTemplateId,
	QuantizationId,
} from "./types.ts";

export const FOLIO_PUBLIC_BUCKET_BASE_URL =
	"https://us-east-1.storage.impossibleapi.net/folio";
export const FOLIO_REMOTE_CATALOG_URL =
  `${FOLIO_PUBLIC_BUCKET_BASE_URL}/models/catalog/latest.json`;
// NOTE: EXPO_PUBLIC_FOLIO_ARTIFACT_API_BASE_URL must be set via environment variables.
// No hardcoded production URLs are allowed.
const DEV_ASSET_PROXY_PORT = 8787;
const CATALOG_FETCH_TIMEOUT_MS = 4500;
const ARTIFACT_API_TIMEOUT_MS = 8000;

const CONFIGURED_CATALOG_URL =
  normalizeConfiguredUrl(process.env.EXPO_PUBLIC_FOLIO_CATALOG_URL) ??
  FOLIO_REMOTE_CATALOG_URL;
const CONFIGURED_ARTIFACT_API_BASE_URL = normalizeConfiguredUrl(
  process.env.EXPO_PUBLIC_FOLIO_ARTIFACT_API_BASE_URL,
);

export type ModelCatalogSource = "remote" | "static";
export type ResolvedArtifactDownload = {
	url: string;
	packageSizeBytes?: number | null;
};

export type LoadedModelCatalog = {
	source: ModelCatalogSource;
	models: ModelArtifactDescriptor[];
	errorMessage?: string;
	generatedAt?: string;
};

type RemoteCatalogPayload = {
	schema_version: string;
	generated_at?: string;
	models: RemoteCatalogModel[];
};

type RemoteCatalogModel = {
	model: {
		id: string;
		slug: string;
		family?: string | null;
		variant?: string | null;
		size_label?: string | null;
		display_name?: string | null;
		description?: string | null;
		description_long?: string | null;
		pipeline_tag?: string | null;
		tags?: string[] | null;
	};
	search?: {
		display_name?: string | null;
		description?: string | null;
		text?: string | null;
	};
	artifacts: RemoteCatalogArtifact[];
};

type RemoteCatalogArtifact = {
	id: string;
	backend: string;
	quantization: string;
	task?: string;
	package_format?: string;
	package_sha256?: string;
	package_s3_key?: string;
	package_download_url?: string;
	package_public_url?: string;
	package_size_bytes?: number;
	archive_sha256?: string;
	archive_s3_key?: string;
	archive_download_url?: string;
	archive_public_url?: string;
	archive_size_bytes?: number;
};

const SUPPORTED_BACKENDS: BackendId[] = [
	"coreml",
	"xnnpack",
	"vulkan",
	"mediatek",
];
const SUPPORTED_QUANTIZATIONS: QuantizationId[] = [
	"8da4w",
	"8w",
	"fp16",
	"fp32",
	"int8",
];
const SUPPORTED_PACKAGE_FORMATS: PackageFormatId[] = ["tar.gz", "zip"];

const STATIC_MODELS_BY_SLUG = new Map(
	MODEL_ARTIFACTS.map((model) => [model.modelSlug, model] as const),
);

export async function loadModelCatalog(): Promise<LoadedModelCatalog> {
	try {
		const response = await fetchWithTimeout(
			resolveCatalogUrl(),
			{
				headers: {
					accept: "application/json",
				},
			},
			CATALOG_FETCH_TIMEOUT_MS,
		);

		if (!response.ok) {
			throw new Error(`Artifact catalog returned HTTP ${response.status}.`);
		}

		const payload = (await response.json()) as RemoteCatalogPayload;
		if (
			payload.schema_version !== "folio-upload-catalog/v1" ||
			!Array.isArray(payload.models)
		) {
			throw new Error(
				"Bucket catalog schema did not match folio-upload-catalog/v1.",
			);
		}

		const models = payload.models
			.map(mapRemoteModel)
			.filter((model): model is ModelArtifactDescriptor => model !== null);

		if (!models.length) {
			throw new Error(
				"Bucket catalog loaded but did not contain any supported model artifacts.",
			);
		}

		return {
			source: "remote",
			models,
			generatedAt: payload.generated_at,
		};
	} catch (error) {
		console.log("[loadModelCatalog] fetch error:", error);
		return {
			source: "static",
			models: MODEL_ARTIFACTS,
			errorMessage:
				error instanceof Error
					? error.message
					: "Fell back to the bundled catalog because the remote artifact catalog could not be loaded.",
		};
	}
}

export function buildBucketObjectUrl(s3Key: string): string {
	const normalizedKey = s3Key.replace(/^\/+/, "");
	const devProxyUrl = buildDevProxyObjectUrl(normalizedKey);
	if (devProxyUrl) {
		return devProxyUrl;
	}

	return `${FOLIO_PUBLIC_BUCKET_BASE_URL}/${normalizedKey
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/")}`;
}

export async function resolveArtifactDownload(
	manifest: ArtifactManifest,
): Promise<ResolvedArtifactDownload> {
	if (manifest.downloadUrl && manifest.downloadUrl.length > 0) {
		return {
			url: manifest.downloadUrl,
			packageSizeBytes: manifest.packageSizeBytes ?? null,
		};
	}

	if (CONFIGURED_ARTIFACT_API_BASE_URL) {
		return requestSignedArtifactUrl(manifest, CONFIGURED_ARTIFACT_API_BASE_URL);
	}

	return {
		url: buildBucketObjectUrl(manifest.s3Key),
		packageSizeBytes: manifest.packageSizeBytes ?? null,
	};
}

function resolveCatalogUrl(): string {
	if (CONFIGURED_CATALOG_URL) {
		return CONFIGURED_CATALOG_URL;
	}

	const proxyBaseUrl = resolveDevAssetProxyBaseUrl();
	if (proxyBaseUrl) {
		return `${proxyBaseUrl}/catalog/latest.json`;
	}

	return FOLIO_REMOTE_CATALOG_URL;
}

async function requestSignedArtifactUrl(
	manifest: ArtifactManifest,
	artifactApiBaseUrl: string,
): Promise<ResolvedArtifactDownload> {
	const signedUrl = `${artifactApiBaseUrl}/artifacts/${encodeURIComponent(manifest.artifactId)}/download-url`;
		const response = await fetchWithTimeout(
		signedUrl,
		{
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				artifactId: manifest.artifactId,
				modelId: manifest.modelId,
				backendId: manifest.backendId,
				quantization: manifest.quantization,
				packageFormat: manifest.packageFormat,
				s3Key: manifest.s3Key,
				checksum: manifest.checksum,
			}),
		},
		ARTIFACT_API_TIMEOUT_MS,
	);

	if (!response.ok) {
		throw new Error(
			`Artifact delivery API returned HTTP ${response.status} for ${manifest.artifactId}.`,
		);
	}

	const payload = (await response.json()) as {
		url?: string;
		downloadUrl?: string;
		packageSizeBytes?: number | string | null;
		sizeBytes?: number | string | null;
		contentLength?: number | string | null;
	};
	const url = payload.downloadUrl ?? payload.url;
	if (typeof url !== "string" || !url) {
		throw new Error(
			`Artifact delivery API did not return a download URL for ${manifest.artifactId}.`,
		);
	}

	return {
		url,
		packageSizeBytes:
			normalizePackageSize(payload.packageSizeBytes) ??
			normalizePackageSize(payload.sizeBytes) ??
			normalizePackageSize(payload.contentLength) ??
			manifest.packageSizeBytes ??
			null,
	};
}

function buildDevProxyObjectUrl(s3Key: string): string | null {
	const proxyBaseUrl = resolveDevAssetProxyBaseUrl();
	if (!proxyBaseUrl) {
		return null;
	}

	return `${proxyBaseUrl}/object?key=${encodeURIComponent(s3Key)}`;
}

function resolveDevAssetProxyBaseUrl(): string | null {
	if (!__DEV__ || Platform.OS === "web") {
		return null;
	}

	const scriptURL = NativeModules.SourceCode?.scriptURL;
	if (typeof scriptURL !== "string" || !scriptURL) {
		return null;
	}

	try {
		const bundleUrl = new URL(scriptURL);
		return `http://${bundleUrl.hostname}:${DEV_ASSET_PROXY_PORT}`;
	} catch {
		return null;
	}
}

function normalizeConfiguredUrl(value: string | undefined): string | null {
	if (!value) {
		return null;
	}

	const trimmed = value.trim();
	return trimmed ? trimmed.replace(/\/+$/, "") : null;
}

function normalizePackageSize(
	value: number | string | null | undefined,
): number | null {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value;
	}

	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}

	return null;
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

	try {
		return await fetch(url, {
			...init,
			signal: controller.signal,
		});
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(
				`Request timed out after ${Math.round(timeoutMs / 1000)}s.`,
			);
		}
		throw error;
	} finally {
		clearTimeout(timeoutHandle);
	}
}

export function matchesModelSearch(
	model: ModelArtifactDescriptor,
	query: string,
): boolean {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) {
		return true;
	}

	const haystack =
		model.searchText ??
		[
			model.family,
			model.variant,
			model.sizeLabel,
			model.modelSlug,
			...model.notes,
		]
			.join(" ")
			.toLowerCase();

	return haystack.includes(normalizedQuery);
}

function mapRemoteModel(
	remoteModel: RemoteCatalogModel,
): ModelArtifactDescriptor | null {
	const staticModel = STATIC_MODELS_BY_SLUG.get(remoteModel.model.slug);
	const artifacts = remoteModel.artifacts
		.map(mapRemoteArtifact)
		.filter(
			(artifact): artifact is BackendArtifactDescriptor => artifact !== null,
		);

	if (!artifacts.length) {
		return null;
	}

	const family = normalizeModelFamily(
		remoteModel.model.family?.trim() ||
			staticModel?.family ||
			remoteModel.model.display_name ||
			remoteModel.model.id,
	);
	const variant =
		remoteModel.model.variant?.trim() ||
		staticModel?.variant ||
		remoteModel.model.size_label ||
		"Published";
	const description =
		remoteModel.search?.description?.trim() ||
		remoteModel.model.description?.trim() ||
		remoteModel.model.description_long?.trim() ||
		staticModel?.notes[0] ||
		"Published from the live Folio bucket catalog.";
	const searchText = [
		remoteModel.search?.text,
		remoteModel.search?.display_name,
		remoteModel.model.display_name,
		remoteModel.model.id,
		remoteModel.model.slug,
		family,
		variant,
		description,
	]
		.filter((value): value is string => Boolean(value))
		.join(" ")
		.toLowerCase();
	const inputModalities = inputModalitiesFor(remoteModel, staticModel);
	const supportsVision = inputModalities.includes("vision");

	// Map capabilities from static model or infer from pipeline tags
	const capabilities =
		staticModel?.capabilities ??
		inferCapabilitiesFromTags(remoteModel.model.tags, supportsVision);

	return {
		id: staticModel?.id ?? fallbackModelIdFor(remoteModel.model.slug),
		modelSlug: remoteModel.model.slug,
		family,
		variant,
		sizeLabel:
			remoteModel.model.size_label?.trim() || staticModel?.sizeLabel || variant,
		estimatedSizeGb:
			staticModel?.estimatedSizeGb ?? estimateSizeGbFrom(artifacts),
		recommendedRamGb:
			staticModel?.recommendedRamGb ?? estimateRecommendedRamGb(artifacts),
		compatibleBackends: [
			...new Set(artifacts.map((artifact) => artifact.backend)),
		],
		readiness: readinessFor(artifacts),
		feasibility: staticModel?.feasibility ?? "validation-first",
		inputModalities,
		supportsVision,
		promptTemplate: promptTemplateFor(remoteModel, staticModel, supportsVision),
		generationParams: generationParamsFor(staticModel),
		artifacts,
		capabilities,
		preferredUseCases: staticModel?.preferredUseCases,
		notes: buildNotes(description, staticModel),
		searchText,
	};
}

function mapRemoteArtifact(
	remoteArtifact: RemoteCatalogArtifact,
): BackendArtifactDescriptor | null {
	if (
		!isBackendId(remoteArtifact.backend) ||
		!isQuantizationId(remoteArtifact.quantization)
	) {
		return null;
	}

	const packageFormat = packageFormatFor(remoteArtifact);
	const checksum =
		remoteArtifact.package_sha256 ?? remoteArtifact.archive_sha256;
	const s3Key = remoteArtifact.package_s3_key ?? remoteArtifact.archive_s3_key;
	const downloadUrl =
		remoteArtifact.package_download_url ??
		remoteArtifact.package_public_url ??
		remoteArtifact.archive_download_url ??
		remoteArtifact.archive_public_url;

	if (!packageFormat || !checksum || !s3Key) {
		return null;
	}

	if (Platform.OS !== "web" && packageFormat !== "zip") {
		return null;
	}

	return {
		artifactId: remoteArtifact.id,
		backend: remoteArtifact.backend,
		quantization: remoteArtifact.quantization,
		task: remoteArtifact.task ?? "text-generation",
		packageFormat,
		checksum,
		s3Key,
		downloadUrl,
		packageSizeBytes:
			remoteArtifact.package_size_bytes ?? remoteArtifact.archive_size_bytes,
	};
}

function fallbackModelIdFor(modelSlug: string): string {
	return modelSlug
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function packageFormatFor(
	remoteArtifact: RemoteCatalogArtifact,
): PackageFormatId | null {
	const format = remoteArtifact.package_format;
	if (isPackageFormatId(format)) {
		return format;
	}

	const s3Key =
		remoteArtifact.package_s3_key ?? remoteArtifact.archive_s3_key ?? "";
	if (s3Key.endsWith(".tar.gz")) {
		return "tar.gz";
	}
	if (s3Key.endsWith(".zip")) {
		return "zip";
	}

	return null;
}

function inferCapabilitiesFromTags(
	tags: string[] | null | undefined,
	supportsVision: boolean,
): string[] {
	const capabilities: string[] = [];
	const allTags = [
		...(tags ?? []).map((t) => t.toLowerCase()),
	];
	if (supportsVision) capabilities.push("vision");
	if (allTags.some((t) => t.includes("coding") || t.includes("code"))) {
		capabilities.push("coding");
	}
	if (allTags.some((t) => t.includes("math") || t.includes("reasoning"))) {
		capabilities.push("math", "reasoning");
	}
	if (allTags.some((t) => t.includes("long-context") || t.includes("long_context"))) {
		capabilities.push("longContext");
	}
	return capabilities;
}

function buildNotes(
	description: string,
	staticModel?: ModelArtifactDescriptor,
): string[] {
	const notes = [description, ...(staticModel?.notes ?? [])].filter(Boolean);
	return [...new Set(notes)];
}

function inputModalitiesFor(
	remoteModel: RemoteCatalogModel,
	staticModel?: ModelArtifactDescriptor,
): ModelInputModality[] {
	if (staticModel) {
		return staticModel.inputModalities;
	}

	const tags = (remoteModel.model.tags ?? []).map((tag) => tag.toLowerCase());
	const pipelineTag = remoteModel.model.pipeline_tag?.toLowerCase() ?? "";
	const supportsVision =
		pipelineTag.includes("image") ||
		pipelineTag === "any-to-any" ||
		tags.includes("image-text-to-text") ||
		tags.includes("vision") ||
		tags.includes("multimodal");

	return supportsVision ? ["text", "vision"] : ["text"];
}

function promptTemplateFor(
	remoteModel: RemoteCatalogModel,
	staticModel: ModelArtifactDescriptor | undefined,
	supportsVision: boolean,
): PromptTemplateId {
	if (staticModel) {
		return staticModel.promptTemplate;
	}

	if (
		supportsVision &&
		remoteModel.model.slug.toLowerCase().includes("gemma-4")
	) {
		return "gemma4-chat";
	}

	return "plain";
}

function generationParamsFor(
	staticModel: ModelArtifactDescriptor | undefined,
): GenerationParams {
	return (
		staticModel?.generationParams ?? { temperature: 0.8, maxNewTokens: 256 }
	);
}

function estimateSizeGbFrom(artifacts: BackendArtifactDescriptor[]): number {
	const largestArtifactBytes = Math.max(
		...artifacts.map((artifact) => artifact.packageSizeBytes ?? 0),
		0,
	);
	if (!largestArtifactBytes) {
		return 0.5;
	}

	return Math.max(0.1, Number((largestArtifactBytes / 1024 ** 3).toFixed(1)));
}

function estimateRecommendedRamGb(
	artifacts: BackendArtifactDescriptor[],
): number {
	const estimatedSizeGb = estimateSizeGbFrom(artifacts);
	return Math.max(4, Math.ceil(estimatedSizeGb * 2));
}

function readinessFor(
	artifacts: BackendArtifactDescriptor[],
): ArtifactReadiness {
	return artifacts.length ? "verified" : "upload-pending";
}

function isBackendId(value: string): value is BackendId {
	return SUPPORTED_BACKENDS.includes(value as BackendId);
}

function isQuantizationId(value: string): value is QuantizationId {
	return SUPPORTED_QUANTIZATIONS.includes(value as QuantizationId);
}

function isPackageFormatId(value?: string): value is PackageFormatId {
	return SUPPORTED_PACKAGE_FORMATS.includes(value as PackageFormatId);
}
