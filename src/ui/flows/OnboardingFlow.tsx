import React, { useEffect, useMemo, useRef, useState } from "react";
import {
	ActivityIndicator,
	Animated,
	Easing,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import {
	buildArtifactManifest,
} from "../../engine/artifacts.ts";
import {
	getPreviewDeviceForRuntime,
	MODEL_ARTIFACTS,
} from "../../engine/catalog.ts";
import { formatModelDisplayName } from "../../engine/display.ts";
import { resolveBackendRoute } from "../../engine/router.ts";
import type {
	ArtifactPreparationProgress,
	BackendArtifactDescriptor,
	BackendAvailability,
	ChatMessage,
	ModelArtifactDescriptor,
	PreparedArtifact,
	RoutingDecision,
	RuntimeInfo,
	SessionHandle,
} from "../../engine/types.ts";
import { appStyles } from "../App.styles.ts";
import { runSelectionHaptic } from "../haptics.ts";
import { OnboardingHero } from "../OnboardingHero.tsx";
import { ModelSelectionCard } from "../ModelSelectionCard.tsx";
import SetupProgressPanel from "../SetupProgressPanel.tsx";
import { SetupArcade } from "../SetupArcade.tsx";
import type { OnboardingStage } from "./SetupManager";

export interface OnboardingFlowState {
	catalogModels: ModelArtifactDescriptor[];
	catalogLoading: boolean;
	catalogErrorMessage: string | null;
	featuredArtifact: ModelArtifactDescriptor;
	featuredModelName: string;
	isArtifactInstalled: boolean;
	hasStartedSetup: boolean;
	onboardingStage: OnboardingStage;
	session: SessionHandle | null;
	installedArtifact: PreparedArtifact | null;
	busyAction: string | null;
	isRuntimeBootstrapping: boolean;
	installProgress: ArtifactPreparationProgress;
	manifest: ReturnType<typeof buildArtifactManifest>;
	errorMessage: string | null;
	isIosSimulator: boolean;
	simulatorHint: string | null;
	selectionIntroCopy: string;
	selectionFooterMeta: string;
	shouldShowSimulatorHint: boolean;
}

export interface OnboardingFlowActions {
	onStartFeaturedSetup: () => void;
	onRetrySetup: () => void;
	onFinishInformationFlow: () => void;
	onSetOnboardingStage: (stage: OnboardingStage) => void;
	onSetIsArcadeExpanded: (expanded: boolean) => void;
}

/**
 * Custom hook for onboarding flow UI rendering.
 * Returns the onboarding content based on current stage.
 */
export function useOnboardingFlow(
	state: OnboardingFlowState,
	actions: OnboardingFlowActions,
) {
	const styles = appStyles;
	const [isArcadeExpanded, setIsArcadeExpanded] = useState(false);

	function renderSetupErrorCard() {
		if (!state.errorMessage) {
			return null;
		}

		return (
			<View style={styles.inlineErrorCard}>
				<Text style={styles.errorText}>{state.errorMessage}</Text>
				<Pressable
					onPress={actions.onRetrySetup}
					accessibilityRole="button"
					accessibilityLabel="Retry model setup"
					style={({ pressed }) => [
						styles.secondaryActionButton,
						pressed ? styles.buttonPressed : null,
					]}
				>
					<Text style={styles.secondaryActionText}>Try again</Text>
				</Pressable>
			</View>
		);
	}

	function renderSelectModelStage() {
		return (
			<View style={styles.stageStack}>
				<OnboardingHero
					eyebrow="Private AI on your phone"
					title="Choose your model"
					intro={state.selectionIntroCopy}
				/>

				<ModelSelectionCard
					modelName={state.featuredModelName}
					sizeLabel={state.featuredArtifact.sizeLabel}
					estimatedSizeGb={state.featuredArtifact.estimatedSizeGb}
					isInstalled={state.isArtifactInstalled}
					footerMeta={state.selectionFooterMeta}
					onSelect={actions.onStartFeaturedSetup}
				/>

				{state.catalogLoading && !state.catalogErrorMessage ? (
					<ActivityIndicator size="small" color="#F6F1E8" />
				) : null}
				{state.catalogErrorMessage ? (
					<Text style={styles.inlineNote}>{state.catalogErrorMessage}</Text>
				) : null}
				{!state.catalogLoading && !state.catalogModels.length && !state.catalogErrorMessage ? (
					<Text style={styles.inlineNote}>No models available</Text>
				) : null}
			</View>
		);
	}

	function renderOverviewStage() {
		return (
			<View style={styles.stageStack}>
				<View style={styles.infoStageHeader}>
					<View style={styles.infoStageMetaRow}>
						<Text style={styles.wizardStepLabel}>Quick setup guide</Text>
						{state.session?.status === "ready" ? (
							<Pressable
								onPress={() => {
									runSelectionHaptic();
									actions.onSetOnboardingStage("chat");
								}}
								accessibilityRole="button"
								accessibilityLabel="Open chat now"
								style={({ pressed }) => [
									pressed ? styles.buttonPressed : null,
								]}
							>
								<Text style={styles.inlineActionText}>Open chat now</Text>
							</Pressable>
						) : null}
					</View>
				</View>

				<SetupProgressPanel
					installProgress={state.installProgress}
					session={state.session}
					manifest={state.featuredArtifact}
					featuredModelName={state.featuredModelName}
					installedArtifact={state.installedArtifact}
					busyAction={state.busyAction}
					isRuntimeBootstrapping={state.isRuntimeBootstrapping}
				/>

				{state.shouldShowSimulatorHint ? (
					<Text style={styles.quietNote}>{state.simulatorHint}</Text>
				) : null}
				{renderSetupErrorCard()}

				<Pressable
					onPress={actions.onFinishInformationFlow}
					accessibilityRole="button"
					accessibilityLabel={
						state.session?.status === "ready" ? "Open chat" : "Play while you wait"
					}
					style={({ pressed }) => [
						styles.primaryActionButton,
						pressed ? styles.buttonPressed : null,
					]}
				>
					<Text style={styles.primaryActionText}>
						{state.session?.status === "ready"
							? "Open chat"
							: "Play while you wait"}
					</Text>
				</Pressable>
			</View>
		);
	}

	function renderWaitingStage() {
		return (
			<View style={styles.stageStack}>
				<View style={styles.waitingHero}>
					<Text style={styles.selectionEyebrow}>
						Setup continues in the background
					</Text>
					<Text style={styles.selectionTitle}>
						{state.session?.status === "ready"
							? "Your model is ready"
							: "Almost there"}
					</Text>
				</View>

				<SetupProgressPanel
					installProgress={state.installProgress}
					session={state.session}
					manifest={state.featuredArtifact}
					featuredModelName={state.featuredModelName}
					installedArtifact={state.installedArtifact}
					busyAction={state.busyAction}
					isRuntimeBootstrapping={state.isRuntimeBootstrapping}
				/>

				{state.session?.status === "ready" ? (
					<View style={styles.dualActionRow}>
						<Pressable
							onPress={() => {
								runSelectionHaptic();
								actions.onSetOnboardingStage("chat");
							}}
							accessibilityRole="button"
							accessibilityLabel="Open chat"
							style={({ pressed }) => [
								styles.primaryActionButton,
								pressed ? styles.buttonPressed : null,
							]}
						>
							<Text style={styles.primaryActionText}>Open chat</Text>
						</Pressable>
					</View>
				) : (
					<>
						<Pressable
							onPress={() => {
								runSelectionHaptic();
								setIsArcadeExpanded((current) => !current);
							}}
							accessibilityRole="button"
							accessibilityState={{ expanded: isArcadeExpanded }}
							accessibilityLabel={
								isArcadeExpanded ? "Hide mini games" : "Show mini games"
							}
							style={({ pressed }) => [
								styles.secondaryActionButton,
								pressed ? styles.buttonPressed : null,
							]}
						>
							<Text style={styles.secondaryActionText}>
								{isArcadeExpanded ? "Hide mini games" : "Play while you wait"}
							</Text>
						</Pressable>
						{isArcadeExpanded ? (
							<View style={styles.arcadeSection}>
								<SetupArcade />
							</View>
						) : null}
					</>
				)}

				{state.shouldShowSimulatorHint ? (
					<Text style={styles.quietNote}>{state.simulatorHint}</Text>
				) : null}
				{renderSetupErrorCard()}
			</View>
		);
	}

	function renderOnboardingContent() {
		if (!state.hasStartedSetup) {
			return renderSelectModelStage();
		}

		if (state.onboardingStage === "overview") {
			return renderOverviewStage();
		}

		return renderWaitingStage();
	}

	return {
		renderOnboardingContent,
		isArcadeExpanded,
		setIsArcadeExpanded,
	};
}