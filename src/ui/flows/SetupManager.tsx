import React, { useEffect, useRef, useState } from "react";
import {
	Animated,
	Easing,
	Platform,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";

import {
	buildArtifactManifest,
	validateArtifactManifest,
} from "../../engine/artifacts.ts";
import {
	getPreviewDeviceForRuntime,
	MODEL_ARTIFACTS,
} from "../../engine/catalog.ts";
import { formatModelDisplayName } from "../../engine/display.ts";
import {
	getAvailableArtifactCandidates,
	resolveBackendRoute,
} from "../../engine/router.ts";
import {
	bootstrapRuntime,
	cancelSession,
	createSession,
	prepareArtifact,
	pruneIOSFallbackBackendArtifact,
} from "../../engine/runtime.ts";
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
	SessionRuntimeOptions,
	TelemetrySnapshot,
} from "../../engine/types.ts";
import { appStyles } from "../App.styles.ts";
import {
	runImpactHaptic,
	runNotificationHaptic,
} from "../haptics.ts";

export type OnboardingStage = "select-model" | "overview" | "waiting" | "chat";

export interface SetupState {
	catalogModels: ModelArtifactDescriptor[];
	selectedArtifact: ModelArtifactDescriptor;
	featuredArtifact: ModelArtifactDescriptor;
	featuredModelName: string;
	isArtifactInstalled: boolean;
	hasStartedSetup: boolean;
	onboardingStage: OnboardingStage;
	session: SessionHandle | null;
	preparedArtifact: PreparedArtifact | null;
	installedArtifact: PreparedArtifact | null;
	busyAction: string | null;
	isRuntimeBootstrapping: boolean;
	installProgress: ArtifactPreparationProgress;
	manifest: ReturnType<typeof buildArtifactManifest>;
	manifestValidation: ReturnType<typeof validateArtifactManifest>;
	errorMessage: string | null;
	runtimeInfo: RuntimeInfo | null;
	previewDevice: ReturnType<typeof getPreviewDeviceForRuntime>;
	availableBackends: BackendAvailability[];
	routingDecision: RoutingDecision;
}

export interface SetupActions {
	setHasStartedSetup: (started: boolean) => void;
	setOnboardingStage: (stage: OnboardingStage) => void;
	setSetupArtifact: (artifact: ModelArtifactDescriptor | null) => void;
	setForcedFallbackArtifact: (artifact: BackendArtifactDescriptor | null) => void;
	setFallbackOffer: (offer: { preferredBackendName: string; fallbackArtifact: BackendArtifactDescriptor } | null) => void;
	setSession: (session: SessionHandle | null) => void;
	setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
	setErrorMessage: (error: string | null) => void;
	setInstallProgress: React.Dispatch<React.SetStateAction<ArtifactPreparationProgress>>;
	setSetupAttemptKey: React.Dispatch<React.SetStateAction<number>>;
	setInstalledPreparedArtifact: (artifact: PreparedArtifact | null) => void;
	setBusyAction: (action: string | null) => void;
	setRuntimeInfo: (info: RuntimeInfo | null) => void;
	setAvailableBackends: (backends: BackendAvailability[]) => void;
	setTelemetry: (telemetry: TelemetrySnapshot | null) => void;
	setPreparedArtifact: (artifact: PreparedArtifact | null) => void;
}

/**
 * Custom hook for managing model setup and activation flow.
 * Handles artifact checking, installation progress, and session management.
 */
export function useSetupManager(
	state: SetupState,
	actions: SetupActions,
) {
	const lastSetupErrorRef = useRef<"network" | "other" | null>(null);
	const didCheckArtifactRef = useRef(false);
	const lastInstallPhaseRef = useRef<ArtifactPreparationProgress["phase"] | null>(null);
	const lastReadySessionIdRef = useRef<string | null>(null);
	const lastErrorMessageRef = useRef<string | null>(null);

	// Haptic: session ready
	useEffect(() => {
		if (Platform.OS === "web") return;
		if (state.session?.status === "ready") {
			if (lastReadySessionIdRef.current !== state.session.sessionId) {
				lastReadySessionIdRef.current = state.session.sessionId;
				runNotificationHaptic("success");
			}
			return;
		}
		lastReadySessionIdRef.current = null;
	}, [state.session?.sessionId, state.session?.status]);

	// Haptic: error
	useEffect(() => {
		if (Platform.OS === "web") return;
		if (state.errorMessage && state.errorMessage !== lastErrorMessageRef.current) {
			lastErrorMessageRef.current = state.errorMessage;
			runNotificationHaptic("error");
			return;
		}
		if (!state.errorMessage) {
			lastErrorMessageRef.current = null;
		}
	}, [state.errorMessage]);

	// Haptic: install phase changes
	useEffect(() => {
		if (!state.hasStartedSetup) {
			lastInstallPhaseRef.current = null;
			return;
		}
		if (Platform.OS === "web") return;
		if (lastInstallPhaseRef.current === state.installProgress.phase) return;
		const previousPhase = lastInstallPhaseRef.current;
		lastInstallPhaseRef.current = state.installProgress.phase;
		if (!previousPhase) return;
		if (
			state.installProgress.phase === "verifying-package" ||
			state.installProgress.phase === "extracting" ||
			state.installProgress.phase === "starting-session"
		) {
			runImpactHaptic("light");
		}
	}, [state.hasStartedSetup, state.installProgress.phase]);

	return {};
}