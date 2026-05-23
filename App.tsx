import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { StatusBar } from "expo-status-bar";
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	Animated,
	AppState,
	AccessibilityInfo,
	Clipboard,
	Easing,
	KeyboardAvoidingView,
	Modal,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
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

const ANIMATION_DURATION_MS = 300;
const MODEL_ACTIVATION_TIMEOUT_MS = 3 * 60 * 1000;
const MODEL_PREPARE_TIMEOUT_MS = 2 * 60 * 1000;
const AUTO_SCROLL_DELAY_MS = 4000;
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
	startSpeechRecognition,
	stopSpeechRecognition,
	cancelSpeechRecognition,
} from "./src/engine/speech.ts";
import type { SpeechRecognitionState } from "./src/engine/types.ts";
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
	ChatMessage,
	ModelArtifactDescriptor,
	PreparedArtifact,
	RoutingDecision,
	RuntimeInfo,
	SessionHandle,
	SessionRuntimeOptions,
	TelemetrySnapshot,
} from "./src/engine/types.ts";
import { appStyles } from "./src/ui/App.styles.ts";
import { messageStyles } from "./src/ui/styles/chatBubbleStyles.ts";
import {
	runImpactHaptic,
	runNotificationHaptic,
	runSelectionHaptic,
} from "./src/ui/haptics.ts";
import { ErrorBoundary } from "./src/ui/ErrorBoundary.tsx";
import { SetupArcade } from "./src/ui/SetupArcade.tsx";
import { ColorsProvider, darkColors, elevation } from "./src/ui/colors.tsx";
import { ModelPicker } from "./src/ui/ModelPicker.tsx";
import SetupProgressPanel from "./src/ui/SetupProgressPanel.tsx";
import { ModelSelectionCard } from "./src/ui/ModelSelectionCard.tsx";
import { OnboardingHero } from "./src/ui/OnboardingHero.tsx";
import { ChatScreen } from "./src/ui/screens/ChatScreen.tsx";

