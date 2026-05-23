import { Directory, File, Paths, readAsStringAsync } from "expo-file-system";
import {
	createDownloadResumable,
	type DownloadProgressData,
} from "expo-file-system/legacy";
import { Platform } from "react-native";

import FolioExecuTorchEngineModule, {
	type NativeBackendAvailability,
	type NativeChatAttachment,
	type NativeChatGenerationChunkEventPayload,
	type NativeChatGenerationResult,
	type NativePreparedArtifact,
	type NativeRuntimeInfo,
	type NativeSessionHandle,
	type NativeSessionRuntimeOptions,
	type NativeTelemetrySnapshot,
} from "../../modules/folio-executorch-engine/index.ts";
import {
	buildBucketObjectUrl,
	resolveArtifactDownload,
} from "./remoteCatalog.ts";
import {
	enrichPromptWithDocuments,
	verifyDocumentGroundedResponse,
	type DocumentEnrichmentOptions,
} from "./documents/contextBuilder.ts";
import { preProcessPrompt } from "./tools/promptPreProcessor.ts";
import type {
	ArtifactManifest,
	ArtifactPreparationProgress,
	BackendAvailability,
	BackendId,
	ChatAttachment,
	ChatGenerationChunk,
	ChatGenerationResult,
	PreparedArtifact,
	RuntimeInfo,
	SessionHandle,
	SessionRuntimeOptions,
	TelemetrySnapshot,
} from "./types.ts";

type ArtifactPackageMarker = {
	checksum: string;
	sourceKey: string;
	packageFormat: ArtifactManifest["packageFormat"];
	sizeBytes: number;
};

const MIN_ARTIFACT_PACKAGE_BYTES = 128 * 1024;
const ARTIFACT_RUNTIME_MANIFEST_FILE = "folio-runtime-manifest.json";
const ARTIFACT_CACHE_VERSION = "v3";
const PREPARE_ARTIFACT_TIMEOUT_MS = 10 * 60 * 1000;
const BOOTSTRAP_TIMEOUT_MS = 15_000;
const CREATE_SESSION_TIMEOUT_MS = 60_000;
const ARTIFACT_DOWNLOAD_RETRIES = 3;
const ARTIFACT_DOWNLOAD_RETRY_DELAY_MS = 1200;
const inFlightArtifactPrepares = new Map<string, Promise<PreparedArtifact>>();

function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(
				new Error(
					`${label} timed out after ${Math.round(timeoutMs / 1000)}s`,
				),
			);
		}, timeoutMs);
	});

	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== null) {
			clearTimeout(timer);
		}
	});
}

type ExtractedArtifactManifest = {
	modelFile: string;
	tokenizerFile: string;
};

/**
 * Clean up orphan partial download files (`.download` extension).
 * These are left behind if the app crashed during an interrupted download.
 */
async function pruneOrphanDownloadFiles(): Promise<void> {
	try {
		const modelsRoot = new Directory(Paths.document, "folio-models");
		if (!modelsRoot.exists) {
			return;
		}
		await pruneOrphanDownloadFilesRecursive(modelsRoot);
	} catch {
		// Best-effort cleanup — don't fail runtime bootstrap
	}
}

async function pruneOrphanDownloadFilesRecursive(dir: Directory): Promise<void> {
	try {
		const entries = dir.list();
		for (const entry of entries) {
			if (entry instanceof Directory) {
				await pruneOrphanDownloadFilesRecursive(entry);
			} else if (entry.name.endsWith(".download")) {
				entry.delete();
			}
		}
	} catch {
		// Ignore permission errors or other filesystem issues during cleanup
	}
}

export async function bootstrapRuntime(): Promise<{
	runtimeInfo: RuntimeInfo;
	availableBackends: BackendAvailability[];
	telemetry: TelemetrySnapshot;
}> {
	// Clean up any orphan partial downloads from previous interrupted sessions
	await pruneOrphanDownloadFiles();

	const runtimeInfo = mapRuntimeInfo(
		FolioExecuTorchEngineModule.getRuntimeInfo(),
	);
	const availableBackends =
		FolioExecuTorchEngineModule.getAvailableBackends().map(mapBackend);

	let telemetry: TelemetrySnapshot;
	try {
		telemetry = mapTelemetry(
			await withTimeout(
				FolioExecuTorchEngineModule.getTelemetrySnapshotAsync(),
				BOOTSTRAP_TIMEOUT_MS,
				"Runtime bootstrap",
			),
		);
	} catch {
		// Telemetry is best-effort — continue with null telemetry rather than
		// failing the entire bootstrap, which would block all model interactions.
		telemetry = {
			ttftMs: null,
			decodeTokensPerSecond: null,
			peakMemoryMb: null,
			queueDepth: null,
			lastRoute: null,
		};
	}

	return {
		runtimeInfo,
		availableBackends,
		telemetry,
	};
}

