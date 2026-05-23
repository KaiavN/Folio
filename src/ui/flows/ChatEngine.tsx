import React, { useRef } from "react";
import {
	generateChatReply,
	interruptGeneration,
	resetSessionContext,
} from "../../engine/runtime.ts";
import { extractCalcToolCalls, stripCalcTags } from "../../engine/tools/math.ts";
import type {
	ChatAttachment,
	ChatGenerationChunk,
	ChatMessage,
	ModelArtifactDescriptor,
	PreparedArtifact,
	RoutingDecision,
	RuntimeInfo,
	SessionHandle,
	TelemetrySnapshot,
} from "../../engine/types.ts";
import {
	runImpactHaptic,
	runSelectionHaptic,
} from "../haptics.ts";

export interface ChatEngineState {
	messages: ChatMessage[];
	composer: string;
	composerAttachments: ChatAttachment[];
	busyAction: string | null;
	composerDisabled: boolean;
	selectedArtifact: ModelArtifactDescriptor;
	preparedArtifact: PreparedArtifact | null;
	session: SessionHandle | null;
	routingDecision: RoutingDecision;
	runtimeInfo: RuntimeInfo | null;
	telemetry: TelemetrySnapshot | null;
	selectedModelLabel: string;
}

export interface ChatEngineActions {
	setComposer: (text: string) => void;
	setComposerAttachments: (attachments: ChatAttachment[]) => void;
	setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
	setBusyAction: (action: string | null) => void;
	setErrorMessage: (error: string | null) => void;
	setTelemetry: (telemetry: TelemetrySnapshot | null) => void;
}

/**
 * Custom hook for chat message handling and AI generation.
 * Contains handleSend, handleInterruptGeneration, handleResetConversation, handleRetryMessage.
 */
