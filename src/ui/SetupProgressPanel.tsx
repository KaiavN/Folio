import React from "react";
import { Text, View } from "react-native";
import { ArtifactPreparationProgress, ModelArtifactDescriptor, PreparedArtifact, SessionHandle } from "../../src/engine/types.ts";
import ProgressBar from "./ProgressBar.tsx";
import { useColors } from "./colors.tsx";

interface SetupProgressPanelProps {
	installProgress: ArtifactPreparationProgress;
	session: SessionHandle | null | undefined;
	manifest: ModelArtifactDescriptor | null;
	featuredModelName: string;
	installedArtifact: PreparedArtifact | null;
	busyAction: string | null;
	isRuntimeBootstrapping: boolean;
}

function titleForInstallPhase(
	phase: ArtifactPreparationProgress["phase"],
	totalBytes?: number | null,
): string {
	switch (phase) {
		case "checking-cache":
			return "Checking what is already on this phone";
		case "downloading":
			return totalBytes
				? `Downloading ${formatFileSize(totalBytes)} to your phone`
				: "Downloading the model package";
		case "verifying-package":
			return "Verifying the download";
		case "extracting":
			return "Unpacking the runtime files";
		case "starting-session":
			return "Starting the local model";
		case "ready":
			return "Ready to chat";
	}
}

function detailForInstallPhase(
	phase: ArtifactPreparationProgress["phase"],
	transferredBytes?: number,
	totalBytes?: number | null,
): string {
	switch (phase) {
		case "checking-cache":
			return "Folio checks local storage first so it only downloads what this phone still needs.";
		case "downloading":
			return totalBytes
				? `${formatTransferProgress(transferredBytes, totalBytes)} downloaded. Smaller models are usually easier to run smoothly across more phones.`
				: "The model is being copied into local storage so it can run without sending your prompts away.";
		case "verifying-package":
			return "The package is on-device now. Folio is validating it before it becomes available to the runtime.";
		case "extracting":
			return "The downloaded archive is being expanded into the runnable local artifact.";
		case "starting-session":
			return "The model has landed on the device. Folio is now creating the live session and warming the selected backend.";
		case "ready":
			return "Everything is loaded and the chat surface is ready.";
	}
}

function shortInstallPhaseLabel(
	phase: ArtifactPreparationProgress["phase"],
): string {
	switch (phase) {
		case "checking-cache":
			return "Checking";
		case "downloading":
			return "Downloading";
		case "verifying-package":
			return "Verifying";
		case "extracting":
			return "Unpacking";
		case "starting-session":
			return "Starting";
		case "ready":
			return "Ready";
	}
}

function formatTransferProgress(
	transferredBytes?: number,
	totalBytes?: number | null,
): string {
	if (!transferredBytes && !totalBytes) {
		return "Preparing download";
	}
	if (!totalBytes || totalBytes <= 0) {
		return `${formatFileSize(transferredBytes ?? 0)} downloaded`;
	}
	return `${formatFileSize(transferredBytes ?? 0)} / ${formatFileSize(totalBytes)}`;
}

function formatFileSize(bytes: number): string {
	if (bytes >= 1024 * 1024 * 1024) {
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	}
	if (bytes >= 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
	}
	if (bytes >= 1024) {
		return `${(bytes / 1024).toFixed(0)} KB`;
	}
	return `${bytes} B`;
}