export async function prepareArtifact(
	manifest: ArtifactManifest,
	onProgress?: (progress: ArtifactPreparationProgress) => void,
): Promise<PreparedArtifact> {
	const preparationKey = artifactPreparationKey(manifest);
	const existingPreparation = inFlightArtifactPrepares.get(preparationKey);
	if (existingPreparation) {
		return existingPreparation;
	}

	const rawPreparation: Promise<PreparedArtifact> =
		(async (): Promise<PreparedArtifact> => {
			if (Platform.OS === "web") {
				emitPreparationProgress(onProgress, {
					phase: "checking-cache",
					progress: 0.1,
				});
				const prepared = await FolioExecuTorchEngineModule.prepareArtifactAsync(
					manifest.artifactId,
					manifest.s3Key,
					manifest.checksum,
					manifest.packageFormat,
				);
				emitPreparationProgress(onProgress, {
					phase: "ready",
					progress: 1,
				});

				return mapPreparedArtifact(prepared);
			}

			const localArtifactFile = ensureLocalArtifactPackageFile(manifest);
			const localArtifactMarkerFile =
				ensureLocalArtifactPackageMarkerFile(manifest);
			const extractedArtifactDirectory = ensureLocalArtifactDirectory(manifest);
						emitPreparationProgress(onProgress, {
				phase: "checking-cache",
				progress: 0.08,
			});

			if (extractedArtifactDirectoryIsValid(extractedArtifactDirectory)) {
				if (
					localArtifactFile.exists &&
					!artifactFileIsValid(
						localArtifactFile,
						localArtifactMarkerFile,
						manifest,
					)
				) {
					localArtifactFile.delete();
					clearArtifactPackageMarker(localArtifactMarkerFile);
				}
				emitPreparationProgress(onProgress, {
					phase: "ready",
					progress: 1,
					transferredBytes: manifest.packageSizeBytes ?? localArtifactFile.size,
					totalBytes:
						manifest.packageSizeBytes ?? localArtifactFile.size ?? null,
				});

				return {
					artifactId: manifest.artifactId,
					localUri: extractedArtifactDirectory.uri,
					sourceUri: buildBucketObjectUrl(manifest.s3Key),
					verified: true,
					cacheState: "hit",
				};
			}

			const resolvedDownload = await resolveArtifactDownload(manifest);
			const sourceUri = resolvedDownload.url;
			const expectedPackageSizeBytes =
				resolvedDownload.packageSizeBytes ?? manifest.packageSizeBytes;

			if (
				!artifactFileIsValid(
					localArtifactFile,
					localArtifactMarkerFile,
					manifest,
				)
			) {
				await downloadArtifactPackage(
					sourceUri,
					manifest,
					expectedPackageSizeBytes,
					localArtifactFile,
					localArtifactMarkerFile,
					onProgress,
				);
			}

			emitPreparationProgress(onProgress, {
				phase: "verifying-package",
				progress: 0.84,
				transferredBytes: localArtifactFile.size,
				totalBytes: expectedPackageSizeBytes ?? localArtifactFile.size ?? null,
			});
			
			if (
				!artifactFileIsValid(
					localArtifactFile,
					localArtifactMarkerFile,
					manifest,
				)
			) {
				throw new Error(
					`Downloaded package for ${manifest.artifactId} did not pass local verification.`,
				);
			}

			emitPreparationProgress(onProgress, {
				phase: "extracting",
				progress: 0.92,
				transferredBytes: localArtifactFile.size,
				totalBytes: expectedPackageSizeBytes ?? localArtifactFile.size ?? null,
			});

						try {
				await extractPackageIfNeeded(
					localArtifactFile,
					extractedArtifactDirectory,
					manifest.packageFormat,
				);
			} catch (error) {
				if (localArtifactFile.exists) {
					localArtifactFile.delete();
				}
				clearArtifactPackageMarker(localArtifactMarkerFile);
				if (extractedArtifactDirectory.exists) {
					extractedArtifactDirectory.delete();
				}

				await downloadArtifactPackage(
					sourceUri,
					manifest,
					expectedPackageSizeBytes,
					localArtifactFile,
					localArtifactMarkerFile,
					onProgress,
				);
				emitPreparationProgress(onProgress, {
					phase: "verifying-package",
					progress: 0.84,
					transferredBytes: localArtifactFile.size,
					totalBytes:
						expectedPackageSizeBytes ?? localArtifactFile.size ?? null,
				});

				if (
					!artifactFileIsValid(
						localArtifactFile,
						localArtifactMarkerFile,
						manifest,
					)
				) {
					throw new Error(
						`Downloaded package for ${manifest.artifactId} did not pass local verification.`,
					);
				}

				emitPreparationProgress(onProgress, {
					phase: "extracting",
					progress: 0.92,
					transferredBytes: localArtifactFile.size,
					totalBytes:
						expectedPackageSizeBytes ?? localArtifactFile.size ?? null,
				});

				try {
					await extractPackageIfNeeded(
						localArtifactFile,
						extractedArtifactDirectory,
						manifest.packageFormat,
					);
				} catch (err) {
					// Second extraction failed — clean up extracted directory so next attempt starts fresh
					if (extractedArtifactDirectory.exists) {
						extractedArtifactDirectory.delete();
					}
					throw err;
				}
			}
			emitPreparationProgress(onProgress, {
				phase: "ready",
				progress: 1,
				transferredBytes: localArtifactFile.size,
				totalBytes: expectedPackageSizeBytes ?? localArtifactFile.size ?? null,
			});

			return {
				artifactId: manifest.artifactId,
				localUri: extractedArtifactDirectory.uri,
				sourceUri,
				verified: true,
				cacheState: "miss",
			};
		})();

	const preparation = withTimeout(
		rawPreparation,
		PREPARE_ARTIFACT_TIMEOUT_MS,
		"Model preparation",
	);
	inFlightArtifactPrepares.set(preparationKey, preparation);
	try {
		return await preparation;
	} catch (error) {
		// If this preparation timed out or failed, evict the stale entry so the
		// next attempt can start fresh instead of re-awaiting a hung promise.
		inFlightArtifactPrepares.delete(preparationKey);
		throw error;
	} finally {
		if (inFlightArtifactPrepares.get(preparationKey) === preparation) {
			inFlightArtifactPrepares.delete(preparationKey);
		}
	}
}