const COLORS = darkColors;


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
	const generationIdRef = useRef<number>(0);
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
	useEffect(() => {
		messagesRef.current = messages;
	}, [messages]);
	const [speechState, setSpeechState] = useState<SpeechRecognitionState>({
		status: "idle",
		partialTranscription: "",
		error: null,
	});

	const liveSelectedArtifact = useMemo(
		() =>
			catalogModels.find(
				(artifact: ModelArtifactDescriptor) => artifact.id === selectedArtifactId,
			) ??
			MODEL_ARTIFACTS.find(
				(artifact: ModelArtifactDescriptor) => artifact.id === FEATURED_MODEL_ID,
			) ??
			catalogModels[0] ??
			MODEL_ARTIFACTS[0],
		[catalogModels, selectedArtifactId],
	);
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
				didCheckArtifactRef.current = false;
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
				duration: ANIMATION_DURATION_MS,
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
		availableBackends,
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
			isPrewarmingRef.current = false;
		};
	}, [session?.sessionId, session?.status, hasStartedSetup]);

	useEffect(() => {
		if (Platform.OS === "web") return;
		if (!hasStartedSetup || !runtimeInfo) return;
		if (!catalogModels.length) return;
		if (session?.status === "ready") return;
		if (fallbackOffer) return;
		if (busyAction === "activating-model") return;
		if (didCheckArtifactRef.current) return;

		
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
				didCheckArtifactRef.current = true;
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
				const candidateCached = candidateManifest ? inspectPreparedArtifact(candidateManifest) : null;
								if (
					candidateManifest &&
					candidateCached?.cacheState === "hit"
				) {
					setFallbackOffer({
						preferredBackendName: routingDecision.selectedArtifact.backend,
						fallbackArtifact: candidate,
					});
					didCheckArtifactRef.current = true;
					return;
				}
			}
			if (hadPriorSetup || onboardingStage === "chat") {
				resetToOnboarding();
			}
			didCheckArtifactRef.current = true;
			return;
		}

		// routingDecision.selectedArtifact is null — don't set ref guard yet,
		// as a future run with a resolved artifact needs to proceed
		const candidates = getAvailableArtifactCandidates(
			selectedArtifact,
			previewDevice,
			availableBackends,
		);
		const preferredBackend =
			previewDevice.preferredBackends[0] ?? candidates[0]?.backend;

		for (const candidate of candidates) {
			const manifest = buildArtifactManifest(selectedArtifact, candidate);
			const cached = manifest ? inspectPreparedArtifact(manifest) : null;
						if (manifest && cached?.cacheState === "hit") {
				setFallbackOffer({
					preferredBackendName: preferredBackend ?? candidate.backend,
					fallbackArtifact: candidate,
				});
				didCheckArtifactRef.current = true;
				return;
			}
		}

		if (hadPriorSetup || onboardingStage === "chat") {
			resetToOnboarding();
		}
		// Only set guard when routing is still null after exhausting candidates
		// — a future pass with resolved routing will proceed normally
		didCheckArtifactRef.current = true;
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
		let watchdogTimer2: ReturnType<typeof setTimeout> | null = null;

		function clearWatchdog() {
			if (watchdogTimer) {
				clearTimeout(watchdogTimer);
				watchdogTimer = null;
			}
			if (watchdogTimer2) {
				clearTimeout(watchdogTimer2);
				watchdogTimer2 = null;
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
					watchdogTimer2 = setTimeout(
						() => {
							if (cancelled) return;
							setErrorMessage(
								"Model setup timed out. Please check your connection and try again.",
							);
							setBusyAction(null);
						},
						MODEL_ACTIVATION_TIMEOUT_MS,
					);
				},
				MODEL_PREPARE_TIMEOUT_MS,
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

			if (!catalogModels.length) {
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
					buildWelcomeMessages(
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
			const thisGenerationId = (generationIdRef.current ?? 0) + 1;
			generationIdRef.current = thisGenerationId;
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
						if (generationIdRef.current !== thisGenerationId) {
							return;
						}
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
			if (
				activeGenerationMessageIdRef.current !== streamingMessageId ||
				generationIdRef.current !== thisGenerationId
			) {
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
						failed: false,
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
							if (generationIdRef.current !== thisGenerationId) {
								return;
							}
							if (activeGenerationMessageIdRef.current !== streamingMessageId) {
								return;
							}
							setMessages((current) =>
								upsertAssistantMessage(current, {
									id: streamingMessageId,
									text: stripSpecialTokens(chunk.accumulatedText),
									meta: "Generating on-device...",
									streaming: true,
									failed: false,
								}),
							);
						},
					},
				);
			}

			if (
				activeGenerationMessageIdRef.current !== streamingMessageId ||
				generationIdRef.current !== thisGenerationId
			) {
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
								)}`
							: formatGenerationMeta(
									generation.backendId,
									generation.turnIndex,
									generation.tokensGenerated,
									generation.telemetry,
								),
					streaming: false,
					failed: false,
				}),
			);
		} catch (error) {
			if (
				activeGenerationMessageIdRef.current !== streamingMessageId
			) {
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
				buildWelcomeMessages(
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

	async function handleStartRecording() {
		if (busyAction) return;
		runImpactHaptic("light");
		setSpeechState({ status: "recognizing", partialTranscription: "", error: null });
		try {
			await startSpeechRecognition({
				locale: "en-US",
				onResult: (result) => {
					setSpeechState((prev) => ({
						...prev,
						partialTranscription: result.transcription,
						status: "recognizing",
					}));
				},
				onError: (error) => {
					setSpeechState((prev) => ({
						...prev,
						status: "error",
						error,
					}));
				},
			});
		} catch {
			setSpeechState({ status: "idle", partialTranscription: "", error: null });
		}
	}

	async function handleStopRecording() {
		setSpeechState((prev) => ({ ...prev, status: "processing" }));
		const transcription = await stopSpeechRecognition();
		setSpeechState({ status: "idle", partialTranscription: "", error: null });
		if (transcription) {
			setComposer((prev) => prev + transcription);
		}
	}

	function handleCancelRecording() {
		cancelSpeechRecognition();
		setSpeechState({ status: "idle", partialTranscription: "", error: null });
	}

	// Auto-clear speech error after 4 seconds
	useEffect(() => {
		if (speechState.error) {
			const timer = setTimeout(() => {
				setSpeechState((prev) =>
					prev.status === "error" ? { ...prev, status: "idle", error: null } : prev,
				);
			}, AUTO_SCROLL_DELAY_MS);
			return () => clearTimeout(timer);
		}
	}, [speechState.error]);

	// Cleanup speech state if component unmounts while recording
	useEffect(() => {
		return () => {
			if (speechState.status === "recognizing" || speechState.status === "processing") {
				cancelSpeechRecognition();
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

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
	const hasUserMessages = useMemo(
		() => messages.some((message) => message.role === "user"),
		[messages],
	);
	const hasStreamingAssistantText = useMemo(
		() =>
			messages.some(
				(message) =>
					message.role === "assistant" &&
					message.streaming &&
					message.text.trim().length > 0,
			),
		[messages],
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

	const resolveArtifactDescriptor = useCallback(
		(artifactId: string): ModelArtifactDescriptor | null => (
			catalogModels.find((artifact) => artifact.id === artifactId) ??
			MODEL_ARTIFACTS.find((artifact) => artifact.id === artifactId) ??
			null
		),
		[catalogModels],
	);

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
					<Text style={styles.secondaryActionText}>Try again</Text>
				</Pressable>
			</View>
		);
	}

	function renderOnboardingContent() {
		if (!hasStartedSetup) {
			return (
				<View style={styles.stageStack}>
					<OnboardingHero
						eyebrow="Private AI on your phone"
						title="Choose your model"
						intro={selectionIntroCopy}
					/>

					<ModelSelectionCard
						modelName={featuredModelName}
						sizeLabel={featuredArtifact.sizeLabel}
						estimatedSizeGb={featuredArtifact.estimatedSizeGb}
						isInstalled={isArtifactInstalled}
						footerMeta={selectionFooterMeta}
						onSelect={startFeaturedSetup}
					/>

					{catalogLoading && !catalogErrorMessage ? (
						<Text style={styles.inlineNote}>Loading available models...</Text>
					) : null}
					{catalogErrorMessage ? (
						<Text style={styles.inlineNote}>{catalogErrorMessage}</Text>
					) : null}
					{!catalogLoading && !catalogModels.length && !catalogErrorMessage ? (
						<Text style={styles.inlineNote}>No models available</Text>
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

					<SetupProgressPanel
						installProgress={installProgress}
						session={session}
						manifest={featuredArtifact}
						featuredModelName={featuredModelName}
						installedArtifact={installedArtifact}
						busyAction={busyAction}
						isRuntimeBootstrapping={isRuntimeBootstrapping}
					/>

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

				<SetupProgressPanel
						installProgress={installProgress}
						session={session}
						manifest={featuredArtifact}
						featuredModelName={featuredModelName}
						installedArtifact={installedArtifact}
						busyAction={busyAction}
						isRuntimeBootstrapping={isRuntimeBootstrapping}
					/>

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
		<ErrorBoundary>
		<ColorsProvider>
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
					<ChatScreen
						messages={messages}
						composer={composer}
						composerAttachments={composerAttachments}
						busyAction={busyAction}
						composerDisabled={composerDisabled}
						canSend={canSend}
						canStopGeneration={canStopGeneration}
						sendButtonLabel={sendButtonLabel}
						featuredModelName={featuredModelName}
						simulatorHint={simulatorHint}
						isInstalling={isInstalling}
						hasUserMessages={hasUserMessages}
						hasStreamingAssistantText={hasStreamingAssistantText}
						userBubbleMaxWidth={userBubbleMaxWidth}
						assistantBubbleMaxWidth={assistantBubbleMaxWidth}
						onComposerChange={setComposer}
						onSend={() => void handleSend()}
						onStopGeneration={() => void handleInterruptGeneration()}
						onRetryMessage={handleRetryMessage}
						onPickAttachment={handlePickAttachment}
						onCaptureAttachment={handleCaptureAttachment}
						onRemoveAttachment={(id) => setComposerAttachments([])}
						onResetConversation={handleResetConversation}
						onOpenModelPicker={() => {
							runSelectionHaptic();
							setIsModelPickerOpen(true);
						}}
						supportsVision={selectedArtifact.supportsVision}
						speechState={speechState}
						onStartRecording={handleStartRecording}
						onStopRecording={handleStopRecording}
						onCancelRecording={handleCancelRecording}
					/>
				)}
			</KeyboardAvoidingView>

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
		</SafeAreaView>
		</ColorsProvider>
		</ErrorBoundary>
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
				<View
					style={[
						styles.modalSheet,
						{
							marginTop: insets.top + 20,
							marginBottom: insets.bottom + 20,
							maxWidth: 420,
						},
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

function buildWelcomeMessages(
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
	return `${backendId.toUpperCase()} • ${telemetry.ttftMs ?? "?"}ms first token • ${telemetry.decodeTokensPerSecond?.toFixed(1) ?? "?"} tok/s`;
}

function formatGenerationMeta(
	backendId: string,
	turnIndex: number,
	tokensGenerated: number,
	telemetry: TelemetrySnapshot,
): string {
	return `${tokensGenerated} tokens • ${telemetry.ttftMs}ms first token • ${telemetry.decodeTokensPerSecond?.toFixed(1) ?? "?"} tok/s`;
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
		color: COLORS.textTertiary,
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
		color: COLORS.textSecondary,
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
		color: COLORS.textTertiary,
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
		color: COLORS.accentPrimary,
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
		color: COLORS.accentPrimary,
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
		color: COLORS.textSecondary,
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
		color: COLORS.chipTextOnAccent,
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
		color: COLORS.textPrimary,
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
		color: COLORS.chipTextOnAccent,
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
		backgroundColor: COLORS.bgCard,
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
		color: COLORS.textPrimary,
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
		backgroundColor: COLORS.border,
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
		color: COLORS.textSecondary,
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
		color: COLORS.textPrimary,
		fontSize: 11,
		fontWeight: "700",
	},
	statusPillTextSuccess: {
		color: COLORS.successText,
	},
	statusPillTextMuted: {
		color: COLORS.textTertiary,
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
		backgroundColor: COLORS.bgCard,
		borderRadius: 16,
		paddingHorizontal: 12,
		paddingVertical: 10,
	},
	starterPromptText: {
		color: COLORS.textPrimary,
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
		color: COLORS.accentOnDark,
	},
	userMessageText: {
		color: COLORS.accentOnDark,
	},
	messageMeta: {
		color: COLORS.textTertiary,
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
		gap: 6,
	},
	typingDot: {
		width: 8,
		height: 8,
		borderRadius: 999,
		backgroundColor: COLORS.textTertiary,
	},
	typingBubbleContainer: {
		backgroundColor: COLORS.bgCard,
		borderRadius: 24,
		padding: 16,
		...elevation.medium,
	},
	typingText: {
		color: COLORS.textTertiary,
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
		color: COLORS.textPrimary,
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
		backgroundColor: COLORS.errorText,
	},
	sendButtonText: {
		color: COLORS.chipTextOnAccent,
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
		color: COLORS.textTertiary,
		fontSize: 10,
	},
	attachmentChipRemove: {
		color: COLORS.accentPrimary,
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
		backgroundColor: COLORS.bgDeep,
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
		color: COLORS.textTertiary,
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
		color: COLORS.errorText,
		fontSize: 13,
		lineHeight: 18,
	},
	modelOption: {
		flexDirection: "row",
		backgroundColor: COLORS.bgCard,
		borderRadius: 18,
		overflow: "hidden",
	},
	modelOptionSelected: {
		backgroundColor: COLORS.bgCardRich,
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
		color: COLORS.textTertiary,
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
		color: COLORS.chipTextOnAccent,
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
		color: COLORS.textTertiary,
		fontSize: 11,
		fontWeight: "700",
		textTransform: "uppercase",
		letterSpacing: 0.5,
	},
	modelBackendChipTextSelected: {
		color: COLORS.textPrimary,
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
		color: COLORS.accentLime,
		fontSize: 11,
		fontWeight: "700",
	},
	modelOptionNote: {
		color: COLORS.textSecondary,
		fontSize: 12,
		lineHeight: 17,
	},
});