export default function SetupProgressPanel({
	installProgress,
	session,
	manifest,
	featuredModelName,
	installedArtifact,
	busyAction,
	isRuntimeBootstrapping,
}: SetupProgressPanelProps) {
	const COLORS = useColors();

	const usedLocalCache = installedArtifact?.cacheState === "checkpoint";
	const downloadRatio =
		installProgress.transferredBytes !== undefined && installProgress.totalBytes !== undefined
			? installProgress.totalBytes > 0
				? installProgress.transferredBytes / installProgress.totalBytes
				: 0
			: 0;

	const transferBarProgress =
		session?.status === "ready"
			? 1
			: isRuntimeBootstrapping
				? 0.04
				: installProgress.phase === "checking-cache"
					? 0.05
					: installProgress.phase === "downloading"
						? 0.12 + downloadRatio * 0.56
						: installProgress.phase === "verifying-package"
							? 0.76
							: installProgress.phase === "extracting"
								? 0.9
								: 0.97;

	const setupStageIndex = isRuntimeBootstrapping
		? 0
		: installProgress.phase === "checking-cache"
			? 0
			: installProgress.phase === "downloading"
				? 1
				: installProgress.phase === "verifying-package"
					? 2
					: installProgress.phase === "extracting"
						? 3
						: 4;

	const installStageTitle = titleForInstallPhase(
		installProgress.phase,
		manifest?.packageSizeBytes,
	);
	const installStageDetail = detailForInstallPhase(
		installProgress.phase,
		installProgress.transferredBytes,
		installProgress.totalBytes ?? manifest?.packageSizeBytes ?? null,
	);

	const progressEyebrow =
		session?.status === "ready"
			? usedLocalCache
				? "Ready from local cache"
				: "Ready"
			: isRuntimeBootstrapping
				? "Checking this device first"
				: installProgress.phase === "checking-cache"
					? "Checking what is already on this phone"
					: installProgress.phase === "downloading"
						? "Downloading with live progress"
						: installProgress.phase === "verifying-package"
							? "Download complete"
							: installProgress.phase === "extracting"
								? "Unpacking locally"
								: "Launching the local runtime";

	const styles = {
		panel: {
			gap: 16,
			padding: 20,
			borderRadius: 22,
			backgroundColor: "rgba(26, 23, 19, 0.94)",
		},
		topZone: {
			gap: 8,
		},
		headerRow: {
			flexDirection: "row" as const,
			alignItems: "flex-start" as const,
			justifyContent: "space-between" as const,
			gap: 12,
		},
		copyGroup: {
			flex: 1,
			gap: 2,
		},
		eyebrow: {
			color: COLORS.accentWarm,
			fontSize: 11,
			fontWeight: "800" as const,
			textTransform: "uppercase" as const,
			letterSpacing: 1,
		},
		title: {
			color: COLORS.textPrimary,
			fontSize: 16,
			fontWeight: "800" as const,
			lineHeight: 22,
		},
		meta: {
			color: "#E7D7C0",
			fontSize: 12,
			fontWeight: "800" as const,
		},
		bottomZone: {
			gap: 12,
			borderTopWidth: 1,
			borderTopColor: COLORS.border,
			paddingTop: 16,
		},
		stageRail: {
			flexDirection: "row" as const,
			flexWrap: "wrap" as const,
			gap: 8,
		},
		stageChip: {
			backgroundColor: COLORS.bgSubtleMid,
			borderRadius: 999,
			paddingHorizontal: 10,
			paddingVertical: 6,
		},
		stageChipActive: {
			backgroundColor: COLORS.accentPrimary,
		},
		stageChipDone: {
			backgroundColor: "rgba(199, 214, 161, 0.22)",
		},
		stageChipText: {
			color: COLORS.textPrimary,
			fontSize: 11,
			fontWeight: "800" as const,
		},
		stageChipTextStrong: {
			color: "#2A211A",
		},
		bodyText: {
			color: COLORS.textSecondary,
			fontSize: 12,
			lineHeight: 17,
			marginTop: 2,
		},
	};

	return (
		<View
			style={styles.panel}
			accessible
			accessibilityRole="progressbar"
			accessibilityLiveRegion="polite"
			accessibilityLabel={
				session?.status === "ready"
					? "Model setup complete"
					: isRuntimeBootstrapping
						? "Model setup is checking this device"
						: installProgress.phase === "downloading"
							? `Model download ${Math.round(downloadRatio * 100)} percent complete`
							: `Model setup ${shortInstallPhaseLabel(installProgress.phase)}`
			}
			accessibilityValue={
				installProgress.phase === "downloading"
					? {
							min: 0,
							max: 100,
							now: Math.round(downloadRatio * 100),
						}
					: undefined
			}
		>
			{/* Top zone: eyebrow + title + meta */}
			<View style={styles.topZone}>
				<View style={styles.headerRow}>
					<View style={styles.copyGroup}>
						<Text style={styles.eyebrow}>{progressEyebrow}</Text>
						<Text
							style={styles.title}
							numberOfLines={2}
							ellipsizeMode="tail"
						>
							{session?.status === "ready"
								? usedLocalCache
									? `${featuredModelName} is already on this device`
									: `${featuredModelName} is ready`
								: isRuntimeBootstrapping
									? "Checking what this phone can run"
									: installStageTitle}
						</Text>
					</View>
					<Text style={styles.meta}>
						{session?.status === "ready"
							? "100%"
							: isRuntimeBootstrapping
								? "Checking"
								: installProgress.phase === "downloading"
									? `${Math.round(downloadRatio * 100)}%`
									: shortInstallPhaseLabel(installProgress.phase)}
					</Text>
				</View>
			</View>

			{/* Bottom zone: progress bar + chip rail + body text */}
			<View style={styles.bottomZone}>
				<ProgressBar progress={transferBarProgress} />
				<View style={styles.stageRail}>
					{["Check", "Download", "Verify", "Unpack", "Launch"].map(
						(label, index) => {
							const isDone =
								session?.status === "ready" || index < setupStageIndex;
							const isActive =
								session?.status !== "ready" && index === setupStageIndex;
							return (
								<View
									key={label}
									style={[
										styles.stageChip,
										isActive ? styles.stageChipActive : null,
										isDone ? styles.stageChipDone : null,
									]}
								>
									<Text
										style={[
											styles.stageChipText,
											isActive || isDone
												? styles.stageChipTextStrong
												: null,
										]}
									>
										{label}
									</Text>
								</View>
							);
						},
					)}
				</View>
				<Text style={styles.bodyText}>
					{session?.status === "ready"
						? usedLocalCache
							? "Folio found a prepared local copy and opened it without another download."
							: "Everything is prepared locally. You can move into chat whenever you are ready."
						: isRuntimeBootstrapping
							? "Folio is confirming the safest local runtime path for this phone before it commits to download and launch."
							: installProgress.phase === "downloading"
								? `${formatTransferProgress(
										installProgress.transferredBytes,
										installProgress.totalBytes ??
											manifest?.packageSizeBytes ??
											null,
									)} downloaded`
								: installStageDetail}
				</Text>
			</View>
		</View>
	);
}