export function inspectPreparedArtifact(
	manifest: ArtifactManifest,
): PreparedArtifact | null {
	const extractedArtifactDirectory = resolveLocalArtifactDirectory(manifest);

	// Log detection path for debugging artifact cache misses
	const logPrefix = `[inspectPreparedArtifact] model=${manifest.modelId} backend=${manifest.backendId} quantization=${manifest.quantization}`;
	
	const isValid = extractedArtifactDirectoryIsValid(extractedArtifactDirectory);
	
	if (!isValid) {
		// Log why it's invalid for debugging
		const manifestFile = new File(extractedArtifactDirectory, "folio-export-manifest.json");
		const runtimeManifestFile = new File(extractedArtifactDirectory, ARTIFACT_RUNTIME_MANIFEST_FILE);
		
		// Check for .pte files as fallback detection
		const hasPte = hasAnyPteFile(extractedArtifactDirectory);
		
		return null;
	}

	// Double-check: verify the actual model file referenced in the manifest exists on disk.
	const extractedManifest = readExtractedArtifactManifest(extractedArtifactDirectory);
	if (extractedManifest) {
		const modelFile = new File(
			extractedArtifactDirectory,
			extractedManifest.modelFile,
		);
				if (!modelFile.exists) {
			return null;
		}
	}

	return {
		artifactId: manifest.artifactId,
		localUri: extractedArtifactDirectory.uri,
		sourceUri: buildBucketObjectUrl(manifest.s3Key),
		verified: true,
		cacheState: "hit",
	};
}

function ensureLocalArtifactRootDirectory(
	manifest: ArtifactManifest,
): Directory {
	const artifactDirectory = resolveLocalArtifactRootDirectory(manifest);
	artifactDirectory.create({
		idempotent: true,
		intermediates: true,
	});

	return artifactDirectory;
}

function resolveLocalArtifactRootDirectory(
	manifest: ArtifactManifest,
): Directory {
	const artifactDirectory = new Directory(
		Paths.document,
		"folio-models",
		ARTIFACT_CACHE_VERSION,
		manifest.backendId,
		manifest.modelId,
		manifest.quantization,
	);

	return artifactDirectory;
}

function ensureLocalArtifactPackageFile(manifest: ArtifactManifest): File {
	const artifactDirectory = ensureLocalArtifactRootDirectory(manifest);

	return new File(
		artifactDirectory,
		manifest.s3Key.split("/").at(-1) ??
			`${manifest.artifactId}.${manifest.packageFormat}`,
	);
}

function ensureLocalArtifactTempFile(manifest: ArtifactManifest): File {
	const packageFile = ensureLocalArtifactPackageFile(manifest);

	return new File(packageFile.parentDirectory, `${packageFile.name}.download`);
}

function artifactPreparationKey(manifest: ArtifactManifest): string {
	return [
		ARTIFACT_CACHE_VERSION,
		manifest.artifactId,
		manifest.s3Key,
		manifest.checksum,
		manifest.packageFormat,
	].join("::");
}

export function pruneIOSFallbackBackendArtifact(
	manifest: ArtifactManifest,
): void {
	const fallbackDirectory = new Directory(
		Paths.document,
		"folio-models",
		ARTIFACT_CACHE_VERSION,
		"xnnpack",
		manifest.modelId,
		manifest.quantization,
	);

	if (fallbackDirectory.exists) {
		fallbackDirectory.delete();
	}
}