export function useChatEngine(
	state: ChatEngineState,
	actions: ChatEngineActions,
) {
	const activeGenerationMessageIdRef = useRef<string | null>(null);
	const generationIdRef = useRef<number>(0);
	const messagesRef = useRef<ChatMessage[]>(state.messages);

	// Keep messagesRef in sync
	React.useEffect(() => {
		messagesRef.current = state.messages;
	}, [state.messages]);

	async function handleSend(
		promptOverride?: string,
		options?: {
			skipUserMessage?: boolean;
			reuseMessageId?: string;
			attachments?: ChatAttachment[];
		},
	) {
		const rawPrompt = (promptOverride ?? state.composer).trim();
		const attachments = options?.attachments ?? state.composerAttachments;
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
			actions.setComposer("");
			actions.setComposerAttachments([]);
			actions.setMessages((current) => [
				...current,
				createUserMessage(displayPrompt, attachments),
			]);
		}

		if (
			!state.routingDecision.selectedBackend ||
			!state.runtimeInfo ||
			!state.session ||
			state.session.status !== "ready"
		) {
			const notReadyText =
				"This preview shell is waiting for a live session before it can answer as the selected model.";
			if (options?.reuseMessageId) {
				actions.setMessages((current) =>
					upsertAssistantMessage(current, {
						id: streamingMessageId,
						text: notReadyText,
						meta: "Model not ready",
						streaming: false,
						failed: false,
					}),
				);
			} else {
				actions.setMessages((current) => [
					...current,
					createAssistantMessage(notReadyText, "Model not ready"),
				]);
			}
			return;
		}

		try {
			actions.setErrorMessage(null);
			actions.setBusyAction("drafting-reply");
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
				state.session.sessionId,
				modelPrompt,
				state.selectedModelLabel,
				{
					attachments,
					history,
					onChunk: (chunk: ChatGenerationChunk) => {
						if (
							activeGenerationMessageIdRef.current !== streamingMessageId ||
							generationIdRef.current !== thisGenerationId
						) {
							return;
						}
						const cleaned = stripCalcTags(chunk.accumulatedText);
						actions.setMessages((current) =>
							upsertAssistantMessage(current, {
								id: streamingMessageId,
								text: stripSpecialTokens(cleaned),
								meta: "Generating on-device...",
								streaming: true,
								failed: false,
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
			if (toolCalls.length > 0 && state.session?.status === "ready") {
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

				actions.setMessages((current) =>
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
					state.session.sessionId,
					`Calculator result: ${toolResults}`,
					state.selectedModelLabel,
					{
						attachments: [],
						history,
						onChunk: (chunk: ChatGenerationChunk) => {
							if (
								activeGenerationMessageIdRef.current !== streamingMessageId ||
								generationIdRef.current !== thisGenerationId
							) {
								return;
							}
							actions.setMessages((current) =>
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

			actions.setTelemetry(generation.telemetry);
			if (generation.finishReason === "completed") {
				runImpactHaptic("light");
			}
			actions.setMessages((current) =>
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
			actions.setErrorMessage(nextError);
			actions.setMessages((current) => {
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
			actions.setBusyAction(null);
		}
	}

	async function handleInterruptGeneration() {
		if (!state.session || state.busyAction !== "drafting-reply") {
			return;
		}

		runImpactHaptic("soft");
		try {
			await interruptGeneration(state.session.sessionId);
		} catch {
			// ignore interrupt errors — the generation will stop anyway
		}
	}

	async function handleResetConversation(onResetMessages: (messages: ChatMessage[]) => void) {
		if (!state.session) {
			return;
		}

		try {
			runSelectionHaptic();
			actions.setBusyAction("resetting-chat");
			actions.setErrorMessage(null);
			if (activeGenerationMessageIdRef.current) {
				await interruptGeneration(state.session.sessionId);
			}
			await resetSessionContext(state.session.sessionId);
			if (state.telemetry) {
				actions.setTelemetry(state.telemetry);
			}
			// Note: Welcome messages should be built by caller
		} catch (error) {
			actions.setErrorMessage(
				error instanceof Error ? error.message : "Failed to start a new chat.",
			);
		} finally {
			activeGenerationMessageIdRef.current = null;
			actions.setBusyAction(null);
		}
	}

	async function handleRetryMessage(
		failedMessageId: string,
		onSend: (prompt: string, options: { skipUserMessage: boolean; reuseMessageId: string; attachments?: ChatAttachment[] }) => void,
	) {
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

		actions.setMessages((current) =>
			current.map((m) =>
				m.id === failedMessageId
					? { ...m, failed: false, meta: "Retrying...", streaming: true }
					: m,
			),
		);
		onSend(userMessage.text, {
			skipUserMessage: true,
			reuseMessageId: failedMessageId,
			attachments: userMessage.attachments ?? [],
		});
	}

	return {
		handleSend,
		handleInterruptGeneration,
		handleResetConversation,
		handleRetryMessage,
	};
}

// Helper functions
export function createMessageId(role: ChatMessage["role"]): string {
	return `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createAssistantMessage(text: string, meta?: string): ChatMessage {
	return {
		id: createMessageId("assistant"),
		role: "assistant",
		text,
		meta,
	};
}

export function createUserMessage(
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

export function upsertAssistantMessage(
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

export function stripSpecialTokens(text: string): string {
	return text
		.replace(/<\|[^|>]*\|>/g, "")
		.replace(/<(?:start_of_turn|end_of_turn|bos|eos)>/g, "")
		.replace(/<\|turn>/g, "")
		.replace(/<turn\|>/g, "")
		.replace(/\s+$/, "");
}

function formatGenerationMeta(
	backendId: string,
	turnIndex: number,
	tokensGenerated: number,
	telemetry: TelemetrySnapshot,
): string {
	return `${tokensGenerated} tokens • ${telemetry.ttftMs ?? "?"}ms first token • ${telemetry.decodeTokensPerSecond?.toFixed(1) ?? "?"} tok/s`;
}