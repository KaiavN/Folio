import React, { useMemo } from "react";
import {
	Modal,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
} from "react-native";

import type { ModelArtifactDescriptor } from "../engine/types.ts";
import { formatModelDisplayName } from "../engine/display.ts";
import { useColors } from "./colors.tsx";

interface ModelPickerProps {
	open: boolean;
	models: ModelArtifactDescriptor[];
	featuredArtifactId: string;
	catalogErrorMessage: string | null;
	selectedArtifactId: string;
	onClose: () => void;
	onSelect: (artifactId: string) => void;
}

const CAPABILITY_LABELS: Record<string, string> = {
	fastStartup: "Fast",
	coding: "Code",
	vision: "Vision",
	longContext: "Long Ctx",
	math: "Math",
	reasoning: "Reasoning",
};

export function ModelPicker({
	open,
	models,
	featuredArtifactId,
	catalogErrorMessage,
	selectedArtifactId,
	onClose,
	onSelect,
}: ModelPickerProps) {
	const COLORS = useColors();
	const { width: screenWidth } = useWindowDimensions();
	const isTablet = screenWidth >= 680;

	function isModelAvailable(model: ModelArtifactDescriptor): boolean {
		return model.artifacts.length > 0;
	}

	function isSelected(model: ModelArtifactDescriptor): boolean {
		return model.id === selectedArtifactId;
	}

	const sortedModels = useMemo(() => {
		return [...models].sort((a, b) => {
			const aAvail = isModelAvailable(a) ? 1 : 0;
			const bAvail = isModelAvailable(b) ? 1 : 0;
			if (aAvail !== bAvail) return bAvail - aAvail;
			const aFeatured = a.id === featuredArtifactId ? 1 : 0;
			const bFeatured = b.id === featuredArtifactId ? 1 : 0;
			return bFeatured - aFeatured;
		});
	}, [models, featuredArtifactId]);

	return (
		<Modal
			transparent
			visible={open}
			animationType="slide"
			onRequestClose={onClose}
		>
			<View
				style={[
					styles.modalBackdrop,
					isTablet ? styles.modalBackdropTablet : null,
				]}
			>
				<Pressable
					style={StyleSheet.absoluteFill}
					onPress={onClose}
					accessibilityRole="button"
					accessibilityLabel="Close model picker"
				/>
				<View
					style={[styles.modalSheet, isTablet ? styles.modalSheetTablet : null]}
				>
					<View style={styles.modalHeader}>
						<Text style={styles.modalTitle}>Choose a model</Text>
						<Text
							style={styles.modalSubtitle}
							numberOfLines={3}
							ellipsizeMode="tail"
						>
							Pick the model that fits your device. Smaller models run faster
							and use less battery.
						</Text>
					</View>

					<ScrollView contentContainerStyle={styles.modalContent}>
						{catalogErrorMessage ? (
							<Text style={styles.modalErrorText}>{catalogErrorMessage}</Text>
						) : null}
						{sortedModels.length === 0 && !catalogErrorMessage ? (
							<View
								style={styles.emptyState}
								accessibilityRole="alert"
								accessibilityLiveRegion="polite"
							>
								<Text style={styles.emptyStateText}>
									No models available
								</Text>
							</View>
						) : null}
						{sortedModels.map((model) => {
							const available = isModelAvailable(model);
							const selected = isSelected(model);
							const backends = model.compatibleBackends;
							const visibleBackends = backends.slice(0, 2);
							const extraBackendCount = backends.length - 2;
							const capabilities = model.capabilities ?? [];
							const visibleCapabilities = capabilities.slice(0, 2);

							return (
								<Pressable
									key={model.id}
									onPress={() => available && onSelect(model.id)}
									disabled={!available}
									accessibilityRole="button"
									accessibilityLabel={`Select ${formatModelDisplayName(model)}`}
									accessibilityState={{ disabled: !available, selected }}
									style={({ pressed }) => [
										styles.modelOption,
										selected && styles.modelOptionSelected,
										!available && styles.modelOptionDisabled,
										pressed && available && styles.buttonPressed,
									]}
								>
									<View
										style={[
											styles.modelOptionAccent,
											selected
												? styles.modelOptionAccentSelected
												: available
													? styles.modelOptionAccentAvailable
													: styles.modelOptionAccentMuted,
										]}
									/>
									<View style={styles.modelOptionContent}>
										<View style={styles.modelOptionTopRow}>
											<View style={styles.modelOptionTitleBlock}>
												<Text
													style={styles.modelOptionTitle}
													numberOfLines={1}
													ellipsizeMode="tail"
												>
													{formatModelDisplayName(model)}
												</Text>
												<View style={styles.modelOptionMetaRow}>
													<View style={styles.modelSizeBadge}>
														<Text style={styles.modelSizeBadgeText}>
															{model.sizeLabel}
														</Text>
													</View>
													<Text style={styles.modelOptionSizeText}>
														~{model.estimatedSizeGb} GB
													</Text>
												</View>
											</View>
											<View style={styles.modelOptionRight}>
												{selected ? (
													<View style={styles.modelCheckCircle}>
														<Text style={styles.modelCheckMark}>✓</Text>
													</View>
												) : available ? (
													<Text style={styles.modelOptionActionText}>
														Download →
													</Text>
												) : (
													<View style={styles.modelSoonBadge}>
														<Text style={styles.modelSoonBadgeText}>Soon</Text>
													</View>
												)}
											</View>
										</View>
										<View style={styles.modelBackendRow}>
											{visibleBackends.map((backend) => (
												<View
													key={backend}
													style={[
														styles.modelBackendChip,
														selected && styles.modelBackendChipSelected,
													]}
												>
													<Text
														style={[
															styles.modelBackendChipText,
															selected && styles.modelBackendChipTextSelected,
														]}
													>
														{backend}
													</Text>
												</View>
											))}
											{extraBackendCount > 0 ? (
												<View
													style={[
														styles.modelBackendChip,
														selected && styles.modelBackendChipSelected,
													]}
												>
													<Text
														style={[
															styles.modelBackendChipText,
															selected && styles.modelBackendChipTextSelected,
														]}
													>
														+{extraBackendCount} more
													</Text>
												</View>
											) : null}
										</View>
										{visibleCapabilities.length ? (
											<View style={styles.modelCapabilityRow}>
												{visibleCapabilities.map((cap) => (
													<View key={cap} style={styles.modelCapabilityChip}>
														<Text style={styles.modelCapabilityChipText}>
															{CAPABILITY_LABELS[cap] ?? cap}
														</Text>
													</View>
												))}
											</View>
										) : null}
										<Text
											style={styles.modelOptionNote}
											numberOfLines={2}
											ellipsizeMode="tail"
										>
											{model.notes[0]}
										</Text>
									</View>
								</Pressable>
							);
						})}
					</ScrollView>
				</View>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	modalBackdrop: {
		flex: 1,
		justifyContent: "flex-end",
		backgroundColor: "rgba(0, 0, 0, 0.5)",
	},
	modalBackdropTablet: {
		justifyContent: "center",
	},
	modalSheet: {
		backgroundColor: "#151310",
		borderTopLeftRadius: 24,
		borderTopRightRadius: 24,
		paddingTop: 16,
		paddingBottom: 40,
		maxHeight: "88%",
	},
	modalSheetTablet: {
		width: "100%",
		maxWidth: 560,
		maxHeight: "82%",
		borderRadius: 24,
		marginBottom: 0,
	},
	modalHeader: {
		gap: 6,
		paddingHorizontal: 20,
	},
	modalTitle: {
		color: "#F6F1E8",
		fontSize: 22,
		fontWeight: "800",
	},
	modalSubtitle: {
		color: "#B8B0A2",
		fontSize: 14,
		lineHeight: 20,
		flexShrink: 1,
	},
	modalContent: {
		gap: 12,
		paddingHorizontal: 20,
		paddingTop: 16,
	},
	modalErrorText: {
		color: "#FCA5A5",
		fontSize: 13,
		lineHeight: 18,
	},
	emptyState: {
		padding: 20,
		alignItems: "center",
	},
	emptyStateText: {
		color: "#9F9586",
		fontSize: 14,
		textAlign: "center",
	},
	modelOption: {
		flexDirection: "row",
		backgroundColor: "#1B1815",
		borderRadius: 18,
		overflow: "hidden",
	},
	modelOptionSelected: {
		backgroundColor: "#252019",
	},
	modelOptionDisabled: {
		opacity: 0.55,
	},
	buttonPressed: {
		opacity: 0.75,
	},
	modelOptionAccent: {
		width: 4,
	},
	modelOptionAccentAvailable: {
		backgroundColor: "#C9B08E",
	},
	modelOptionAccentSelected: {
		backgroundColor: "#E7D7C0",
	},
	modelOptionAccentMuted: {
		backgroundColor: "rgba(215, 193, 162, 0.15)",
	},
	modelOptionContent: {
		flex: 1,
		padding: 16,
		gap: 12,
	},
	modelOptionTopRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "flex-start",
		gap: 10,
	},
	modelOptionTitleBlock: {
		flex: 1,
		gap: 6,
		minWidth: 0,
	},
	modelOptionTitle: {
		color: "#F6F1E8",
		fontSize: 16,
		fontWeight: "800",
		lineHeight: 21,
	},
	modelOptionMetaRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	modelSizeBadge: {
		backgroundColor: "rgba(231, 215, 192, 0.1)",
		borderRadius: 6,
		paddingHorizontal: 8,
		paddingVertical: 4,
	},
	modelSizeBadgeText: {
		color: "#D7C1A2",
		fontSize: 12,
		fontWeight: "800",
	},
	modelOptionSizeText: {
		color: "#9F9586",
		fontSize: 12,
		fontWeight: "700",
	},
	modelOptionRight: {
		alignItems: "flex-end",
		justifyContent: "center",
		minHeight: 36,
	},
	modelCheckCircle: {
		width: 26,
		height: 26,
		borderRadius: 13,
		backgroundColor: "#E7D7C0",
		alignItems: "center",
		justifyContent: "center",
	},
	modelCheckMark: {
		color: "#231B14",
		fontSize: 14,
		fontWeight: "800",
	},
	modelOptionActionText: {
		color: "#C9B08E",
		fontSize: 13,
		fontWeight: "700",
	},
	modelSoonBadge: {
		backgroundColor: "rgba(255, 248, 235, 0.08)",
		borderRadius: 999,
		paddingHorizontal: 12,
		paddingVertical: 6,
	},
	modelSoonBadgeText: {
		color: "#9F9586",
		fontSize: 11,
		fontWeight: "800",
		textTransform: "uppercase",
		letterSpacing: 0.5,
	},
	modelBackendRow: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 6,
	},
	modelBackendChip: {
		backgroundColor: "rgba(231, 215, 192, 0.07)",
		borderRadius: 6,
		paddingHorizontal: 8,
		paddingVertical: 4,
	},
	modelBackendChipSelected: {
		backgroundColor: "rgba(231, 215, 192, 0.16)",
	},
	modelBackendChipText: {
		color: "#B8B0A2",
		fontSize: 11,
		fontWeight: "700",
		textTransform: "uppercase",
		letterSpacing: 0.5,
	},
	modelBackendChipTextSelected: {
		color: "#E7DED1",
	},
	modelCapabilityRow: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 5,
		marginTop: 6,
	},
	modelCapabilityChip: {
		backgroundColor: "rgba(214, 255, 95, 0.08)",
		borderRadius: 6,
		paddingHorizontal: 7,
		paddingVertical: 3,
	},
	modelCapabilityChipText: {
		color: "#D6FF5F",
		fontSize: 11,
		fontWeight: "700",
	},
	modelOptionNote: {
		color: "#AFA597",
		fontSize: 12,
		lineHeight: 17,
		marginTop: 8,
	},
});