function ensureLocalArtifactPackageMarkerFile(
	manifest: ArtifactManifest,
): File {
	const packageFile = ensureLocalArtifactPackageFile(manifest);

	return new File(packageFile.parentDirectory, `${packageFile.name}.meta.json`);
}

function ensureLocalArtifactDirectory(manifest: ArtifactManifest): Directory {
	return new Directory(ensureLocalArtifactRootDirectory(manifest), "extracted");
}

function resolveLocalArtifactDirectory(manifest: ArtifactManifest): Directory {
	return new Directory(
		resolveLocalArtifactRootDirectory(manifest),
		"extracted",
	);
}

function artifactFileIsValid(
	file: File,
	markerFile: File,
	manifest: ArtifactManifest,
): boolean {
	if (!file.exists || file.size <= 0) {
		return false;
	}

	const marker = readArtifactPackageMarker(markerFile);
	if (!marker) {
		return false;
	}

	// Verify file size matches the marker (marker.sizeBytes is the size recorded at download time)
	if (marker.sizeBytes !== file.size) {
		return false;
	}

	return true;
}

function downloadedArtifactFileIsComplete(
	file: File,
	expectedSizeBytes?: number | null,
): boolean {
	if (!file.exists || file.size <= 0) {
		return false;
	}

	if (typeof expectedSizeBytes === "number" && expectedSizeBytes > 0) {
		if (file.size !== expectedSizeBytes) {
			return false;
		}
	}

	return true;
}

export async function createSession(
	artifactId: string,
	backendId: BackendId,
	localUri: string,
	runtimeOptions: SessionRuntimeOptions,
): Promise<SessionHandle> {
	const session = await withTimeout(
		FolioExecuTorchEngineModule.createSessionAsync(
			artifactId,
			backendId,
			localUri,
			mapRuntimeOptions(runtimeOptions),
		),
		CREATE_SESSION_TIMEOUT_MS,
		"Session creation",
	);
	return mapSession(session);
}

export async function resumeSession(sessionId: string): Promise<SessionHandle> {
	const session = await withTimeout(
		FolioExecuTorchEngineModule.resumeSessionAsync(sessionId),
		CREATE_SESSION_TIMEOUT_MS,
		"Session resume",
	);
	return mapSession(session);
}

export async function suspendAllSessions(): Promise<boolean> {
	return FolioExecuTorchEngineModule.suspendAllSessionsAsync();
}

export function isSessionActive(sessionId: string): boolean {
	return FolioExecuTorchEngineModule.isSessionActive(sessionId);
}

export function subscribeAppLifecycle(
	onEvent: (event: "didEnterBackground" | "willEnterForeground") => void,
): () => void {
	const subscription = FolioExecuTorchEngineModule.addListener(
		"onAppLifecycle",
		(payload: { event: "didEnterBackground" | "willEnterForeground" }) => {
			onEvent(payload.event);
		},
	);
	return () => subscription.remove();
}

export async function cancelSession(sessionId: string): Promise<boolean> {
	return FolioExecuTorchEngineModule.cancelSessionAsync(sessionId);
}

export async function interruptGeneration(sessionId: string): Promise<boolean> {
	return FolioExecuTorchEngineModule.interruptGenerationAsync(sessionId);
}

export async function resetSessionContext(sessionId: string): Promise<boolean> {
	return FolioExecuTorchEngineModule.resetSessionContextAsync(sessionId);
}

export async function generateChatReply(
	sessionId: string,
	prompt: string,
	modelLabel: string,
	options: {
		attachments?: ChatAttachment[];
		onChunk?: (chunk: ChatGenerationChunk) => void;
		history?: { role: "user" | "assistant"; content: string }[];
		enrichDocumentContext?: boolean;
		documentEnrichmentOptions?: DocumentEnrichmentOptions;
		model?: { id: string; capabilities?: string[] };
		autoSolveMath?: boolean;
	} = {},
): Promise<ChatGenerationResult> {
	const history = options.history ?? [];

	let processedPrompt = prompt;
	const attachments = options.attachments ?? [];
	let documentConfidence = null;

	if (options.enrichDocumentContext !== false) {
		const documentAttachments = attachments.filter((a) => a.type === "document");
		if (documentAttachments.length > 0) {
			const enriched = await enrichPromptWithDocuments(
				prompt,
				documentAttachments,
				options.documentEnrichmentOptions,
			);
			processedPrompt = enriched.enrichedPrompt;
			documentConfidence = enriched.confidenceAssessment;
		}
	}

	// Pre-process prompt for math and grounding.
	// When document enrichment was used, skip grounding to avoid double-injection
	// since document enrichment already includes grounding instructions.
	if (options.autoSolveMath !== false) {
		const modelArtifact = options.model ? {
			id: options.model.id,
			capabilities: options.model.capabilities,
		} : undefined;
		const mathResult = preProcessPrompt(processedPrompt, {
			model: modelArtifact,
			autoSolveMath: options.autoSolveMath ?? true,
			skipGrounding: documentConfidence !== null, // Skip if doc enrichment already added grounding
		});
		processedPrompt = mathResult.processedPrompt;
	}

	const subscription = options.onChunk
		? FolioExecuTorchEngineModule.addListener(
				"onGenerationChunk",
				(payload: NativeChatGenerationChunkEventPayload) => {
					if (payload.sessionId !== sessionId) {
						return;
					}

					options.onChunk?.(mapChatGenerationChunk(payload));
				},
			)
		: null;

	try {
		const imageAttachments = attachments.filter(
			(a): a is ChatAttachment & { type: "image" } => a.type === "image",
		);
		return mapChatGeneration(
			await FolioExecuTorchEngineModule.generateChatReplyAsync(
				sessionId,
				processedPrompt,
				modelLabel,
				imageAttachments.map(mapChatAttachment),
				history,
			),
		);
	} finally {
		subscription?.remove();
	}
}

