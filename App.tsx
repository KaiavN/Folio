import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { StatusBar } from "expo-status-bar";
import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import {
	Animated,
	AppState,
	AccessibilityInfo,
	Clipboard,
	Easing,
	Image,
	KeyboardAvoidingView,
	Modal,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	useColorScheme,
	useWindowDimensions,
	View,
} from "react-native";
import {
	SafeAreaView,
	useSafeAreaInsets,
} from "react-native-safe-area-context";

import {
	buildArtifactManifest,
	validateArtifactManifest,
} from "./src/engine/artifacts.ts";
import {
	getPreviewDeviceForRuntime,
	MODEL_ARTIFACTS,
} from "./src/engine/catalog.ts";
import { formatModelDisplayName } from "./src/engine/display.ts";
import { loadModelCatalog } from "./src/engine/remoteCatalog.ts";
import {
	getAvailableArtifactCandidates,
	resolveBackendRoute,
} from "./src/engine/router.ts";
import {
	bootstrapRuntime,
	cancelSession,
	createSession,
	generateChatReply,
	inspectPreparedArtifact,
	interruptGeneration,
	prepareArtifact,
	pruneIOSFallbackBackendArtifact,
	resetSessionContext,
	resumeSession,
	subscribeAppLifecycle,
	suspendAllSessions,
} from "./src/engine/runtime.ts";
import {
	extractCalcToolCalls,
	stripCalcTags,
} from "./src/engine/tools/math.ts";
import type {
	ArtifactPreparationProgress,
	BackendArtifactDescriptor,
	BackendAvailability,
	ChatAttachment,
	ChatGenerationChunk,
	ModelArtifactDescriptor,
	PreparedArtifact,
	RoutingDecision,
	RuntimeInfo,
	SessionHandle,
	SessionRuntimeOptions,
	TelemetrySnapshot,
} from "./src/engine/types.ts";
import {
	runImpactHaptic,
	runNotificationHaptic,
	runSelectionHaptic,
} from "./src/ui/haptics.ts";
import { SetupArcade } from "./src/ui/SetupArcade.tsx";
import { useColors } from "./src/ui/colors.ts";

const COLORS = useColors(); // module-level for styles; component uses useColors() for runtime adaptation


const SETUP_STATE_FILE = new File(Paths.document, "folio-setup.json");

const FEATURED_MODEL_ID = "lfm-2_5-350m";
const DEFAULT_ARTIFACT_ID =
	MODEL_ARTIFACTS.find(
		(artifact: ModelArtifactDescriptor) => artifact.id === FEATURED_MODEL_ID,
	)?.id ?? MODEL_ARTIFACTS[0].id;
const QUICK_PROMPTS = [
	"Explain quantum entanglement in simple terms.",
	"Help me draft a concise email to my team.",
	"What are three unconventional ways to boost creativity?",
];

type ChatMessage = {
	id: string;
	role: "assistant" | "user";
	text: string;
	attachments?: ChatAttachment[];
	meta?: string;
	streaming?: boolean;
	failed?: boolean;
};

type OnboardingStage = "select-model" | "overview" | "waiting" | "chat";

