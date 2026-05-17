import React, { useCallback, useEffect, useRef } from "react";
import {
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";

import type { ChatAttachment } from "../../engine/types.ts";
import { runSelectionHaptic } from "../haptics.ts";
import {
	borderRadius,
	spacing,
	typography,
} from "../colors.tsx";
import {
	AttachmentChip,
	ChatBubble,
	TypingBubble,
} from "../ChatComponents.tsx";

// =============================================================================
// TYPES
// =============================================================================

type ChatMessage = {
	id: string;
	role: "assistant" | "user";
	text: string;
	attachments?: ChatAttachment[];
	meta?: string;
	streaming?: boolean;
	failed?: boolean;
};

// =============================================================================
// CONSTANTS
// =============================================================================

const QUICK_PROMPTS = [
	"Explain quantum entanglement in simple terms.",
	"Help me draft a concise email to my team.",
	"What are three unconventional ways to boost creativity?",
];

// =============================================================================
// PROPS
// =============================================================================

export type ChatScreenProps = {
	messages: ChatMessage[];
	composer: string;
	composerAttachments: ChatAttachment[];
	busyAction: string | null;
	composerDisabled: boolean;
	canSend: boolean;
	canStopGeneration: boolean;
	sendButtonLabel: string;
	featuredModelName: string;
	simulatorHint: string | null;
	isInstalling: boolean;
	hasUserMessages: boolean;
	hasStreamingAssistantText: boolean;
	userBubbleMaxWidth: number;
	assistantBubbleMaxWidth: number;
	onComposerChange: (text: string) => void;
	onSend: () => void;
	onStopGeneration: () => void;
	onRetryMessage: (failedMessageId: string) => void;
	onPickAttachment: () => void;
	onCaptureAttachment: () => void;
	onRemoveAttachment: (id: string) => void;
	onResetConversation: () => void;
	onOpenModelPicker: () => void;
	supportsVision: boolean;
};

// =============================================================================
// CHAT SCREEN
// =============================================================================

export function ChatScreen({
	messages,
	composer,
	composerAttachments,
	busyAction,
	composerDisabled,
	canSend,
	canStopGeneration,
	sendButtonLabel,
	featuredModelName,
	simulatorHint,
	isInstalling,
	hasUserMessages,
	hasStreamingAssistantText,
	userBubbleMaxWidth,
	assistantBubbleMaxWidth,
	onComposerChange,
	onSend,
	onStopGeneration,
	onRetryMessage,
	onPickAttachment,
	onCaptureAttachment,
	onRemoveAttachment,
	onResetConversation,
	onOpenModelPicker,
	supportsVision,
}: ChatScreenProps) {
	const messagesScrollRef = useRef<ScrollView | null>(null);

	// Auto-scroll when messages or busyAction changes
	useEffect(() => {
		const handle = setTimeout(() => {
			messagesScrollRef.current?.scrollToEnd({ animated: false });
		}, 40);
		return () => clearTimeout(handle);
	}, [isInstalling, messages]);

	// Memoized retry handler
	const handleRetry = useCallback(
		(messageId: string) => {
			void onRetryMessage(messageId);
		},
		[onRetryMessage],
	);

	// Memoized starter prompt handler
	const handleStarterPrompt = useCallback(
		(prompt: string) => {
			runSelectionHaptic();
			onComposerChange(prompt);
			// Small delay to let composer update before sending
			setTimeout(() => void onSend(), 10);
		},
		[onSend, onComposerChange],
	);

	
	return (
		<View style={styles.chatShell}>
			{/* Top bar */}
			<View style={styles.chatTopBar}>
				<Text style={styles.chatTopBarTitle}>Folio</Text>
				<Pressable
					onPress={onOpenModelPicker}
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
					onPress={() => void onResetConversation()}
					accessibilityRole="button"
					accessibilityLabel="Start a new chat"
					style={({ pressed }) => [
						styles.chatNewChatButton,
						pressed ? styles.buttonPressed : null,
					]}
				>
					<Text style={styles.chatNewChatButtonText}>New chat</Text>
				</Pressable>
			</View>

			{simulatorHint ? (
				<Text style={styles.inlineNote}>{simulatorHint}</Text>
			) : null}

			{/* Messages */}
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
									? () => handleRetry(message.id)
									: undefined
							}
						/>
					))}

					{/* Starter prompts for new conversation */}
					{!hasUserMessages ? (
						<View style={styles.starterPanel}>
							<Text style={styles.starterTitle}>Start here</Text>
							<Text style={styles.starterBody}>
								Choose a starter or ask anything in your own words.
							</Text>
							<View style={styles.starterPromptList}>
								{QUICK_PROMPTS.map((prompt) => (
									<Pressable
										key={prompt}
										onPress={() => handleStarterPrompt(prompt)}
										disabled={composerDisabled}
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

					{/* Loading states */}
					{isInstalling && !messages.length ? (
						<TypingBubble label="Loading model..." />
					) : null}
					{busyAction === "drafting-reply" && !hasStreamingAssistantText ? (
						<TypingBubble label="Thinking on-device..." />
					) : null}
				</ScrollView>
			</View>

			{/* Composer */}
			<View style={styles.composerCard}>
				{supportsVision ? (
					<View style={styles.attachmentToolbar}>
						<Pressable
							onPress={() => void onPickAttachment()}
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
							onPress={() => void onCaptureAttachment()}
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
								onRemove={onRemoveAttachment}
							/>
						))}
					</View>
				) : null}

				<View style={styles.composerInputRow}>
					<TextInput
						value={composer}
						onChangeText={onComposerChange}
						placeholder={
							isInstalling
								? "Preparing model..."
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
							canStopGeneration ? void onStopGeneration() : void onSend()
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
	);
}

// =============================================================================
// STYLES
// =============================================================================

const styles = StyleSheet.create({
	chatShell: {
		flex: 1,
		gap: spacing.sm,
		minHeight: 0,
	},
	chatTopBar: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		gap: spacing.sm,
		paddingTop: spacing.xs,
		paddingBottom: spacing.xxs,
	},
	chatTopBarTitle: {
		color: "#F6F1E8",
		fontSize: typography.title.fontSize,
		fontWeight: "800",
		letterSpacing: -0.2,
		flexShrink: 0,
	},
	chatModelButton: {
		flex: 1,
		minWidth: 0,
		backgroundColor: "#1B1713",
		borderRadius: borderRadius.md,
		paddingHorizontal: 12,
		paddingVertical: 10,
		minHeight: 40,
		justifyContent: "center",
	},
	chatModelButtonText: {
		color: "#F6F1E8",
		fontSize: 13,
		fontWeight: "700",
	},
	chatNewChatButton: {
		backgroundColor: "rgba(231, 215, 192, 0.07)",
		borderRadius: borderRadius.md,
		paddingHorizontal: 12,
		paddingVertical: 10,
		minHeight: 40,
		justifyContent: "center",
	},
	chatNewChatButtonText: {
		color: "#F6F1E8",
		fontSize: 13,
		fontWeight: "800",
	},
	chatCard: {
		flex: 1,
		minHeight: 0,
	},
	messagesScroll: {
		flex: 1,
	},
	messagesContent: {
		paddingTop: spacing.xxs,
		paddingBottom: spacing.sm,
		gap: spacing.sm,
	},
	messagesContentGrow: {
		flexGrow: 1,
		justifyContent: "flex-end",
	},
	starterPanel: {
		gap: spacing.xxs,
		paddingTop: spacing.xxs,
	},
	starterTitle: {
		color: "#F6F1E8",
		fontSize: 18,
		fontWeight: "800",
	},
	starterBody: {
		color: "#AFA597",
		fontSize: 13,
		lineHeight: 19,
	},
	starterPromptList: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: spacing.xs,
		marginTop: spacing.xxs,
	},
	starterPromptButton: {
		backgroundColor: "#1B1713",
		borderRadius: borderRadius.md,
		paddingHorizontal: 12,
		paddingVertical: 10,
	},
	starterPromptText: {
		color: "#F6F1E8",
		fontSize: 13,
		lineHeight: 18,
		fontWeight: "600",
	},
	composerCard: {
		gap: spacing.sm,
		backgroundColor: "rgba(26, 23, 19, 0.94)",
		borderRadius: borderRadius.lg,
		padding: 12,
	},
	attachmentToolbar: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: spacing.sm,
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
		color: "#F6F1E8",
		fontSize: 13,
		fontWeight: "700",
	},
	composerAttachmentRow: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: spacing.xs,
	},
	composerInputRow: {
		flexDirection: "row",
		alignItems: "flex-end",
		gap: spacing.sm,
	},
	composerInput: {
		flex: 1,
		color: "#F6F1E8",
		fontSize: 15,
		maxHeight: 100,
		minHeight: 40,
		paddingHorizontal: 6,
		paddingVertical: 10,
	},
	sendButton: {
		backgroundColor: "#E7D7C0",
		borderRadius: 18,
		paddingHorizontal: 16,
		paddingVertical: 12,
		minHeight: 40,
		justifyContent: "center",
	},
	stopButton: {
		backgroundColor: "#F1B7A9",
	},
	sendButtonText: {
		color: "#2A211A",
		fontWeight: "800",
		fontSize: 14,
	},
	buttonPressed: {
		opacity: 0.88,
		transform: [{ scale: 0.985 }],
	},
	buttonDisabled: {
		opacity: 0.45,
	},
	inlineNote: {
		color: "#AFA597",
		fontSize: 13,
		lineHeight: 19,
	},
});