export async function readTelemetry(): Promise<TelemetrySnapshot> {
	return mapTelemetry(
		await FolioExecuTorchEngineModule.getTelemetrySnapshotAsync(),
	);
}

function mapRuntimeInfo(runtimeInfo: NativeRuntimeInfo): RuntimeInfo {
	return {
		runtime: runtimeInfo.runtime,
		platform: runtimeInfo.platform,
		buildTarget: runtimeInfo.buildTarget,
		devClient: runtimeInfo.devClient,
		newArchitecture: runtimeInfo.newArchitecture,
		moduleVersion: runtimeInfo.moduleVersion,
	};
}

function mapBackend(backend: NativeBackendAvailability): BackendAvailability {
	return {
		id: backend.id,
		available: backend.available,
		source: backend.source,
		reason: backend.reason,
	};
}

function mapPreparedArtifact(
	artifact: NativePreparedArtifact,
): PreparedArtifact {
	return {
		artifactId: artifact.artifactId,
		localUri: artifact.localUri,
		sourceUri: artifact.sourceUri,
		verified: artifact.verified,
		cacheState: "miss",
	};
}

function mapSession(session: NativeSessionHandle): SessionHandle {
	return {
		sessionId: session.sessionId,
		artifactId: session.artifactId,
		backendId: session.backendId,
		status: session.status,
	};
}

function mapTelemetry(telemetry: NativeTelemetrySnapshot): TelemetrySnapshot {
	return {
		ttftMs: telemetry.ttftMs,
		decodeTokensPerSecond: telemetry.decodeTokensPerSecond,
		peakMemoryMb: telemetry.peakMemoryMb,
		queueDepth: telemetry.queueDepth,
		lastRoute: telemetry.lastRoute,
	};
}

function mapChatGeneration(
	result: NativeChatGenerationResult,
): ChatGenerationResult {
	return {
		sessionId: result.sessionId,
		backendId: result.backendId,
		text: result.text,
		tokensGenerated: result.tokensGenerated,
		turnIndex: result.turnIndex,
		finishReason: result.finishReason,
		telemetry: mapTelemetry(result.telemetry),
	};
}

function mapChatGenerationChunk(
	payload: NativeChatGenerationChunkEventPayload,
): ChatGenerationChunk {
	return {
		sessionId: payload.sessionId,
		chunkText: payload.chunkText,
		accumulatedText: payload.accumulatedText,
		tokensGenerated: payload.tokensGenerated,
	};
}

function mapRuntimeOptions(
	options: SessionRuntimeOptions,
): NativeSessionRuntimeOptions {
	return {
		supportsVision: options.supportsVision,
		inputModalities: options.inputModalities,
		promptTemplate: options.promptTemplate,
		temperature: options.generationParams.temperature,
		maxNewTokens: options.generationParams.maxNewTokens,
		maxSeqLen: options.generationParams.maxSeqLen,
	};
}

function mapChatAttachment(
	attachment: ChatAttachment & { type: "image" | "document" | "audio" },
): NativeChatAttachment {
	return {
		id: attachment.id,
		type: "image",
		name: attachment.name,
		localUri: attachment.localUri,
		mimeType: attachment.mimeType,
		source: attachment.source === "file" ? "file" : "camera",
		width: attachment.width,
		height: attachment.height,
	};
}