export default function App() {
	const insets = useSafeAreaInsets();
	const colorScheme = useColorScheme();
	const [catalogModels, setCatalogModels] =
		useState<ModelArtifactDescriptor[]>(MODEL_ARTIFACTS);
	const [catalogLoading, setCatalogLoading] = useState(false);
	const [catalogErrorMessage, setCatalogErrorMessage] = useState<string | null>(
		null,
	);
	const [selectedArtifactId, setSelectedArtifactId] =
		useState(DEFAULT_ARTIFACT_ID);
	const [setupArtifact, setSetupArtifact] =
		useState<ModelArtifactDescriptor | null>(null);
	const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);
	const [availableBackends, setAvailableBackends] = useState<
		BackendAvailability[]
	>([]);
	const [telemetry, setTelemetry] = useState<TelemetrySnapshot | null>(null);
	const [preparedArtifact, setPreparedArtifact] =
		useState<PreparedArtifact | null>(null);
	const [installedPreparedArtifact, setInstalledPreparedArtifact] =
		useState<PreparedArtifact | null>(null);
	const [session, setSession] = useState<SessionHandle | null>(null);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [composer, setComposer] = useState("");
	const [composerAttachments, setComposerAttachments] = useState<
		ChatAttachment[]
	>([]);
	const [busyAction, setBusyAction] = useState<string | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
	const [onboardingStage, setOnboardingStage] =
		useState<OnboardingStage>("select-model");
	const [hasStartedSetup, setHasStartedSetup] = useState(false);
	const [isArcadeExpanded, setIsArcadeExpanded] = useState(false);
	const [reduceMotion, setReduceMotion] = useState(false);
	const [setupAttemptKey, setSetupAttemptKey] = useState(0);
	const [installProgress, setInstallProgress] =
		useState<ArtifactPreparationProgress>({
			phase: "checking-cache",
			progress: 0,
		});
	const messagesScrollRef = useRef<ScrollView | null>(null);
	const onboardingMotion = useRef(new Animated.Value(0)).current;
	const lastReadySessionIdRef = useRef<string | null>(null);
	const lastErrorMessageRef = useRef<string | null>(null);
	const lastInstallPhaseRef = useRef<
		ArtifactPreparationProgress["phase"] | null
	>(null);
	const activeGenerationMessageIdRef = useRef<string | null>(null);
	const [fallbackOffer, setFallbackOffer] = useState<{
		preferredBackendName: string;
		fallbackArtifact: BackendArtifactDescriptor;
	} | null>(null);
	const [appStateKey, setAppStateKey] = useState(0);
	const [forcedFallbackArtifact, setForcedFallbackArtifact] =
		useState<BackendArtifactDescriptor | null>(null);
	const didCheckArtifactRef = useRef(false);
	const lastSetupErrorRef = useRef<"network" | "other" | null>(null);
	const isPrewarmingRef = useRef(false);
	const prewarmAttemptRef = useRef(false);
	const messagesRef = useRef<ChatMessage[]>(messages);
	messagesRef.current = messages;

	const liveSelectedArtifact =
		catalogModels.find(
			(artifact: ModelArtifactDescriptor) => artifact.id === selectedArtifactId,
		) ??
		MODEL_ARTIFACTS.find(
			(artifact: ModelArtifactDescriptor) => artifact.id === FEATURED_MODEL_ID,
		) ??
		catalogModels[0] ??
		MODEL_ARTIFACTS[0];
	const selectedArtifact = hasStartedSetup
		? (setupArtifact ?? liveSelectedArtifact)
		: liveSelectedArtifact;
	const featuredArtifact = selectedArtifact;
	const featuredModelName = formatModelDisplayName(featuredArtifact);
	const selectedModelLabel = featuredModelName;
	const installedArtifact = preparedArtifact ?? installedPreparedArtifact;
	const isArtifactInstalled = installedArtifact?.cacheState === "hit";
	const sessionRuntimeOptions = useMemo<SessionRuntimeOptions>(
		() => ({
			supportsVision: selectedArtifact.supportsVision,
			inputModalities: selectedArtifact.inputModalities,
			promptTemplate: selectedArtifact.promptTemplate,
			generationParams: selectedArtifact.generationParams,
		}),
		[selectedArtifact],
	);
	const previewDevice = useMemo(
		() =>
			getPreviewDeviceForRuntime(
				runtimeInfo?.platform ?? "web",
				runtimeInfo?.buildTarget,
				availableBackends,
			),
		[availableBackends, runtimeInfo?.buildTarget, runtimeInfo?.platform],
	);
	const routingDecision = useMemo(() => {
		if (forcedFallbackArtifact) {
			return {
				modelId: selectedArtifact.id,
				selectedArtifact: forcedFallbackArtifact,
				selectedBackend: forcedFallbackArtifact.backend,
				selectedQuantization: forcedFallbackArtifact.quantization,
				fallbackChain: [forcedFallbackArtifact.backend],
				rationale: [
					`Using ${forcedFallbackArtifact.backend} fallback per user choice.`,
				],
				blockedReasons: [],
			} as RoutingDecision;
		}
		return resolveBackendRoute({
			artifact: selectedArtifact,
			device: previewDevice,
			availableBackends,
		});
	}, [
		forcedFallbackArtifact,
		availableBackends,
		previewDevice,
		selectedArtifact,
	]);
	const manifest = useMemo(
		() =>
			buildArtifactManifest(selectedArtifact, routingDecision.selectedArtifact),
		[routingDecision.selectedArtifact, selectedArtifact],
	);
	const manifestValidation = useMemo(
		() => validateArtifactManifest(manifest),
		[manifest],
	);
	const isRuntimeBootstrapping =
		hasStartedSetup && (!runtimeInfo || busyAction === "refreshing-runtime");
	useEffect(() => {
		if (!manifest) {
			setInstalledPreparedArtifact(null);
			return;
		}

		setInstalledPreparedArtifact(inspectPreparedArtifact(manifest));
	}, [manifest, appStateKey]);

	useEffect(() => {
		async function loadPersistedState() {
			try {
				if (!SETUP_STATE_FILE.exists) return;
				const text = await SETUP_STATE_FILE.text();
				const data = JSON.parse(text) as { artifactId?: string };
				if (!data.artifactId) return;
				const resolvedArtifactId =
					data.artifactId === "qwen-3_6-0_8b"
						? FEATURED_MODEL_ID
						: data.artifactId;
				const artifact =
					MODEL_ARTIFACTS.find(
						(a: ModelArtifactDescriptor) => a.id === resolvedArtifactId,
					) ?? MODEL_ARTIFACTS[0];
				setSelectedArtifactId(artifact.id);
				setSetupArtifact(artifact);
				setHasStartedSetup(true);
				setOnboardingStage("chat");
			} catch {
				// silently fall back to onboarding
			}
		}
		void loadPersistedState();
	}, []);

	useEffect(() => {
		void refreshRuntime();
	}, []);

	useEffect(() => {
		let cancelled = false;
		let subscription: { remove: () => void } | null = null;

		async function initReduceMotion() {
			const initial = await AccessibilityInfo.isReduceMotionEnabled();
			if (cancelled) return;
			setReduceMotion(initial);
			subscription = AccessibilityInfo.addEventListener(
				"reduceMotionChanged",
				(setting) => {
					setReduceMotion(setting);
				},
			);
		}

		void initReduceMotion();
		return () => {
			cancelled = true;
			subscription?.remove();
		};
	}, []);

	useEffect(() => {
		let cancelled = false;

		async function refreshCatalog() {
			setCatalogLoading(true);
			const catalog = await loadModelCatalog();
			if (cancelled) {
				return;
			}

			setCatalogModels(catalog.models);
			setCatalogErrorMessage(catalog.errorMessage ?? null);
			setCatalogLoading(false);
		}

		void refreshCatalog();

		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!selectedArtifact.supportsVision && composerAttachments.length) {
			setComposerAttachments([]);
		}
	}, [composerAttachments.length, selectedArtifact.supportsVision]);

	useEffect(() => {
		const handle = setTimeout(() => {
			messagesScrollRef.current?.scrollToEnd({ animated: false });
		}, 40);

		return () => clearTimeout(handle);
	}, [busyAction, messages, reduceMotion]);

	useEffect(() => {
		onboardingMotion.setValue(0);
		if (!reduceMotion) {
			Animated.timing(onboardingMotion, {
				toValue: 1,
				duration: 300,
				easing: Easing.out(Easing.poly(4)),
				useNativeDriver: true,
			}).start();
		}
	}, [hasStartedSetup, onboardingMotion, onboardingStage, reduceMotion]);

	useEffect(() => {
		didCheckArtifactRef.current = false;
	}, [
		hasStartedSetup,
		setupAttemptKey,
		selectedArtifactId,
		forcedFallbackArtifact,
		appStateKey,
	]);

	useEffect(() => {
		const subscription = AppState.addEventListener("change", (nextAppState) => {
			if (nextAppState === "active") {
				setAppStateKey((k) => k + 1);
			}
		});
		return () => subscription.remove();
	}, []);

	useEffect(() => {
		if (Platform.OS === "web") return;
		const unsubscribe = subscribeAppLifecycle((event) => {
			if (event === "didEnterBackground") {
				prewarmAttemptRef.current = false;
				void suspendAllSessions();
			}
		});
		return unsubscribe;
	}, []);

	useEffect(() => {
		if (Platform.OS === "web") return;
		if (!session?.sessionId) return;
		if (session.status === "ready") return;
		if (prewarmAttemptRef.current) return;
		if (!hasStartedSetup) return;
		if (isPrewarmingRef.current) return;

		const sessionId = session.sessionId;
		prewarmAttemptRef.current = true;
		isPrewarmingRef.current = true;

		async function tryResume() {
			try {
				const resumed = await resumeSession(sessionId);
				if (resumed.status === "ready") {
					setSession(resumed);
				}
			} catch {
				// resume will fail if artifact was deleted; let validation effect handle it
			} finally {
				isPrewarmingRef.current = false;
			}
		}

		void tryResume();
		return () => {
			// If the effect re-runs because sessionId changed, reset the attempt
			// so the new session can be prewarmed.
			prewarmAttemptRef.current = false;
		};
	}, [session?.sessionId, session?.status, hasStartedSetup]);

	useEffect(() => {
		if (Platform.OS === "web") return;
		if (!hasStartedSetup || !runtimeInfo) return;
		if (catalogLoading && !catalogModels.length) return;
		if (session?.status === "ready") return;
		if (fallbackOffer) return;
		if (busyAction === "activating-model") return;
		if (didCheckArtifactRef.current) return;

		didCheckArtifactRef.current = true;

		function resetToOnboarding() {
			setHasStartedSetup(false);
			setOnboardingStage("select-model");
			setSetupArtifact(null);
			setForcedFallbackArtifact(null);
			setSession(null);
			setMessages([]);
			setErrorMessage(null);
			setFallbackOffer(null);
			setInstallProgress({ phase: "checking-cache", progress: 0 });
			try {
				if (SETUP_STATE_FILE.exists) {
					SETUP_STATE_FILE.delete();
				}
			} catch {
				// ignore
			}
		}

		const hadPriorSetup = SETUP_STATE_FILE.exists;

		if (routingDecision.selectedArtifact) {
			const manifest = buildArtifactManifest(
				selectedArtifact,
				routingDecision.selectedArtifact,
			);
			const cached = manifest ? inspectPreparedArtifact(manifest) : null;
			if (cached?.cacheState === "hit") {
				return;
			}
			const candidates = getAvailableArtifactCandidates(
				selectedArtifact,
				previewDevice,
				availableBackends,
			);
			for (const candidate of candidates) {
				if (candidate.backend === routingDecision.selectedArtifact.backend)
					continue;
				const candidateManifest = buildArtifactManifest(
					selectedArtifact,
					candidate,
				);
				if (
					candidateManifest &&
					inspectPreparedArtifact(candidateManifest)?.cacheState === "hit"
				) {
					setFallbackOffer({
						preferredBackendName: routingDecision.selectedArtifact.backend,
						fallbackArtifact: candidate,
					});
					return;
				}
			}
			if (hadPriorSetup || onboardingStage === "chat") {
				resetToOnboarding();
			}
			return;
		}

		const candidates = getAvailableArtifactCandidates(
			selectedArtifact,
			previewDevice,
			availableBackends,
		);
		const preferredBackend =
			previewDevice.preferredBackends[0] ?? candidates[0]?.backend;

		for (const candidate of candidates) {
			const manifest = buildArtifactManifest(selectedArtifact, candidate);
			if (manifest && inspectPreparedArtifact(manifest)?.cacheState === "hit") {
				setFallbackOffer({
					preferredBackendName: preferredBackend ?? candidate.backend,
					fallbackArtifact: candidate,
				});
				return;
			}
		}

		if (hadPriorSetup || onboardingStage === "chat") {
			resetToOnboarding();
		}
	}, [
		hasStartedSetup,
		runtimeInfo,
		catalogLoading,
		catalogModels.length,
		routingDecision,
		selectedArtifact,
		previewDevice,
		availableBackends,
		session?.status,
		fallbackOffer,
		busyAction,
		onboardingStage,
		appStateKey,
	]);

	useEffect(() => {
		if (session?.status !== "ready") return;
		try {
			SETUP_STATE_FILE.write(
				JSON.stringify({
					artifactId: selectedArtifact.id,
					backendId: session.backendId,
				}),
			);
		} catch {
			// ignore write errors
		}
	}, [session?.status, selectedArtifact.id, session?.backendId]);

	useEffect(() => {
		if (
			session?.status === "ready" &&
			hasStartedSetup &&
			onboardingStage !== "chat"
		) {
			setOnboardingStage("chat");
		}
	}, [session?.status, hasStartedSetup, onboardingStage]);

	useEffect(() => {
		if (onboardingStage !== "waiting") {
			setIsArcadeExpanded(false);
		}
	}, [onboardingStage]);

	useEffect(() => {
		if (onboardingStage === "waiting" && session?.status !== "ready") {
			setIsArcadeExpanded(true);
		}
	}, [onboardingStage, session?.status]);

	useEffect(() => {
		if (Platform.OS === "web") {
			return;
		}

		if (session?.status === "ready") {
			if (lastReadySessionIdRef.current !== session.sessionId) {
				lastReadySessionIdRef.current = session.sessionId;
				runNotificationHaptic("success");
			}
			return;
		}

		lastReadySessionIdRef.current = null;
	}, [session?.sessionId, session?.status]);

	useEffect(() => {
		if (Platform.OS === "web") {
			return;
		}

		if (errorMessage && errorMessage !== lastErrorMessageRef.current) {
			lastErrorMessageRef.current = errorMessage;
			runNotificationHaptic("error");
			return;
		}

		if (!errorMessage) {
			lastErrorMessageRef.current = null;
		}
	}, [errorMessage]);

	useEffect(() => {
		if (!hasStartedSetup) {
			lastInstallPhaseRef.current = null;
			return;
		}

		if (Platform.OS === "web") {
			return;
		}

		if (lastInstallPhaseRef.current === installProgress.phase) {
			return;
		}

		const previousPhase = lastInstallPhaseRef.current;
		lastInstallPhaseRef.current = installProgress.phase;

		if (!previousPhase) {
			return;
		}

		if (
			installProgress.phase === "verifying-package" ||
			installProgress.phase === "extracting" ||
			installProgress.phase === "starting-session"
		) {
			runImpactHaptic("light");
		}
	}, [hasStartedSetup, installProgress.phase]);

	useEffect(() => {
		let cancelled = false;
		let sessionIdToCancel: string | null = null;
		let shouldCancelPendingSession = false;
		let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

		function clearWatchdog() {
			if (watchdogTimer) {
				clearTimeout(watchdogTimer);
				watchdogTimer = null;
			}
		}

		function startWatchdog() {
			clearWatchdog();
			// First warning at 2 minutes
			watchdogTimer = setTimeout(
				() => {
					if (cancelled) return;
					setErrorMessage(
						"Model setup is taking longer than expected. Still working...",
					);
					// Hard timeout at 5 minutes total
					watchdogTimer = setTimeout(
						() => {
							if (cancelled) return;
							setErrorMessage(
								"Model setup timed out. Please check your connection and try again.",
							);
							setBusyAction(null);
						},
						3 * 60 * 1000,
					);
				},
				2 * 60 * 1000,
			);
		}

		async function activateSelectedModel() {
			if (!hasStartedSetup) {
				setSetupArtifact(null);
				setPreparedArtifact(null);
				setSession(null);
				setMessages([]);
				setErrorMessage(null);
				setInstallProgress({
					phase: "checking-cache",
					progress: 0,
				});
				return;
			}

			setPreparedArtifact(null);
			setSession(null);
			setErrorMessage(null);
			setInstallProgress({
				phase: "checking-cache",
				progress: 0.04,
			});

			if (!runtimeInfo) {
				return;
			}

			if (catalogLoading && !catalogModels.length) {
				return;
			}

			if (!routingDecision.selectedBackend) {
				const nextError =
					routingDecision.blockedReasons[0] ??
					"No compatible backend is currently available for this model on this device.";
				if (!cancelled) {
					setErrorMessage(nextError);
				}
				return;
			}

			if (!manifest || !manifestValidation.valid) {
				const nextError =
					manifestValidation.errors[0] ??
					"Selected artifact manifest is invalid.";
				if (!cancelled) {
					setErrorMessage(nextError);
				}
				return;
			}

			const selectedBackendId = routingDecision.selectedBackend;

			try {
				setBusyAction("activating-model");
				startWatchdog();
				const prepared = await prepareArtifact(
					manifest,
					(progress: ArtifactPreparationProgress) => {
						if (!cancelled) {
							setInstallProgress(progress);
						}
					},
				);
				if (cancelled) {
					return;
				}

				setInstallProgress({
					phase: "starting-session",
					progress: 0.97,
					transferredBytes: manifest.packageSizeBytes,
					totalBytes: manifest.packageSizeBytes ?? null,
				});
				const nextSession = await createSession(
					manifest.artifactId,
					selectedBackendId,
					prepared.localUri,
					sessionRuntimeOptions,
				);
				sessionIdToCancel = nextSession.sessionId;
				if (cancelled || shouldCancelPendingSession) {
					await cancelSession(nextSession.sessionId);
					return;
				}

				setPreparedArtifact(prepared);
				setSession(nextSession);

				if (Platform.OS === "ios" && manifest.backendId === "coreml") {
					pruneIOSFallbackBackendArtifact(manifest);
				}

				const telemetrySnapshot: TelemetrySnapshot = telemetry ?? {
					ttftMs: 0,
					decodeTokensPerSecond: 0,
					peakMemoryMb: 0,
					queueDepth: 0,
					lastRoute: selectedBackendId,
				};
				setTelemetry(telemetrySnapshot);
				setInstallProgress({
					phase: "ready",
					progress: 1,
					transferredBytes: manifest.packageSizeBytes,
					totalBytes: manifest.packageSizeBytes ?? null,
				});
				setMessages(
					buildReadyMessages(
						selectedArtifact,
						selectedBackendId,
						telemetrySnapshot,
						prepared,
					),
				);
			} catch (error) {
				if (cancelled) {
					return;
				}

				const nextError =
					error instanceof Error
						? error.message
						: "Failed to activate the selected model.";
				const isNetworkError =
					nextError.includes("network") ||
					nextError.includes("timeout") ||
					nextError.includes("timed out") ||
					nextError.includes("offline") ||
					nextError.includes("ENET") ||
					nextError.includes("ECONN") ||
					nextError.includes("abort") ||
					nextError.includes("interrupted") ||
					nextError.includes("cancelled");
				lastSetupErrorRef.current = isNetworkError ? "network" : "other";
				setErrorMessage(nextError);
				setInstallProgress((current: ArtifactPreparationProgress) => ({
					...current,
					progress: Math.max(current.progress, 0.08),
				}));
				setMessages([]);
			} finally {
				clearWatchdog();
				if (!cancelled) {
					setBusyAction(null);
				}
			}
		}

		void activateSelectedModel();

		return () => {
			cancelled = true;
			clearWatchdog();
			if (sessionIdToCancel) {
				void cancelSession(sessionIdToCancel);
			} else {
				shouldCancelPendingSession = true;
			}
		};
	}, [
		hasStartedSetup,
		catalogLoading,
		catalogModels.length,
		manifest,
		manifestValidation.errors,
		manifestValidation.valid,
		routingDecision,
		runtimeInfo,
		selectedArtifact,
		sessionRuntimeOptions,
		setupAttemptKey,
	]);

	async function refreshRuntime() {
		try {
			setBusyAction("refreshing-runtime");
			setErrorMessage(null);
			const runtime = await bootstrapRuntime();
			setRuntimeInfo(runtime.runtimeInfo);
			setAvailableBackends(runtime.availableBackends);
			setTelemetry(runtime.telemetry);
		} catch (error) {
			setErrorMessage(
				error instanceof Error ? error.message : "Failed to refresh runtime",
			);
			// If bootstrap fails, clear busyAction so the user can retry via retrySetup
			setRuntimeInfo((current) => current ?? null);
		} finally {
			setBusyAction(null);
		}
	}

	async function handleSend(
		promptOverride?: string,
		options?: {
			skipUserMessage?: boolean;
			reuseMessageId?: string;
			attachments?: ChatAttachment[];
		},
	) {
		const rawPrompt = (promptOverride ?? composer).trim();
		const attachments = options?.attachments ?? composerAttachments;
		const streamingMessageId =
			options?.reuseMessageId ?? createMessageId("assistant");
		const displayPrompt =
			rawPrompt ||
			(attachments.length ? "Describe the attached image in detail." : "");
		if (!displayPrompt) {
			return;
		}

		const mightNeedMath =
			(/\d{3,}/.test(displayPrompt) && /[\s+\-*/^%]/.test(displayPrompt)) ||
			/(?:calculate|compute|math|multiply|divide|add|subtract|sum|product|difference|square|root|power|algebra|equation|solve|variable|factor|simplify|expand)/i.test(
				displayPrompt,
			) ||
			/(?:\d+\s*[\+\-\*/\%]\s*\d+|\d+\s*\^\s*\d+)/.test(displayPrompt);
		const toolInstruction = mightNeedMath
			? "You have a calculator. When you need to compute something, write <calc>expression</calc> and I will evaluate it. For equations, write <calc>2x + 5 = 15</calc> and I will solve for the variable. Always use the calculator for math instead of guessing.\n\n"
			: "";
		const modelPrompt = toolInstruction + displayPrompt;

		runImpactHaptic("light");
		if (!options?.skipUserMessage) {
			setComposer("");
			setComposerAttachments([]);
			setMessages((current) => [
				...current,
				createUserMessage(displayPrompt, attachments),
			]);
		}

		if (
			!routingDecision.selectedBackend ||
			!runtimeInfo ||
			!session ||
			session.status !== "ready"
		) {
			const notReadyText =
				"This preview shell is waiting for a live session before it can answer as the selected model.";
			if (options?.reuseMessageId) {
				setMessages((current) =>
					upsertAssistantMessage(current, {
						id: streamingMessageId,
						text: notReadyText,
						meta: "Model not ready",
						streaming: false,
					}),
				);
			} else {
				setMessages((current) => [
					...current,
					createAssistantMessage(notReadyText, "Model not ready"),
				]);
			}
			return;
		}

		try {
			setErrorMessage(null);
			setBusyAction("drafting-reply");
			activeGenerationMessageIdRef.current = streamingMessageId;

			// Build conversation history from prior messages (excluding current streaming one)
			const priorMessages = messagesRef.current;
			const history = priorMessages
				.filter((m) => m.id !== streamingMessageId && m.role === "user")
				.flatMap((m): { role: "user" | "assistant"; content: string }[] => {
					const userEntry = { role: "user" as const, content: m.text };
					// Find following assistant message
					const userIdx = priorMessages.indexOf(m);
					const nextAssistant = priorMessages[userIdx + 1];
					if (nextAssistant && nextAssistant.role === "assistant") {
						return [
							userEntry,
							{ role: "assistant" as const, content: nextAssistant.text },
						];
					}
					return [userEntry];
				});

			let generation = await generateChatReply(
				session.sessionId,
				modelPrompt,
				selectedModelLabel,
				{
					attachments,
					history,
					onChunk: (chunk: ChatGenerationChunk) => {
						if (activeGenerationMessageIdRef.current !== streamingMessageId) {
							return;
						}
						const cleaned = stripCalcTags(chunk.accumulatedText);
						setMessages((current) =>
							upsertAssistantMessage(current, {
								id: streamingMessageId,
								text: stripSpecialTokens(cleaned),
								meta: "Generating on-device...",
								streaming: true,
							}),
						);
					},
				},
			);
			if (activeGenerationMessageIdRef.current !== streamingMessageId) {
				return;
			}

			const toolCalls = extractCalcToolCalls(generation.text);
			if (toolCalls.length > 0 && session?.status === "ready") {
				const toolResults = toolCalls
					.map((t) => {
						switch (t.kind) {
							case "numeric":
								return `${t.expression} = ${t.formatted}`;
							case "equation":
								return `${t.expression} → ${t.formatted}`;
							case "quadratic":
								return `${t.expression} → ${t.formatted}`;
							case "simplified":
								return `${t.expression} → ${t.formatted}`;
							case "identity":
								return `${t.expression} → ${t.formatted}`;
							case "error":
								return `${t.expression} → Error: ${t.reason}`;
						}
					})
					.join("; ");

				setMessages((current) =>
					upsertAssistantMessage(current, {
						id: streamingMessageId,
						text:
							stripSpecialTokens(stripCalcTags(generation.text)).trim() +
							"\n\n*Calculating...*",
						meta: "Using calculator...",
						streaming: false,
					}),
				);

				generation = await generateChatReply(
					session.sessionId,
					`Calculator result: ${toolResults}`,
					selectedModelLabel,
					{
						attachments: [],
						history,
						onChunk: (chunk: ChatGenerationChunk) => {
							if (activeGenerationMessageIdRef.current !== streamingMessageId) {
								return;
							}
							setMessages((current) =>
								upsertAssistantMessage(current, {
									id: streamingMessageId,
									text: stripSpecialTokens(chunk.accumulatedText),
									meta: "Generating on-device...",
									streaming: true,
								}),
							);
						},
					},
				);
			}

			if (activeGenerationMessageIdRef.current !== streamingMessageId) {
				return;
			}

			setTelemetry(generation.telemetry);
			if (generation.finishReason === "completed") {
				runImpactHaptic("light");
			}
			setMessages((current) =>
				upsertAssistantMessage(current, {
					id: streamingMessageId,
					text: (() => {
						const cleaned = stripSpecialTokens(generation.text);
						if (cleaned.trim().length > 0) return cleaned;
						return generation.finishReason === "interrupted"
							? "Stopped before a reply was produced."
							: cleaned;
					})(),
					meta:
						generation.finishReason === "interrupted"
							? `Stopped early • ${formatGenerationMeta(
									generation.backendId,
									generation.turnIndex,
									generation.tokensGenerated,
									generation.telemetry,
									preparedArtifact?.localUri ?? "artifact cache pending",
								)}`
							: formatGenerationMeta(
									generation.backendId,
									generation.turnIndex,
									generation.tokensGenerated,
									generation.telemetry,
									preparedArtifact?.localUri ?? "artifact cache pending",
								),
					streaming: false,
				}),
			);
		} catch (error) {
			if (activeGenerationMessageIdRef.current !== streamingMessageId) {
				return;
			}
			const nextError =
				error instanceof Error
					? error.message
					: "Failed to generate a local reply.";
			setErrorMessage(nextError);
			setMessages((current) => {
				const existingDraft = current.find(
					(message) => message.id === streamingMessageId,
				);
				const fallbackText = existingDraft?.text.trim().length
					? `${existingDraft.text}\n\nGeneration interrupted: ${nextError}`
					: `I hit a runtime problem while preparing that reply: ${nextError}`;

				return upsertAssistantMessage(current, {
					id: streamingMessageId,
					text: fallbackText,
					meta: "Failed to generate. Tap to retry.",
					streaming: false,
					failed: true,
				});
			});
		} finally {
			if (activeGenerationMessageIdRef.current === streamingMessageId) {
				activeGenerationMessageIdRef.current = null;
			}
			setBusyAction(null);
		}
	}

	async function handleInterruptGeneration() {
		if (!session || busyAction !== "drafting-reply") {
			return;
		}

		runImpactHaptic("soft");
		try {
			await interruptGeneration(session.sessionId);
		} catch {
			// ignore interrupt errors — the generation will stop anyway
		}
	}

	async function handleResetConversation() {
		if (!session) {
			return;
		}

		try {
			runSelectionHaptic();
			setBusyAction("resetting-chat");
			setErrorMessage(null);
			if (activeGenerationMessageIdRef.current) {
				await interruptGeneration(session.sessionId);
			}
			await resetSessionContext(session.sessionId);
			if (telemetry) {
				setTelemetry(telemetry);
			}
			const nextTelemetry: TelemetrySnapshot = telemetry ?? {
				ttftMs: 0,
				decodeTokensPerSecond: 0,
				peakMemoryMb: 0,
				queueDepth: 0,
				lastRoute: session.backendId,
			};
			setMessages(
				buildReadyMessages(
					selectedArtifact,
					session.backendId,
					nextTelemetry,
					preparedArtifact ?? {
						artifactId: session.artifactId,
						localUri: "",
						sourceUri: "",
						verified: true,
						cacheState: "hit",
					},
				),
			);
		} catch (error) {
			setErrorMessage(
				error instanceof Error ? error.message : "Failed to start a new chat.",
			);
		} finally {
			activeGenerationMessageIdRef.current = null;
			setBusyAction(null);
		}
	}

	async function handleRetryMessage(failedMessageId: string) {
		if (busyAction) return;
		const latestMessages = messagesRef.current;
		const failedIndex = latestMessages.findIndex(
			(m) => m.id === failedMessageId,
		);
		if (failedIndex <= 0) return;
		const userMessage = latestMessages
			.slice(0, failedIndex)
			.reverse()
			.find((m) => m.role === "user");
		if (!userMessage) return;

		setMessages((current) =>
			current.map((m) =>
				m.id === failedMessageId
					? { ...m, failed: false, meta: "Retrying...", streaming: true }
					: m,
			),
		);
		await handleSend(userMessage.text, {
			skipUserMessage: true,
			reuseMessageId: failedMessageId,
			attachments: userMessage.attachments ?? [],
		});
	}

	async function handlePickAttachment() {
		if (!selectedArtifact.supportsVision || busyAction) {
			return;
		}

		const result = await DocumentPicker.getDocumentAsync({
			copyToCacheDirectory: true,
			multiple: false,
			type: "image/*",
		});
		if (result.canceled || !result.assets?.length) {
			return;
		}

		runSelectionHaptic();
		setComposerAttachments([mapDocumentAttachment(result.assets[0])]);
	}

	async function handleCaptureAttachment() {
		if (!selectedArtifact.supportsVision || busyAction) {
			return;
		}

		const permission = await ImagePicker.requestCameraPermissionsAsync();
		if (!permission.granted) {
			setErrorMessage(
				"Camera permission is required before you can capture an image for a vision model.",
			);
			return;
		}

		const result = await ImagePicker.launchCameraAsync({
			cameraType: ImagePicker.CameraType.back,
			mediaTypes: ImagePicker.MediaTypeOptions.Images,
			quality: 1,
		});
		if (result.canceled || !result.assets?.length) {
			return;
		}

		runSelectionHaptic();
		setComposerAttachments([mapCameraAttachment(result.assets[0])]);
	}

	const composerDisabled =
		busyAction === "activating-model" ||
		busyAction === "drafting-reply" ||
		busyAction === "resetting-chat" ||
		session?.status !== "ready";
	const canSend =
		Boolean(composer.trim() || composerAttachments.length) && !composerDisabled;
	const canStopGeneration =
		busyAction === "drafting-reply" && session?.status === "ready";
	const isInstalling = hasStartedSetup && session?.status !== "ready";
	const showOnboarding = !hasStartedSetup || onboardingStage !== "chat";
	const isIosSimulator =
		runtimeInfo?.platform === "ios" &&
		runtimeInfo.buildTarget === "ios-simulator";
	const hasUserMessages = messages.some((message) => message.role === "user");
	const hasStreamingAssistantText = messages.some(
		(message) =>
			message.role === "assistant" &&
			message.streaming &&
			message.text.trim().length > 0,
	);
	const installStageTitle = titleForInstallPhase(
		installProgress.phase,
		manifest?.packageSizeBytes,
	);
	const installStageDetail = detailForInstallPhase(
		installProgress.phase,
		installProgress.transferredBytes,
		installProgress.totalBytes ?? manifest?.packageSizeBytes ?? null,
	);
	const downloadRatio = resolveTransferRatio(
		installProgress.transferredBytes,
		installProgress.totalBytes ?? manifest?.packageSizeBytes ?? null,
	);
	const sendButtonLabel =
		busyAction === "drafting-reply"
			? "Stop"
			: !composer.trim() && composerAttachments.length
				? "Describe"
				: "Send";
	const simulatorHint = isIosSimulator
		? "Simulator mode uses the XNNPACK fallback path. CoreML comes back automatically on real iPhone hardware."
		: null;
	const shouldShowSimulatorHint = Boolean(simulatorHint && hasStartedSetup);
	const selectionIntroCopy = runtimeInfo
		? `Start with ${featuredModelName} for stronger replies without a major speed hit on most phones.`
		: `Start with ${featuredModelName}. Folio will quickly check the best local runtime for this phone, then begin setup automatically.`;
	const selectionFooterMeta = runtimeInfo
		? "Starts downloading immediately"
		: "Checks your device first, then starts automatically";
	const topBuffer = Platform.OS === "ios" ? 14 : 10;
	const topInsetPadding = insets.top + topBuffer;
	const bottomInsetPadding = Math.max(14, insets.bottom + 10);
	const { width: screenWidth } = useWindowDimensions();
	const responsivePadding = Math.max(18, Math.floor((screenWidth - 600) / 2));
	const userBubbleMaxWidth = Math.min(Math.round(screenWidth * 0.78), 420);
	const assistantBubbleMaxWidth = Math.min(Math.round(screenWidth * 0.92), 520);
	const onboardingMotionStyle = {
		opacity: onboardingMotion,
		transform: [
			{
				translateY: onboardingMotion.interpolate({
					inputRange: [0, 1],
					outputRange: [20, 0],
				}),
			},
		],
	};

	function resolveArtifactDescriptor(
		artifactId: string,
	): ModelArtifactDescriptor | null {
		return (
			catalogModels.find((artifact) => artifact.id === artifactId) ??
			MODEL_ARTIFACTS.find((artifact) => artifact.id === artifactId) ??
			null
		);
	}

	function startFeaturedSetup() {
		if (busyAction === "activating-model") {
			return;
		}

		setForcedFallbackArtifact(null);
		setFallbackOffer(null);

		const nextArtifact = resolveArtifactDescriptor(featuredArtifact.id);
		if (!nextArtifact) {
			setErrorMessage(
				"The selected model could not be loaded. Please try again.",
			);
			return;
		}

		const hadError = lastSetupErrorRef.current !== null;
		if (isArtifactInstalled && !hadError) {
			runSelectionHaptic();
			setHasStartedSetup(true);
			setOnboardingStage(session?.status === "ready" ? "chat" : "waiting");
			return;
		}

		if (hadError) {
			lastSetupErrorRef.current = null;
			setInstalledPreparedArtifact(null);
		}

		runImpactHaptic("light");
		setSelectedArtifactId(nextArtifact.id);
		setSetupArtifact(nextArtifact);
		setHasStartedSetup(true);
		setOnboardingStage("overview");
		setErrorMessage(null);
		setSetupAttemptKey((current) => current + 1);
	}

	function retrySetup() {
		runImpactHaptic("medium");
		lastSetupErrorRef.current = null;
		setErrorMessage(null);
		setInstalledPreparedArtifact(null);
		setSetupAttemptKey((current) => current + 1);
	}

	function finishInformationFlow() {
		runSelectionHaptic();
		setOnboardingStage(session?.status === "ready" ? "chat" : "waiting");
	}

	function renderSetupStatusCard() {
		const usedLocalCache = installedArtifact?.cacheState === "hit";
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

		return (
			<View
				style={styles.setupProgressPanel}
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
				<View style={styles.setupProgressHeader}>
					<View style={styles.setupProgressCopy}>
						<Text style={styles.setupProgressEyebrow}>{progressEyebrow}</Text>
						<Text
							style={styles.setupProgressTitleCompact}
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
					<Text style={styles.setupProgressMetaCompact}>
						{session?.status === "ready"
							? "100%"
							: isRuntimeBootstrapping
								? "Checking"
								: installProgress.phase === "downloading"
									? `${Math.round(downloadRatio * 100)}%`
									: shortInstallPhaseLabel(installProgress.phase)}
					</Text>
				</View>
				<ProgressBar progress={transferBarProgress} />
				<View style={styles.installStageRail}>
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
										styles.installStageChip,
										isActive ? styles.installStageChipActive : null,
										isDone ? styles.installStageChipDone : null,
									]}
								>
									<Text
										style={[
											styles.installStageChipText,
											isActive || isDone
												? styles.installStageChipTextStrong
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
				<Text style={styles.setupProgressBody}>
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
		);
	}

	function renderSetupErrorCard() {
		if (!errorMessage) {
			return null;
		}

		return (
			<View style={styles.inlineErrorCard}>
				<Text style={styles.errorText}>{errorMessage}</Text>
				<Pressable
					onPress={retrySetup}
					accessibilityRole="button"
					accessibilityLabel="Retry model setup"
					style={({ pressed }) => [
						styles.secondaryActionButton,
						pressed ? styles.buttonPressed : null,
					]}
				>
					<Text style={styles.secondaryActionText}>Retry setup</Text>
				</Pressable>
			</View>
		);
	}

	function renderOnboardingContent() {
		if (!hasStartedSetup) {
			return (
				<View style={styles.stageStack}>
					<View style={styles.selectionHero}>
						<Text style={styles.selectionEyebrow}>
							Private AI on your phone
						</Text>
						<Text style={styles.selectionTitle}>Choose your model</Text>
						<Text style={styles.selectionIntro}>{selectionIntroCopy}</Text>
					</View>

					<Pressable
						onPress={startFeaturedSetup}
						accessibilityRole="button"
						accessibilityLabel={
							isArtifactInstalled
								? `Open ${featuredModelName}`
								: `Download ${featuredModelName}`
						}
						style={({ pressed }) => [
							styles.selectionCard,
							styles.selectionCardPrimary,
							pressed ? styles.buttonPressed : null,
						]}
					>
						<View style={styles.selectionCardHeader}>
							<Text
								style={styles.selectionCardTitle}
								numberOfLines={2}
								ellipsizeMode="tail"
							>
								{featuredModelName}
							</Text>
							<StatusPill
								label={isArtifactInstalled ? "Installed" : "Available now"}
								tone="success"
							/>
						</View>
						<Text style={styles.selectionCardMeta}>
							{featuredArtifact.sizeLabel} • ~{featuredArtifact.estimatedSizeGb}{" "}
							GB
						</Text>
						<View style={styles.selectionCardFooter}>
							<Text style={styles.selectionFooterMeta}>
								{isArtifactInstalled
									? "Already on this device"
									: selectionFooterMeta}
							</Text>
							<Text style={styles.selectionFooterAction}>
								{isArtifactInstalled
									? "Open chat →"
									: `Download ${featuredModelName} →`}
							</Text>
						</View>
					</Pressable>

					{catalogErrorMessage ? (
						<Text style={styles.inlineNote}>{catalogErrorMessage}</Text>
					) : null}
				</View>
			);
		}

		if (onboardingStage === "overview") {
			return (
				<View style={styles.stageStack}>
					<View style={styles.infoStageHeader}>
						<View style={styles.infoStageMetaRow}>
							<Text style={styles.wizardStepLabel}>Quick setup guide</Text>
							{session?.status === "ready" ? (
								<Pressable
									onPress={() => {
										runSelectionHaptic();
										setOnboardingStage("chat");
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

					{renderSetupStatusCard()}

					{shouldShowSimulatorHint ? (
						<Text style={styles.quietNote}>{simulatorHint}</Text>
					) : null}
					{renderSetupErrorCard()}

					<Pressable
						onPress={finishInformationFlow}
						accessibilityRole="button"
						accessibilityLabel={
							session?.status === "ready" ? "Open chat" : "Play while you wait"
						}
						style={({ pressed }) => [
							styles.primaryActionButton,
							pressed ? styles.buttonPressed : null,
						]}
					>
						<Text style={styles.primaryActionText}>
							{session?.status === "ready"
								? "Open chat"
								: "Play while you wait"}
						</Text>
					</Pressable>
				</View>
			);
		}

		return (
			<View style={styles.stageStack}>
				<View style={styles.waitingHero}>
					<Text style={styles.selectionEyebrow}>
						Setup continues in the background
					</Text>
					<Text style={styles.selectionTitle}>
						{session?.status === "ready"
							? "Your model is ready"
							: "Almost there"}
					</Text>
				</View>

				{renderSetupStatusCard()}

				{session?.status === "ready" ? (
					<View style={styles.dualActionRow}>
						<Pressable
							onPress={() => {
								runSelectionHaptic();
								setOnboardingStage("chat");
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

				{shouldShowSimulatorHint ? (
					<Text style={styles.quietNote}>{simulatorHint}</Text>
				) : null}
				{renderSetupErrorCard()}
			</View>
		);
	}

	return (
		<SafeAreaView style={styles.safeArea} edges={["left", "right"]}>
			<StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
			<KeyboardAvoidingView
				style={[
					styles.keyboardView,
					{
						paddingTop: topInsetPadding,
						paddingBottom: bottomInsetPadding,
						paddingHorizontal: responsivePadding,
					},
				]}
				behavior={Platform.OS === "ios" ? "padding" : undefined}
			>
				<View style={styles.backgroundGlowTop} />
				<View style={styles.backgroundGlowBottom} />

				{showOnboarding ? (
					<View style={styles.onboardingShell}>
						<ScrollView
							style={styles.onboardingScroll}
							contentContainerStyle={styles.onboardingScrollContent}
						>
							<View style={styles.header}>
								<View style={styles.brandBlock}>
									<Text style={styles.brandEyebrow}>Folio</Text>
									<Text style={styles.brandSubtitle}>
										{!hasStartedSetup
											? "Private AI on your phone, with setup handled for you."
											: onboardingStage === "waiting"
												? "Setup keeps running while you wait."
												: "Download is underway, and the rest stays focused on what matters."}
									</Text>
								</View>
							</View>

							<Animated.View style={onboardingMotionStyle}>
								{renderOnboardingContent()}
							</Animated.View>
						</ScrollView>
					</View>
				) : (
					<View style={styles.chatShell}>
						<View style={styles.chatTopBar}>
							<Text style={styles.chatTopBarTitle}>Folio</Text>
							<Pressable
								onPress={() => {
									runSelectionHaptic();
									setIsModelPickerOpen(true);
								}}
								accessibilityRole="button"
								accessibilityLabel="Choose model"
								style={({ pressed }) => [
									styles.chatModelButton,
									pressed ? styles.buttonPressed : null,
								]}
							>
								<Text
									style={styles.chatModelButtonText}
									numberOfLines={1}
									ellipsizeMode="tail"
								>
									{featuredModelName}
								</Text>
							</Pressable>
							<Pressable
								onPress={() => void handleResetConversation()}
								disabled={session?.status !== "ready"}
								accessibilityRole="button"
								accessibilityLabel="Start a new chat"
								style={({ pressed }) => [
									styles.chatNewChatButton,
									session?.status !== "ready" ? styles.buttonDisabled : null,
									pressed ? styles.buttonPressed : null,
								]}
							>
								<Text style={styles.chatNewChatButtonText}>New chat</Text>
							</Pressable>
						</View>

						{simulatorHint ? (
							<Text style={styles.inlineNote}>{simulatorHint}</Text>
						) : null}
						{errorMessage ? (
							<Text style={styles.errorText}>{errorMessage}</Text>
						) : null}

						<View style={styles.chatCard}>
							<ScrollView
								ref={messagesScrollRef}
								style={styles.messagesScroll}
								contentContainerStyle={[
									styles.messagesContent,
									styles.messagesContentGrow,
								]}
								keyboardShouldPersistTaps="handled"
								keyboardDismissMode={
									Platform.OS === "ios" ? "interactive" : "on-drag"
								}
								onContentSizeChange={() => {
									messagesScrollRef.current?.scrollToEnd({ animated: false });
								}}
							>
								{messages.map((message) => (
									<ChatBubble
										key={message.id}
										message={message}
										userMaxWidth={userBubbleMaxWidth}
										assistantMaxWidth={assistantBubbleMaxWidth}
										onRetry={
											message.role === "assistant" && message.failed
												? () => void handleRetryMessage(message.id)
												: undefined
										}
									/>
								))}
								{session?.status === "ready" && !hasUserMessages ? (
									<View style={styles.starterPanel}>
										<Text style={styles.starterTitle}>Start here</Text>
										<Text style={styles.starterBody}>
											Choose a starter or ask anything in your own words.
										</Text>
										<View style={styles.starterPromptList}>
											{QUICK_PROMPTS.map((prompt) => (
												<Pressable
													key={prompt}
													onPress={() => {
														runSelectionHaptic();
														void handleSend(prompt);
													}}
													disabled={busyAction === "drafting-reply"}
													style={({ pressed }) => [
														styles.starterPromptButton,
														pressed ? styles.buttonPressed : null,
													]}
												>
													<Text style={styles.starterPromptText}>{prompt}</Text>
												</Pressable>
											))}
										</View>
									</View>
								) : null}
								{isInstalling && !messages.length ? (
									<TypingBubble label="Loading model..." />
								) : null}
								{busyAction === "drafting-reply" &&
								!hasStreamingAssistantText ? (
									<TypingBubble label="Thinking on-device..." />
								) : null}
							</ScrollView>
						</View>

						<View style={styles.composerCard}>
							{selectedArtifact.supportsVision ? (
								<View style={styles.attachmentToolbar}>
									<Pressable
										onPress={() => void handlePickAttachment()}
										disabled={composerDisabled}
										accessibilityRole="button"
										accessibilityLabel="Add image from files"
										style={({ pressed }) => [
											styles.attachmentAction,
											composerDisabled ? styles.buttonDisabled : null,
											pressed ? styles.buttonPressed : null,
										]}
									>
										<Text style={styles.attachmentActionText}>Image</Text>
									</Pressable>
									<Pressable
										onPress={() => void handleCaptureAttachment()}
										disabled={composerDisabled}
										accessibilityRole="button"
										accessibilityLabel="Open camera for image attachment"
										style={({ pressed }) => [
											styles.attachmentAction,
											composerDisabled ? styles.buttonDisabled : null,
											pressed ? styles.buttonPressed : null,
										]}
									>
										<Text style={styles.attachmentActionText}>Camera</Text>
									</Pressable>
								</View>
							) : null}
							{composerAttachments.length ? (
								<View style={styles.composerAttachmentRow}>
									{composerAttachments.map((attachment) => (
										<AttachmentChip
											key={attachment.id}
											attachment={attachment}
											removable
											onRemove={() => setComposerAttachments([])}
										/>
									))}
								</View>
							) : null}
							<View style={styles.composerInputRow}>
								<TextInput
									value={composer}
									onChangeText={setComposer}
									placeholder={
										isInstalling
											? "Preparing model…"
											: `Ask ${featuredModelName} anything`
									}
									placeholderTextColor="#7C8799"
									accessibilityLabel="Message Folio"
									style={styles.composerInput}
									editable={!composerDisabled}
									autoCapitalize="sentences"
									autoCorrect
									keyboardAppearance="dark"
									returnKeyType={Platform.OS === "ios" ? "send" : "default"}
									textAlignVertical="top"
									multiline
								/>
								<Pressable
									onPress={() =>
										canStopGeneration
											? void handleInterruptGeneration()
											: void handleSend()
									}
									disabled={canStopGeneration ? false : !canSend}
									accessibilityRole="button"
									accessibilityLabel={
										canStopGeneration ? "Stop generation" : "Send message"
									}
									style={({ pressed }) => [
										styles.sendButton,
										!(canStopGeneration || canSend) && styles.buttonDisabled,
										canStopGeneration ? styles.stopButton : null,
										pressed ? styles.buttonPressed : null,
									]}
								>
									<Text style={styles.sendButtonText}>{sendButtonLabel}</Text>
								</Pressable>
							</View>
						</View>
					</View>
				)}
			</KeyboardAvoidingView>

			<FallbackPromptModal
				visible={fallbackOffer !== null}
				preferredBackendName={fallbackOffer?.preferredBackendName ?? ""}
				fallbackBackendName={fallbackOffer?.fallbackArtifact.backend ?? ""}
				modelName={featuredModelName}
				onAccept={() => {
					if (!fallbackOffer) return;
					runSelectionHaptic();
					setForcedFallbackArtifact(fallbackOffer.fallbackArtifact);
					setFallbackOffer(null);
					setHasStartedSetup(true);
					setSetupArtifact(selectedArtifact);
					setOnboardingStage("overview");
					setSetupAttemptKey((k) => k + 1);
					didCheckArtifactRef.current = false;
				}}
				onDecline={() => {
					runImpactHaptic("medium");
					setFallbackOffer(null);
					setForcedFallbackArtifact(null);
					setHasStartedSetup(false);
					setOnboardingStage("select-model");
					setSetupArtifact(null);
					setSession(null);
					setMessages([]);
					setErrorMessage(null);
					setInstallProgress({ phase: "checking-cache", progress: 0 });
					try {
						if (SETUP_STATE_FILE.exists) {
							SETUP_STATE_FILE.delete();
						}
					} catch {
						// ignore
					}
				}}
			/>
			<ModelPicker
				open={isModelPickerOpen}
				models={catalogModels}
				featuredArtifactId={featuredArtifact.id}
				selectedArtifactId={selectedArtifact.id}
				catalogErrorMessage={catalogErrorMessage}
				onClose={() => setIsModelPickerOpen(false)}
				onSelect={(artifactId) => {
					if (busyAction === "activating-model") {
						return;
					}
					setIsModelPickerOpen(false);
					if (
						artifactId === selectedArtifact.id &&
						session?.status === "ready"
					) {
						return;
					}
					lastSetupErrorRef.current = null;
					setForcedFallbackArtifact(null);
					setFallbackOffer(null);
					setSelectedArtifactId(artifactId);
					setSetupArtifact(null);
					setHasStartedSetup(true);
					setOnboardingStage("overview");
					setErrorMessage(null);
					setSetupAttemptKey((current) => current + 1);
					runImpactHaptic("light");
				}}
			/>
		</SafeAreaView>
	);
}

function FallbackPromptModal({
	visible,
	preferredBackendName,
	fallbackBackendName,
	modelName,
	onAccept,
	onDecline,
}: {
	visible: boolean;
	preferredBackendName: string;
	fallbackBackendName: string;
	modelName: string;
	onAccept: () => void;
	onDecline: () => void;
}) {
	const insets = useSafeAreaInsets();
	return (
		<Modal transparent visible={visible} animationType="fade">
			<View style={styles.modalBackdrop}>
				<Pressable style={StyleSheet.absoluteFill} onPress={onDecline} />
				<View
					style={[
						styles.modalSheet,
						{ marginTop: insets.top + 20, maxWidth: 420 },
					]}
				>
					<View style={styles.modalHeader}>
						<Text style={styles.modalTitle}>Switch to fallback?</Text>
						<Text style={styles.modalSubtitle}>
							{preferredBackendName} is not available for {modelName}, but a{" "}
							{fallbackBackendName} version was found on this device.
							{"\n\n"}
							{fallbackBackendName} is less efficient and may be slower or use
							more battery. You can also redownload the preferred version.
						</Text>
					</View>
					<Pressable
						onPress={onAccept}
						accessibilityRole="button"
						accessibilityLabel={`Continue with ${fallbackBackendName}`}
						style={({ pressed }) => [
							styles.primaryActionButton,
							pressed ? styles.buttonPressed : null,
						]}
					>
						<Text style={styles.primaryActionText}>
							Continue with {fallbackBackendName}
						</Text>
					</Pressable>
					<Pressable
						onPress={onDecline}
						accessibilityRole="button"
						accessibilityLabel="Redownload preferred model"
						style={({ pressed }) => [
							styles.secondaryActionButton,
							{ marginTop: 10 },
							pressed ? styles.buttonPressed : null,
						]}
					>
						<Text style={styles.secondaryActionText}>Redownload model</Text>
					</Pressable>
				</View>
			</View>
		</Modal>
	);
}

function ModelPicker({
	open,
	models,
	featuredArtifactId,
	catalogErrorMessage,
	selectedArtifactId,
	onClose,
	onSelect,
}: {
	open: boolean;
	models: ModelArtifactDescriptor[];
	featuredArtifactId: string;
	catalogErrorMessage: string | null;
	selectedArtifactId: string;
	onClose: () => void;
	onSelect: (artifactId: string) => void;
}) {
	const { width: screenWidth } = useWindowDimensions();
	const isTablet = screenWidth >= 680;
	const insets = useSafeAreaInsets();

	function isModelAvailable(model: ModelArtifactDescriptor): boolean {
		return model.artifacts.length > 0;
	}

	function isSelected(model: ModelArtifactDescriptor): boolean {
		return model.id === selectedArtifactId;
	}

	const CAPABILITY_LABELS: Record<string, string> = {
		fastStartup: "Fast",
		coding: "Code",
		vision: "Vision",
		longContext: "Long Ctx",
		math: "Math",
		reasoning: "Reasoning",
	};

	const sortedModels = [...models].sort((a, b) => {
		const aAvail = isModelAvailable(a) ? 1 : 0;
		const bAvail = isModelAvailable(b) ? 1 : 0;
		if (aAvail !== bAvail) return bAvail - aAvail;
		const aFeatured = a.id === featuredArtifactId ? 1 : 0;
		const bFeatured = b.id === featuredArtifactId ? 1 : 0;
		return bFeatured - aFeatured;
	});

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

					<ScrollView
						contentContainerStyle={styles.modalContent}
					>
						{catalogErrorMessage ? (
							<Text style={styles.modalErrorText}>{catalogErrorMessage}</Text>
						) : null}
						{sortedModels.map((model) => {
							const available = isModelAvailable(model);
							const selected = isSelected(model);
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
											{model.compatibleBackends.map((backend) => (
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
										</View>
										{model.capabilities?.length ? (
											<View style={styles.modelCapabilityRow}>
												{model.capabilities.slice(0, 3).map((cap) => (
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
const ChatBubble = memo(function ChatBubble({
	message,
	userMaxWidth,
	assistantMaxWidth,
	onRetry,
}: {
	message: ChatMessage;
	userMaxWidth: number;
	assistantMaxWidth: number;
	onRetry?: () => void;
}) {
	const isUser = message.role === "user";
	const entrance = useRef(new Animated.Value(0)).current;
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		Animated.timing(entrance, {
			toValue: 1,
			duration: 260,
			easing: Easing.out(Easing.poly(4)),
			useNativeDriver: true,
		}).start();
	}, [entrance]);

	useEffect(() => {
		if (!copied) return;
		const t = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(t);
	}, [copied]);

	const animatedStyle = {
		opacity: entrance,
		transform: [
			{
				translateY: entrance.interpolate({
					inputRange: [0, 1],
					outputRange: [12, 0],
				}),
			},
			{
				scale: entrance.interpolate({
					inputRange: [0, 1],
					outputRange: [0.98, 1],
				}),
			},
		],
	};

	function handleCopy() {
		if (!message.text) return;
		Clipboard.setString(message.text);
		setCopied(true);
		runImpactHaptic("soft");
	}

	return (
		<Animated.View
			style={[
				styles.messageRow,
				isUser ? styles.messageRowUser : styles.messageRowAssistant,
				{ maxWidth: isUser ? userMaxWidth : assistantMaxWidth },
				animatedStyle,
			]}
		>
			<Pressable
				onLongPress={!isUser ? handleCopy : undefined}
				delayLongPress={350}
				accessibilityRole="text"
				accessibilityLabel={
					isUser ? `You said: ${message.text}` : `Folio said: ${message.text}`
				}
			>
				<View
					style={[
						styles.messageBubble,
						isUser ? styles.userBubble : styles.assistantBubble,
					]}
				>
					{message.attachments?.length ? (
						<View style={styles.messageAttachmentRow}>
							{message.attachments.map((attachment) => (
								<AttachmentChip key={attachment.id} attachment={attachment} />
							))}
						</View>
					) : null}
					<MessageText text={message.text} isUser={isUser} />
					{message.meta ? (
						<Text style={styles.messageMeta}>{message.meta}</Text>
					) : null}
					{!isUser && message.failed && onRetry ? (
						<Pressable
							onPress={onRetry}
							accessibilityRole="button"
							accessibilityLabel="Retry generating this reply"
							style={({ pressed }) => [
								styles.retryButton,
								pressed ? styles.buttonPressed : null,
							]}
						>
							<Text style={styles.retryButtonText}>Retry</Text>
						</Pressable>
					) : null}
					{!isUser && copied ? (
						<Text style={styles.copyToast}>Copied</Text>
					) : null}
				</View>
			</Pressable>
		</Animated.View>
	);
});

function AttachmentChip({
	attachment,
	removable = false,
	onRemove,
}: {
	attachment: ChatAttachment;
	removable?: boolean;
	onRemove?: () => void;
}) {
	return (
		<View style={styles.attachmentChip}>
			<Image
				source={{ uri: attachment.localUri }}
				style={styles.attachmentChipThumbnail}
			/>
			<View style={styles.attachmentChipTextBlock}>
				<Text style={styles.attachmentChipTitle}>{attachment.name}</Text>
				<Text style={styles.attachmentChipMeta}>
					{attachment.source === "camera" ? "Camera capture" : "Uploaded file"}
					{attachment.width && attachment.height
						? ` • ${attachment.width}x${attachment.height}`
						: ""}
				</Text>
			</View>
			{removable ? (
				<Pressable
					onPress={() => {
						runSelectionHaptic();
						onRemove?.();
					}}
					accessibilityRole="button"
					accessibilityLabel={`Remove ${attachment.name}`}
					style={({ pressed }) => [pressed ? styles.buttonPressed : null]}
				>
					<Text style={styles.attachmentChipRemove}>Remove</Text>
				</Pressable>
			) : null}
		</View>
	);
}

function TypingBubble({ label }: { label: string }) {
	return (
		<View
			style={styles.messageRowAssistant}
			accessibilityRole="text"
			accessibilityLiveRegion="polite"
			accessibilityLabel={label}
		>
			<View style={[styles.messageBubble, styles.assistantBubble]}>
				<View style={styles.typingRow}>
					<TypingDots />
					<Text style={styles.typingText}>{label}</Text>
				</View>
			</View>
		</View>
	);
}

function MessageText({ text, isUser }: { text: string; isUser: boolean }) {
	const paragraphs = text
		.split(/\n{2,}/)
		.filter((paragraph) => paragraph.trim().length > 0);
	const content = paragraphs.length ? paragraphs : [text];

	return (
		<View style={styles.messageParagraphGroup}>
			{content.map((paragraph, index) => (
				<Text
					key={index}
					selectable={!isUser}
					style={[
						styles.messageText,
						isUser ? styles.userMessageText : styles.assistantMessageText,
						index < content.length - 1 ? styles.messageParagraph : null,
					]}
				>
					{paragraph}
				</Text>
			))}
		</View>
	);
}

function TypingDots() {
	const opacity1 = useRef(new Animated.Value(0.3)).current;
	const opacity2 = useRef(new Animated.Value(0.3)).current;
	const opacity3 = useRef(new Animated.Value(0.3)).current;
	const opacities = [opacity1, opacity2, opacity3];

	useEffect(() => {
		const loop = Animated.loop(
			Animated.stagger(
				180,
				opacities.map((opacity) =>
					Animated.sequence([
						Animated.timing(opacity, {
							toValue: 0.8,
							duration: 180,
							useNativeDriver: true,
						}),
						Animated.timing(opacity, {
							toValue: 0.3,
							duration: 180,
							useNativeDriver: true,
						}),
					]),
				),
			),
		);
		loop.start();
		return () => loop.stop();
	}, [opacities]);

	return (
		<View style={styles.typingDotsRow}>
			{opacities.map((opacity, index) => (
				<Animated.View
					key={index}
					style={[styles.typingDot, { opacity }]}
				/>
			))}
		</View>
	);
}

function StatusPill({
	label,
	tone,
}: {
	label: string;
	tone: "default" | "success" | "muted";
}) {
	return (
		<View
			style={[
				styles.statusPill,
				tone === "success" ? styles.statusPillSuccess : null,
				tone === "muted" ? styles.statusPillMuted : null,
			]}
			accessibilityRole="text"
			accessibilityLabel={`Status: ${label}`}
		>
			<Text
				style={[
					styles.statusPillText,
					tone === "success" ? styles.statusPillTextSuccess : null,
					tone === "muted" ? styles.statusPillTextMuted : null,
				]}
			>
				{label}
			</Text>
		</View>
	);
}

function buildReadyMessages(
	artifact: ModelArtifactDescriptor,
	backendId: string,
	telemetry: TelemetrySnapshot,
	preparedArtifact: PreparedArtifact,
): ChatMessage[] {
	const caps = artifact.capabilities ?? [];
	const capDescriptions = caps
		.slice(0, 3)
		.map((c) => c.charAt(0).toUpperCase() + c.slice(1))
		.join(", ");
	const capabilityLine =
		capDescriptions.length > 0
			? `This model can: ${capDescriptions}.`
			: "";

	const introLines = [
		`Chat with ${formatModelDisplayName(artifact)}. Ask for writing help, summaries, brainstorming, or anything else you want to do privately on-device.`,
		capabilityLine,
	]
		.filter(Boolean)
		.join(" ");

	return [
		createAssistantMessage(
			introLines,
			preparedArtifact.cacheState === "hit"
				? `Loaded instantly from device cache • ${formatRuntimeMeta(backendId, telemetry)}`
				: `Running locally now • ${formatRuntimeMeta(backendId, telemetry)}`,
		),
	];
}

function formatRuntimeMeta(
	backendId: string,
	telemetry: TelemetrySnapshot,
): string {
	return `${backendId.toUpperCase()} • ${telemetry.ttftMs}ms first token • ${telemetry.decodeTokensPerSecond.toFixed(1)} tok/s`;
}

function formatGenerationMeta(
	backendId: string,
	turnIndex: number,
	tokensGenerated: number,
	telemetry: TelemetrySnapshot,
	_artifactPath: string,
): string {
	return `${tokensGenerated} tokens • ${telemetry.ttftMs}ms first token • ${telemetry.decodeTokensPerSecond.toFixed(1)} tok/s`;
}

function stripSpecialTokens(text: string): string {
	return text
		.replace(/<\|[^|>]*\|>/g, "")
		.replace(/<(?:start_of_turn|end_of_turn|bos|eos)>/g, "")
		.replace(/<\|turn>/g, "")
		.replace(/<turn\|>/g, "")
		.replace(/\s+$/, "");
}

function createAssistantMessage(text: string, meta?: string): ChatMessage {
	return {
		id: createMessageId("assistant"),
		role: "assistant",
		text,
		meta,
	};
}

function createUserMessage(
	text: string,
	attachments: ChatAttachment[] = [],
): ChatMessage {
	return {
		id: createMessageId("user"),
		role: "user",
		text,
		attachments,
	};
}

function createMessageId(role: ChatMessage["role"]): string {
	return `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function upsertAssistantMessage(
	messages: ChatMessage[],
	nextMessage: Pick<
		ChatMessage,
		"id" | "text" | "meta" | "streaming" | "failed"
	>,
): ChatMessage[] {
	const resolvedMessage: ChatMessage = {
		id: nextMessage.id,
		role: "assistant",
		text: nextMessage.text,
		meta: nextMessage.meta,
		streaming: nextMessage.streaming,
		failed: nextMessage.failed,
	};
	const existingIndex = messages.findIndex(
		(message) => message.id === nextMessage.id,
	);

	if (existingIndex === -1) {
		return [...messages, resolvedMessage];
	}

	return messages.map((message, index) =>
		index === existingIndex ? resolvedMessage : message,
	);
}

function mapDocumentAttachment(
	asset: DocumentPicker.DocumentPickerAsset,
): ChatAttachment {
	return {
		id: `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		type: "image",
		name: asset.name,
		localUri: asset.uri,
		mimeType: asset.mimeType ?? "image/*",
		source: "file",
	};
}

function mapCameraAttachment(
	asset: ImagePicker.ImagePickerAsset,
): ChatAttachment {
	return {
		id: `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		type: "image",
		name: asset.fileName ?? `capture-${Date.now()}.jpg`,
		localUri: asset.uri,
		mimeType: asset.mimeType ?? "image/jpeg",
		source: "camera",
		width: asset.width,
		height: asset.height,
	};
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
	if (bytes <= 0) {
		return "0 B";
	}

	const units = ["B", "KB", "MB", "GB"];
	const unitIndex = Math.min(
		Math.floor(Math.log(bytes) / Math.log(1024)),
		units.length - 1,
	);
	const value = bytes / 1024 ** unitIndex;
	return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function resolveTransferRatio(
	transferredBytes?: number,
	totalBytes?: number | null,
): number {
	if (!totalBytes || totalBytes <= 0) {
		return 0;
	}

	return Math.min(Math.max((transferredBytes ?? 0) / totalBytes, 0), 1);
}

function ProgressBar({ progress }: { progress: number }) {
	const clampedProgress = Math.min(Math.max(progress, 0), 1);
	const animatedProgress = useRef(new Animated.Value(clampedProgress)).current;

	useEffect(() => {
		Animated.timing(animatedProgress, {
			toValue: clampedProgress,
			duration: 240,
			easing: Easing.out(Easing.cubic),
			useNativeDriver: false,
		}).start();
	}, [animatedProgress, clampedProgress]);

	const width = animatedProgress.interpolate({
		inputRange: [0, 1],
		outputRange: ["0%", "100%"],
	});

	return (
		<View style={styles.progressTrack}>
			<Animated.View style={[styles.progressFill, { width }]} />
		</View>
	);
}

const styles = StyleSheet.create({
	safeArea: {
		flex: 1,
		backgroundColor: COLORS.bgDeep,
	},
	keyboardView: {
		flex: 1,
		paddingHorizontal: 18,
		paddingBottom: 14,
	},
	chatShell: {
		flex: 1,
		gap: 10,
		minHeight: 0,
	},
	backgroundGlowTop: {
		position: "absolute",
		top: -80,
		right: -40,
		width: 220,
		height: 220,
		borderRadius: 999,
		backgroundColor: "rgba(212, 181, 137, 0.12)",
	},
	backgroundGlowBottom: {
		position: "absolute",
		bottom: 60,
		left: -60,
		width: 200,
		height: 200,
		borderRadius: 999,
		backgroundColor: "rgba(143, 158, 114, 0.12)",
	},
	header: {
		flexDirection: "row",
		alignItems: "flex-start",
		justifyContent: "space-between",
		gap: 12,
		paddingTop: 12,
	},
	brandBlock: {
		flex: 1,
		gap: 6,
	},
	brandEyebrow: {
		color: COLORS.accentMid,
		fontSize: 12,
		fontWeight: "700",
		letterSpacing: 1.2,
		textTransform: "uppercase",
	},
	brandSubtitle: {
		color: "#B8B0A2",
		fontSize: 14,
		lineHeight: 20,
	},
	buttonPressed: {
		opacity: 0.88,
		transform: [{ scale: 0.985 }],
	},
	buttonDisabled: {
		opacity: 0.45,
	},
	onboardingShell: {
		flex: 1,
	},
	onboardingScroll: {
		flex: 1,
	},
	onboardingScrollContent: {
		gap: 28,
		paddingTop: 8,
		paddingBottom: 24,
	},
	stageStack: {
		gap: 22,
		paddingBottom: 8,
	},
	selectionHero: {
		gap: 6,
		paddingTop: 4,
		paddingBottom: 2,
	},
	selectionIntro: {
		color: COLORS.textSecondary,
		fontSize: 14,
		lineHeight: 20,
		marginTop: 2,
	},
	selectionEyebrow: {
		color: COLORS.accentMid,
		fontSize: 12,
		fontWeight: "800",
		textTransform: "uppercase",
		letterSpacing: 1.1,
	},
	selectionTitle: {
		color: COLORS.textPrimary,
		fontSize: 34,
		fontWeight: "800",
		lineHeight: 40,
	},
	selectionCard: {
		gap: 12,
		borderRadius: 22,
		padding: 16,
	},
	selectionCardPrimary: {
		backgroundColor: COLORS.bgCardRich,
	},
	selectionCardHeader: {
		flexDirection: "row",
		alignItems: "flex-start",
		justifyContent: "space-between",
		gap: 10,
	},
	selectionCardTitle: {
		flex: 1,
		minWidth: 0,
		color: COLORS.textPrimary,
		fontSize: 22,
		fontWeight: "800",
		lineHeight: 27,
	},
	selectionCardMeta: {
		color: "#D8D0C4",
		fontSize: 14,
	},
	selectionCardFooter: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 10,
		paddingTop: 8,
	},
	selectionFooterMeta: {
		color: "#B3A793",
		fontSize: 12,
		fontWeight: "700",
	},
	selectionFooterAction: {
		color: COLORS.textPrimary,
		fontSize: 14,
		fontWeight: "800",
		flexShrink: 1,
	},
	infoStageHeader: {
		gap: 6,
	},
	infoStageMetaRow: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 12,
	},
	inlineActionText: {
		color: "#E7D7C0",
		fontSize: 13,
		fontWeight: "700",
	},
	setupProgressPanel: {
		gap: 12,
		padding: 16,
		borderRadius: 22,
		backgroundColor: "rgba(26, 23, 19, 0.94)",
	},
	setupProgressHeader: {
		flexDirection: "row",
		alignItems: "flex-start",
		justifyContent: "space-between",
		gap: 12,
	},
	setupProgressCopy: {
		flex: 1,
		gap: 2,
	},
	setupProgressEyebrow: {
		color: COLORS.accentWarm,
		fontSize: 11,
		fontWeight: "800",
		textTransform: "uppercase",
		letterSpacing: 1,
	},
	setupProgressTitleCompact: {
		color: COLORS.textPrimary,
		fontSize: 16,
		fontWeight: "800",
		lineHeight: 22,
	},
	setupProgressMetaCompact: {
		color: "#E7D7C0",
		fontSize: 12,
		fontWeight: "800",
	},
	setupProgressBody: {
		color: COLORS.textSecondary,
		fontSize: 12,
		lineHeight: 17,
		marginTop: 2,
	},
	dualActionRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
	},
	waitingHero: {
		gap: 6,
		paddingBottom: 2,
	},
	arcadeSection: {
		gap: 14,
	},
	wizardStepLabel: {
		color: COLORS.accentWarm,
		fontSize: 12,
		fontWeight: "700",
		textTransform: "uppercase",
		letterSpacing: 1.1,
	},
	quietNote: {
		color: "#BFB3A1",
		fontSize: 13,
		lineHeight: 19,
	},
	primaryActionButton: {
		backgroundColor: COLORS.accentPrimary,
		borderRadius: 999,
		paddingHorizontal: 16,
		paddingVertical: 14,
		alignItems: "center",
		justifyContent: "center",
		minWidth: 140,
	},
	primaryActionText: {
		color: "#231B14",
		fontSize: 15,
		fontWeight: "800",
	},
	secondaryActionButton: {
		alignSelf: "flex-start",
		backgroundColor: "rgba(231, 215, 192, 0.1)",
		borderRadius: 999,
		paddingHorizontal: 14,
		paddingVertical: 12,
		minWidth: 100,
		minHeight: 40,
		alignItems: "center",
		justifyContent: "center",
	},
	secondaryActionText: {
		color: COLORS.textPrimary,
		fontWeight: "700",
	},
	tradeoffRow: {
		gap: 2,
	},
	tradeoffLabel: {
		color: "#EFE7DB",
		fontSize: 13,
		fontWeight: "800",
	},
	tradeoffValue: {
		color: COLORS.textSecondary,
		fontSize: 13,
		lineHeight: 19,
	},
	inlineErrorCard: {
		gap: 10,
		backgroundColor: COLORS.errorBg,
		borderRadius: 18,
		padding: 14,
	},
	progressTrack: {
		width: "100%",
		height: 6,
		borderRadius: 999,
		overflow: "hidden",
		backgroundColor: "rgba(255, 248, 235, 0.06)",
	},
	progressFill: {
		height: "100%",
		borderRadius: 999,
		backgroundColor: COLORS.accentPrimary,
	},
	installStageRail: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 6,
	},
	installStageChip: {
		backgroundColor: COLORS.bgSubtleMid,
		borderRadius: 999,
		paddingHorizontal: 10,
		paddingVertical: 6,
	},
	installStageChipActive: {
		backgroundColor: COLORS.accentPrimary,
	},
	installStageChipDone: {
		backgroundColor: "rgba(199, 214, 161, 0.22)",
	},
	installStageChipText: {
		color: COLORS.textPrimary,
		fontSize: 11,
		fontWeight: "800",
	},
	installStageChipTextStrong: {
		color: "#2A211A",
	},
	chatTopBar: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 10,
		paddingTop: 8,
		paddingBottom: 4,
	},
	chatTopBarTitle: {
		color: COLORS.textPrimary,
		fontSize: 22,
		fontWeight: "800",
		letterSpacing: -0.2,
		flexShrink: 0,
	},
	chatModelButton: {
		flex: 1,
		minWidth: 0,
		backgroundColor: "#1B1815",
		borderRadius: 16,
		paddingHorizontal: 12,
		paddingVertical: 10,
		minHeight: 40,
		justifyContent: "center",
	},
	chatModelButtonText: {
		color: COLORS.textPrimary,
		fontSize: 13,
		fontWeight: "700",
	},
	chatNewChatButton: {
		backgroundColor: "rgba(231, 215, 192, 0.07)",
		borderRadius: 16,
		paddingHorizontal: 12,
		paddingVertical: 10,
		minHeight: 40,
		justifyContent: "center",
	},
	chatNewChatButtonText: {
		color: "#E7DED1",
		fontSize: 13,
		fontWeight: "800",
	},
	chatStatusRow: {
		flexDirection: "row",
		alignItems: "center",
		flexWrap: "wrap",
		gap: 6,
		paddingTop: 2,
	},
	modelSwitcherButton: {
		backgroundColor: "#1E1A16",
		borderColor: "rgba(215, 193, 162, 0.14)",
		borderWidth: 1,
		borderRadius: 18,
		paddingHorizontal: 14,
		paddingVertical: 12,
		minHeight: 44,
		gap: 1,
		justifyContent: "center",
	},
	modelSwitcherLabel: {
		color: COLORS.textSecondary,
		fontSize: 11,
		fontWeight: "700",
		textTransform: "uppercase",
		letterSpacing: 1,
	},
	modelSwitcherValue: {
		color: COLORS.textPrimary,
		fontSize: 14,
		fontWeight: "700",
		maxWidth: 160,
	},
	inlineNote: {
		color: "#BFB3A1",
		fontSize: 13,
		lineHeight: 19,
	},
	statusPill: {
		backgroundColor: COLORS.bgSubtleMid,
		borderRadius: 999,
		paddingHorizontal: 10,
		paddingVertical: 6,
	},
	statusPillSuccess: {
		backgroundColor: COLORS.successBg,
	},
	statusPillMuted: {
		backgroundColor: "rgba(255, 248, 235, 0.08)",
	},
	statusPillText: {
		color: "#E7DED1",
		fontSize: 11,
		fontWeight: "700",
	},
	statusPillTextSuccess: {
		color: COLORS.successText,
	},
	statusPillTextMuted: {
		color: "#C4BBAD",
	},
	errorText: {
		color: COLORS.errorText,
		fontSize: 12,
		lineHeight: 17,
	},
	chatCard: {
		flex: 1,
		minHeight: 0,
	},
	messagesScroll: {
		flex: 1,
	},
	messagesContent: {
		paddingTop: 4,
		paddingBottom: 14,
		gap: 12,
	},
	messagesContentGrow: {
		flexGrow: 1,
		justifyContent: "flex-end",
	},
	starterPanel: {
		gap: 6,
		paddingTop: 4,
	},
	starterTitle: {
		color: COLORS.textPrimary,
		fontSize: 18,
		fontWeight: "800",
	},
	starterBody: {
		color: COLORS.textSecondary,
		fontSize: 13,
		lineHeight: 19,
	},
	starterPromptList: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 8,
		marginTop: 6,
	},
	starterPromptButton: {
		backgroundColor: "#1B1915",
		borderRadius: 16,
		paddingHorizontal: 12,
		paddingVertical: 10,
	},
	starterPromptText: {
		color: "#E7DED1",
		fontSize: 13,
		lineHeight: 18,
		fontWeight: "600",
	},
	messageRow: {
		flexDirection: "row",
	},
	messageRowAssistant: {
		alignSelf: "flex-start",
		maxWidth: "96%",
	},
	messageRowUser: {
		alignSelf: "flex-end",
		maxWidth: "84%",
	},
	messageBubble: {
		borderRadius: 22,
		paddingHorizontal: 16,
		paddingVertical: 13,
		gap: 6,
	},
	assistantBubble: {
		backgroundColor: COLORS.bgCard,
	},
	userBubble: {
		backgroundColor: COLORS.accentPrimary,
	},
	messageText: {
		fontSize: 15,
		lineHeight: 21,
	},
	messageParagraphGroup: {
		gap: 8,
	},
	messageParagraph: {
		marginBottom: 0,
	},
	messageAttachmentRow: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 8,
	},
	assistantMessageText: {
		color: "#F0E8DC",
	},
	userMessageText: {
		color: COLORS.accentOnDark,
	},
	messageMeta: {
		color: "#9F9586",
		fontSize: 11,
		lineHeight: 15,
	},
	copyToast: {
		color: COLORS.accentMid,
		fontSize: 11,
		fontWeight: "700",
		marginTop: 2,
	},
	retryButton: {
		alignSelf: "flex-start",
		backgroundColor: "rgba(241, 157, 139, 0.15)",
		borderRadius: 999,
		paddingHorizontal: 12,
		paddingVertical: 7,
		marginTop: 4,
	},
	retryButtonText: {
		color: COLORS.errorText,
		fontSize: 13,
		fontWeight: "800",
	},
	typingRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
	},
	typingDotsRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 5,
		paddingLeft: 2,
	},
	typingDot: {
		width: 6,
		height: 6,
		borderRadius: 999,
		backgroundColor: "#9F9586",
	},
	typingText: {
		color: "#9F9586",
		fontSize: 13,
		lineHeight: 18,
	},
	composerCard: {
		gap: 10,
		backgroundColor: "rgba(26, 23, 19, 0.94)",
		borderRadius: 20,
		padding: 12,
	},
	attachmentToolbar: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 10,
	},
	attachmentAction: {
		backgroundColor: "rgba(231, 215, 192, 0.07)",
		borderRadius: 999,
		paddingHorizontal: 12,
		paddingVertical: 10,
		minHeight: 40,
		justifyContent: "center",
	},
	attachmentActionText: {
		color: "#EFE7DB",
		fontSize: 13,
		fontWeight: "700",
	},
	composerAttachmentRow: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 8,
	},
	composerInputRow: {
		flexDirection: "row",
		alignItems: "flex-end",
		gap: 12,
	},
	composerInput: {
		flex: 1,
		color: COLORS.textPrimary,
		fontSize: 15,
		maxHeight: 100,
		minHeight: 40,
		paddingHorizontal: 6,
		paddingVertical: 10,
	},
	sendButton: {
		backgroundColor: COLORS.accentPrimary,
		borderRadius: 18,
		paddingHorizontal: 16,
		paddingVertical: 12,
		minHeight: 40,
		justifyContent: "center",
	},
	stopButton: {
		backgroundColor: "#C8927C",
	},
	sendButtonText: {
		color: "#231B14",
		fontWeight: "800",
		fontSize: 14,
	},
	attachmentChip: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		backgroundColor: "rgba(231, 215, 192, 0.08)",
		borderRadius: 14,
		paddingHorizontal: 10,
		paddingVertical: 8,
	},
	attachmentChipThumbnail: {
		width: 38,
		height: 38,
		borderRadius: 10,
		backgroundColor: COLORS.bgSubtleMid,
	},
	attachmentChipTextBlock: {
		gap: 1,
		maxWidth: 200,
	},
	attachmentChipTitle: {
		color: COLORS.textPrimary,
		fontSize: 12,
		fontWeight: "700",
	},
	attachmentChipMeta: {
		color: "#B7AD9E",
		fontSize: 10,
	},
	attachmentChipRemove: {
		color: "#E7D7C0",
		fontSize: 12,
		fontWeight: "700",
	},
	modalBackdrop: {
		flex: 1,
		backgroundColor: "rgba(12, 10, 8, 0.76)",
		justifyContent: "flex-end",
	},
	modalBackdropTablet: {
		alignItems: "center",
		justifyContent: "center",
	},
	modalSheet: {
		maxHeight: "78%",
		backgroundColor: "#15120F",
		borderTopLeftRadius: 24,
		borderTopRightRadius: 24,
		paddingHorizontal: 18,
		paddingTop: 18,
		paddingBottom: 28,
		gap: 16,
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
	},
	modalTitle: {
		color: COLORS.textPrimary,
		fontSize: 22,
		fontWeight: "800",
	},
	modalSubtitle: {
		color: "#B8B0A2",
		fontSize: 14,
		lineHeight: 20,
		flexShrink: 1,
	},
	modalStatusText: {
		color: COLORS.accentWarm,
		fontSize: 13,
		lineHeight: 18,
	},
	modalContent: {
		gap: 12,
	},
	modalErrorText: {
		color: "#FCA5A5",
		fontSize: 13,
		lineHeight: 18,
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
	modelOptionAccent: {
		width: 4,
	},
	modelOptionAccentAvailable: {
		backgroundColor: COLORS.accentWarm,
	},
	modelOptionAccentSelected: {
		backgroundColor: COLORS.accentPrimary,
	},
	modelOptionAccentMuted: {
		backgroundColor: "rgba(215, 193, 162, 0.15)",
	},
	modelOptionContent: {
		flex: 1,
		padding: 14,
		gap: 8,
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
		color: COLORS.textPrimary,
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
		color: COLORS.accentMid,
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
		backgroundColor: COLORS.accentPrimary,
		alignItems: "center",
		justifyContent: "center",
	},
	modelCheckMark: {
		color: "#231B14",
		fontSize: 14,
		fontWeight: "800",
	},
	modelOptionActionText: {
		color: COLORS.accentWarm,
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
		color: COLORS.textSecondary,
		fontSize: 12,
		lineHeight: 17,
	},
});