async function extractPackageIfNeeded(
	packageFile: File,
	destinationDirectory: Directory,
	packageFormat: ArtifactManifest["packageFormat"],
): Promise<void> {
	
	if (extractedArtifactDirectoryIsValid(destinationDirectory)) {
				return;
	}

	
	if (destinationDirectory.exists) {
				destinationDirectory.delete();
	}

		try {
		destinationDirectory.create({
			idempotent: true,
			intermediates: true,
		});
			} catch (createErr) {
				throw createErr;
	}

	if (!destinationDirectory.exists) {
		throw new Error(`Failed to create destination directory: ${destinationDirectory.uri}`);
	}

	if (packageFormat !== "zip") {
		throw new Error(
			`Artifact package format ${packageFormat} is not supported on mobile. Republish this artifact as zip.`,
		);
	}

	const { unzip } = require("react-native-zip-archive") as {
		unzip: (source: string, target: string) => Promise<string>;
	};

	try {
		const sourcePath = filesystemPathOf(packageFile.uri);
		const destPath = filesystemPathOf(destinationDirectory.uri);
				await unzip(sourcePath, destPath);
		
		// Detect if zip extracted to a single subdirectory (common pattern where the zip
		// bundles contents inside a named folder). If so, flatten by moving contents up.
		await flattenSingleSubdirectory(destinationDirectory);

		const entries = destinationDirectory.list();
		
		// CRITICAL: Verify the extraction actually produced files
		if (entries.length === 0) {
			throw new Error(`Extraction produced no files in ${destinationDirectory.uri}. The zip file may be empty or corrupt.`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Failed to extract ${packageFile.uri}: ${message}`);
	}

	const discoveredManifest =
		readExtractedArtifactManifest(destinationDirectory);
		if (!discoveredManifest) {
		throw new Error(
			`Extracted package for ${packageFile.uri} is missing a runnable .pte payload.`,
		);
	}

	if (
		!validateExtractedArtifactManifest(destinationDirectory, discoveredManifest)
	) {
		throw new Error(
			`Extracted package for ${packageFile.uri} is missing a runnable .pte payload.`,
		);
	}
}

async function flattenSingleSubdirectory(destinationDirectory: Directory): Promise<void> {
	const entries = destinationDirectory.list();
	if (entries.length !== 1 || !(entries[0] instanceof Directory)) {
		return;
	}

	const subdir = entries[0] as Directory;
	
	try {
		const subdirEntries = subdir.list();
		for (const entry of subdirEntries) {
			if (entry instanceof Directory) {
				const destDir = new Directory(new File(destinationDirectory, entry.name).uri);
				entry.move(destDir);
			} else {
				const destFile = new File(new File(destinationDirectory, entry.name).uri);
				(entry as File).move(destFile);
			}
		}
		// Remove the now-empty subdirectory
		subdir.delete();
			} catch (error) {
		// If flattening fails (e.g., name collision), log and continue without flattening.
		// The original subdirectory layout will be used as-is.
		console.warn(`[flattenSingleSubdirectory] failed to flatten: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function extractedArtifactDirectoryIsValid(directory: Directory): boolean {
	if (!directory.exists) {
		return false;
	}

	const manifest = readExtractedArtifactManifest(directory);
	if (!manifest) {
		// Fallback: if manifest is missing but .pte files exist, the artifact may have been
		// extracted with an older manifest format. Try to locate .pte files directly.
		if (hasAnyPteFile(directory)) {
			return true;
		}
		return false;
	}

	return validateExtractedArtifactManifest(directory, manifest);
}

function hasAnyPteFile(directory: Directory): boolean {
	try {
		const entries = directory.list();
		for (const entry of entries) {
			if (entry instanceof File && entry.name.toLowerCase().endsWith(".pte")) {
				return true;
			}
		}
	} catch {
		// Ignore list errors
	}
	return false;
}

function validateExtractedArtifactManifest(
	directory: Directory,
	manifest: ExtractedArtifactManifest,
): boolean {
	return (
		validateExtractedArtifactFile(directory, manifest.modelFile, (file) =>
			file.name.toLowerCase().endsWith(".pte"),
		) &&
		validateExtractedArtifactFile(
			directory,
			manifest.tokenizerFile,
			isTokenizerFile,
		)
	);
}

function validateExtractedArtifactFile(
	directory: Directory,
	relativePath: string,
	predicate: (file: File) => boolean,
): boolean {
	if (!relativePath) {
		return false;
	}

	const candidate = new File(directory, relativePath);
	return candidate.exists && predicate(candidate);
}

function readExtractedArtifactManifest(
	directory: Directory,
): ExtractedArtifactManifest | null {
	const manifestFile = new File(directory, "folio-export-manifest.json");
	const runtimeManifestFile = new File(
		directory,
		ARTIFACT_RUNTIME_MANIFEST_FILE,
	);
	const sourceFile = runtimeManifestFile.exists
		? runtimeManifestFile
		: manifestFile;
	if (!sourceFile.exists) {
		return null;
	}

	try {
		const parsed = JSON.parse(sourceFile.textSync()) as
			| Partial<ExtractedArtifactManifest>
			| { model_file?: string; tokenizer_file?: string };
		const modelFile =
			(parsed as Partial<ExtractedArtifactManifest>).modelFile ??
			(parsed as { model_file?: string }).model_file;
		const tokenizerFile =
			(parsed as Partial<ExtractedArtifactManifest>).tokenizerFile ??
			(parsed as { tokenizer_file?: string }).tokenizer_file;

		if (typeof modelFile !== "string" || typeof tokenizerFile !== "string") {
			console.warn(
				"[readExtractedArtifactManifest] manifest missing modelFile or tokenizerFile",
			);
			return null;
		}

		return {
			modelFile,
			tokenizerFile,
		};
	} catch (err) {
		console.warn(
			"[readExtractedArtifactManifest] failed to parse manifest JSON",
			err,
		);
		return null;
	}
}

function isTokenizerFile(file: File): boolean {
	const name = file.name.toLowerCase();
	return (
		name === "tokenizer.json" ||
		name === "tokenizer.model" ||
		name.startsWith("tokenizer.model.") ||
		name === "tokenizer.bin" ||
		name === "tokenizer_config.json" ||
		name.endsWith(".tiktoken") ||
		name.endsWith(".spm") ||
		name === "spiece.model" ||
		name === "sentencepiece.bpe.model"
	);
}

function filesystemPathOf(uri: string): string {
	if (!uri.startsWith("file://")) {
		throw new Error(`Expected a file URI, received: ${uri}`);
	}

	return decodeURIComponent(uri.slice("file://".length));
}

async function downloadArtifactPackage(
	sourceUri: string,
	manifest: ArtifactManifest,
	expectedPackageSizeBytes: number | null | undefined,
	localArtifactFile: File,
	markerFile: File,
	onProgress?: (progress: ArtifactPreparationProgress) => void,
	remainingRetries = ARTIFACT_DOWNLOAD_RETRIES,
): Promise<void> {
	const tempArtifactFile = ensureLocalArtifactTempFile(manifest);

	
	if (localArtifactFile.exists) {
		localArtifactFile.delete();
	}
	clearArtifactPackageMarker(markerFile);

	// Only delete temp file on fresh attempt, not retry — preserve partial downloads
	const shouldDeleteTemp = remainingRetries === ARTIFACT_DOWNLOAD_RETRIES;
	if (shouldDeleteTemp && tempArtifactFile.exists) {
		tempArtifactFile.delete();
	}

	// Download artifact
	const downloadTask = createDownloadResumable(
		sourceUri,
		tempArtifactFile.uri,
		{},
		(event: DownloadProgressData) => {
			const expectedBytes =
				event.totalBytesExpectedToWrite > 0
					? event.totalBytesExpectedToWrite
					: (expectedPackageSizeBytes ?? null);
			const ratio =
				expectedBytes && expectedBytes > 0
					? Math.min(event.totalBytesWritten / expectedBytes, 1)
					: 0;
			emitPreparationProgress(onProgress, {
				phase: "downloading",
				progress: 0.12 + ratio * 0.68,
				transferredBytes: event.totalBytesWritten,
				totalBytes: expectedBytes,
			});
		},
	);

	let downloadResult: Awaited<ReturnType<typeof downloadTask.downloadAsync>>;
	try {
		downloadResult = await downloadTask.downloadAsync();
	} catch (networkError) {
		const message =
			networkError instanceof Error
				? networkError.message
				: String(networkError);
		const isTransient =
			message.includes("network") ||
			message.includes("timeout") ||
			message.includes("aborted") ||
			message.includes("interrupted") ||
			message.includes("offline") ||
			message.includes("ENOTFOUND") ||
			message.includes("ECONNREFUSED") ||
			message.includes("ECONNRESET");

		if (isTransient && remainingRetries > 0) {
			emitPreparationProgress(onProgress, {
				phase: "downloading",
				progress: 0.12,
				transferredBytes: 0,
				totalBytes: expectedPackageSizeBytes ?? null,
			});
			await delay(
				ARTIFACT_DOWNLOAD_RETRY_DELAY_MS *
					(ARTIFACT_DOWNLOAD_RETRIES - remainingRetries + 1),
			);
			return downloadArtifactPackage(
				sourceUri,
				manifest,
				expectedPackageSizeBytes,
				localArtifactFile,
				markerFile,
				onProgress,
				remainingRetries - 1,
			);
		}
		throw new Error(
			`Download failed for ${manifest.artifactId}${isTransient ? " after retries" : ""}: ${message}`,
		);
	}

	if (!downloadResult) {
		throw new Error(`Download was cancelled for ${manifest.artifactId}.`);
	}

	const completedBytes = tempArtifactFile.size;
		emitPreparationProgress(onProgress, {
		phase: "downloading",
		progress: 0.8,
		transferredBytes: completedBytes,
		totalBytes: expectedPackageSizeBytes ?? completedBytes ?? null,
	});

	if (
		!downloadResponseLooksValid(
			downloadResult.status,
			downloadResult.mimeType,
			manifest,
			completedBytes,
			expectedPackageSizeBytes,
		)
	) {
		throw new Error(
			describeUnexpectedArtifactResponse(
				manifest,
				downloadResult.status,
				downloadResult.mimeType,
			),
		);
	}

	if (
		!downloadedArtifactFileIsComplete(
			tempArtifactFile,
			expectedPackageSizeBytes,
		)
	) {
		throw new Error(
			`Downloaded package for ${manifest.artifactId} did not pass local verification.`,
		);
	}

	if (localArtifactFile.exists) {
		localArtifactFile.delete();
	}

	try {
		tempArtifactFile.move(localArtifactFile);
	} catch (error) {
		if (!localArtifactFile.exists) {
			// localArtifactFile doesn't exist, but tempArtifactFile remains — clean it up
			try {
				tempArtifactFile.delete();
			} catch {
				// ignore cleanup failure
			}
			throw error;
		}

		try {
			localArtifactFile.delete();
		} catch {
			try {
				tempArtifactFile.delete();
			} catch {
				// ignore cleanup failure
			}
			throw error;
		}
		try {
			tempArtifactFile.move(localArtifactFile);
		} catch {
			try {
				tempArtifactFile.delete();
			} catch {
				// ignore cleanup failure
			}
			throw error;
		}
	}
	const computedHash = await computeSha256Hash(localArtifactFile);
	if (computedHash.toLowerCase() !== manifest.checksum.toLowerCase()) {
		// Clean up corrupted artifact file before throwing
		try {
			localArtifactFile.delete();
		} catch {
			// ignore cleanup failure
		}
		throw new Error(
			`SHA-256 checksum mismatch for artifact ${manifest.artifactId}: expected ${manifest.checksum}, got ${computedHash}. The downloaded file may be corrupted or tampered.`,
		);
	}
	writeArtifactPackageMarker(markerFile, {
		checksum: manifest.checksum,
		sourceKey: manifest.s3Key,
		packageFormat: manifest.packageFormat,
		sizeBytes: localArtifactFile.size,
	});
}

async function computeSha256Hash(file: File): Promise<string> {
	// expo-file-system does not have createReadStream, so we read the entire file
	// as base64 and convert to binary for hashing
	const base64 = await readAsStringAsync(file.uri, { encoding: "base64" });
	const binaryString = atob(base64);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	// Use Web Crypto API for SHA-256 (available in React Native)
	const hashBuffer = await crypto.subtle.digest("SHA-256", bytes.buffer);
	const hashArray = new Uint8Array(hashBuffer);
	const hashHex = Array.from(hashArray)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return hashHex;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function readArtifactPackageMarker(file: File): ArtifactPackageMarker | null {
	if (!file.exists) {
		return null;
	}

	try {
		const parsed = JSON.parse(
			file.textSync(),
		) as Partial<ArtifactPackageMarker>;
		if (
			typeof parsed.checksum !== "string" ||
			typeof parsed.sourceKey !== "string" ||
			(parsed.packageFormat !== "zip" && parsed.packageFormat !== "tar.gz") ||
			typeof parsed.sizeBytes !== "number" ||
			parsed.sizeBytes <= 0
		) {
			return null;
		}

		return {
			checksum: parsed.checksum,
			sourceKey: parsed.sourceKey,
			packageFormat: parsed.packageFormat,
			sizeBytes: parsed.sizeBytes,
		};
	} catch {
		return null;
	}
}

function writeArtifactPackageMarker(file: File, marker: ArtifactPackageMarker) {
	file.write(JSON.stringify(marker));
}

function clearArtifactPackageMarker(file: File) {
	if (file.exists) {
		file.delete();
	}
}

function downloadResponseLooksValid(
	status: number,
	mimeType: string | null,
	_manifest: ArtifactManifest,
	sizeBytes: number,
	expectedPackageSizeBytes?: number | null,
): boolean {
	if (status < 200 || status >= 300) {
		return false;
	}

	const normalizedMimeType = mimeType?.toLowerCase() ?? "";
	if (
		normalizedMimeType.startsWith("text/") ||
		normalizedMimeType.includes("json") ||
		normalizedMimeType.includes("xml") ||
		normalizedMimeType.includes("html")
	) {
		return false;
	}

	if (
		(!expectedPackageSizeBytes || expectedPackageSizeBytes <= 0) &&
		sizeBytes < MIN_ARTIFACT_PACKAGE_BYTES
	) {
		return false;
	}

	return true;
}

function describeUnexpectedArtifactResponse(
	manifest: ArtifactManifest,
	status: number,
	mimeType: string | null,
): string {
	const normalizedMimeType = mimeType?.toLowerCase() ?? "";
	if (status === 400 && normalizedMimeType.includes("xml")) {
		return `Artifact download for ${manifest.artifactId} was rejected by storage before the model package could be read. The published artifact URL is likely private or the catalog is missing an explicit public download URL.`;
	}

	return `Artifact download for ${manifest.artifactId} returned an unexpected response (HTTP ${status}, ${mimeType ?? "unknown type"}).`;
}

function emitPreparationProgress(
	onProgress: ((progress: ArtifactPreparationProgress) => void) | undefined,
	progress: ArtifactPreparationProgress,
) {
	onProgress?.({
		...progress,
		progress: Math.max(0, Math.min(progress.progress, 1)),
	});
}
