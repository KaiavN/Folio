import React, { memo, useEffect, useRef, useState } from "react";
import {
	Animated,
	Clipboard,
	Easing,
	Image,
	Pressable,
	StyleSheet,
	Text,
	View,
	AccessibilityInfo,
} from "react-native";

import type { ChatAttachment, ChatMessage } from "../engine/types.ts";
import { runImpactHaptic, runSelectionHaptic } from "./haptics.ts";
import { darkColors } from "./colors.tsx";
import { messageStyles } from "./styles/chatBubbleStyles.ts";

const COLORS = darkColors;

const MESSAGE_ENTRANCE_DURATION_MS = 260;
const TYPING_DOTS_STAGGER_MS = 180;
const SPRING_STIFFNESS = 180;
const SPRING_DAMPING = 12;

const buttonPressed = {
	opacity: 0.88,
	transform: [{ scale: 0.985 }],
};

// --- ChatBubble ---

export const ChatBubble = memo(function ChatBubble({
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
			duration: MESSAGE_ENTRANCE_DURATION_MS,
			easing: Easing.out(Easing.poly(4)),
			useNativeDriver: true,
		}).start();
	}, [entrance]);

	const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		if (!copied) return;
		if (copiedTimeoutRef.current) {
			clearTimeout(copiedTimeoutRef.current);
		}
		copiedTimeoutRef.current = setTimeout(() => {
			setCopied(false);
			copiedTimeoutRef.current = null;
		}, 1500);
		return () => {
			if (copiedTimeoutRef.current) {
				clearTimeout(copiedTimeoutRef.current);
				copiedTimeoutRef.current = null;
			}
		};
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
				messageStyles.messageRow,
				isUser ? messageStyles.messageRowUser : messageStyles.messageRowAssistant,
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
						messageStyles.messageBubble,
						isUser ? messageStyles.userBubble : messageStyles.assistantBubble,
					]}
				>
					{message.attachments?.length ? (
						<View style={messageStyles.messageAttachmentRow}>
							{message.attachments.map((attachment) => (
								<AttachmentChip key={attachment.id} attachment={attachment} />
							))}
						</View>
					) : null}
					<MessageText text={message.text} isUser={isUser} />
					{message.meta ? (
						<Text style={messageStyles.messageMeta}>{message.meta}</Text>
					) : null}
					{!isUser && message.failed && onRetry ? (
						<Pressable
							onPress={onRetry}
							accessibilityRole="button"
							accessibilityLabel="Retry generating this reply"
							style={({ pressed }) => [
								messageStyles.retryButton,
								pressed ? buttonPressed : null,
							]}
						>
							<Text style={messageStyles.retryButtonText}>Retry</Text>
						</Pressable>
					) : null}
					{!isUser && copied ? (
						<Text style={messageStyles.copyToast}>Copied</Text>
					) : null}
				</View>
			</Pressable>
		</Animated.View>
	);
});

// --- AttachmentChip ---

export function AttachmentChip({
	attachment,
	removable = false,
	onRemove,
}: {
	attachment: ChatAttachment;
	removable?: boolean;
	onRemove?: (id: string) => void;
}) {
	return (
		<View style={messageStyles.attachmentChip}>
			{attachment.type === "audio" ? (
				<View style={messageStyles.audioChipIcon}>
					<Text style={messageStyles.audioChipIconText}>~</Text>
				</View>
			) : (
				<Image
					source={{ uri: attachment.localUri }}
					style={messageStyles.attachmentChipThumbnail}
				/>
			)}
			<View style={messageStyles.attachmentChipTextBlock}>
				<Text style={messageStyles.attachmentChipTitle}>{attachment.name}</Text>
				<Text style={messageStyles.attachmentChipMeta}>
					{attachment.source === "camera"
						? "Camera capture"
						: attachment.source === "voice"
							? "Voice recording"
							: "Uploaded file"}
					{attachment.width && attachment.height
						? ` • ${attachment.width}x${attachment.height}`
						: ""}
				</Text>
			</View>
			{removable ? (
				<Pressable
					onPress={() => {
						runSelectionHaptic();
						onRemove?.(attachment.id);
					}}
					accessibilityRole="button"
					accessibilityLabel={`Remove ${attachment.name}`}
					style={({ pressed }) => [pressed ? buttonPressed : null]}
				>
					<Text style={messageStyles.attachmentChipRemove}>Remove</Text>
				</Pressable>
			) : null}
		</View>
	);
}

// --- TypingBubble ---

export function TypingBubble({ label }: { label: string }) {
	return (
		<View
			style={messageStyles.typingBubbleContainer}
			accessibilityRole="text"
			accessibilityLiveRegion="polite"
			accessibilityLabel={label}
		>
			<View style={messageStyles.typingRow}>
				<TypingDots />
				<Text style={messageStyles.typingText}>{label}</Text>
			</View>
		</View>
	);
}

// --- MessageText ---

export function MessageText({ text, isUser }: { text: string; isUser: boolean }) {
	const paragraphs = text
		.split(/\n{2,}/)
		.filter((paragraph) => paragraph.trim().length > 0);
	const content = paragraphs.length ? paragraphs : [text];

	return (
		<View style={messageStyles.messageParagraphGroup}>
			{content.map((paragraph, index) => (
				<Text
					key={index}
					selectable={false}
					style={[
						messageStyles.messageText,
						isUser ? messageStyles.userMessageText : messageStyles.assistantMessageText,
						index < content.length - 1 ? messageStyles.messageParagraph : null,
					]}
				>
					{paragraph}
				</Text>
			))}
		</View>
	);
}

// --- TypingDots ---

export function TypingDots() {
	const bounce1 = useRef(new Animated.Value(0)).current;
	const bounce2 = useRef(new Animated.Value(0)).current;
	const bounce3 = useRef(new Animated.Value(0)).current;

	useEffect(() => {
		const cancelled = { value: false };
		const loopRef = { current: null as Animated.CompositeAnimation | null };
		let pendingTimeout: ReturnType<typeof setTimeout> | null = null;

		function startAnimation() {
			AccessibilityInfo.isReduceMotionEnabled().then((isReduceMotionEnabled) => {
				if (cancelled.value || isReduceMotionEnabled) return;
				const loop = Animated.loop(
					Animated.stagger(
						TYPING_DOTS_STAGGER_MS,
						[bounce1, bounce2, bounce3].map((bounce) =>
							Animated.sequence([
								Animated.spring(bounce, {
									toValue: 1,
									damping: SPRING_DAMPING,
									stiffness: SPRING_STIFFNESS,
									useNativeDriver: true,
								}),
								Animated.spring(bounce, {
									toValue: 0,
									damping: SPRING_DAMPING,
									stiffness: SPRING_STIFFNESS,
									useNativeDriver: true,
								}),
							]),
						),
					),
				);
				loopRef.current = loop;
				loop.start();
			});
		}

		startAnimation();
		return () => {
			cancelled.value = true;
			loopRef.current?.stop();
			if (pendingTimeout) clearTimeout(pendingTimeout);
		};
	}, [bounce1, bounce2, bounce3]);

	return (
		<View style={messageStyles.typingDotsRow}>
			{[bounce1, bounce2, bounce3].map((bounce, index) => (
				<Animated.View
					key={index}
					style={[
						messageStyles.typingDot,
						{
							transform: [
								{
									translateY: bounce.interpolate({
										inputRange: [0, 1],
										outputRange: [0, -4],
									}),
								},
							],
						},
					]}
				/>
			))}
		</View>
	);
}

// --- StatusPill ---

export function StatusPill({
	label,
	tone,
}: {
	label: string;
	tone: "default" | "success" | "muted";
}) {
	return (
		<View
			style={[
				messageStyles.statusPill,
				tone === "success" ? messageStyles.statusPillSuccess : null,
				tone === "muted" ? messageStyles.statusPillMuted : null,
			]}
			accessibilityRole="text"
			accessibilityLabel={`Status: ${label}`}
		>
			<Text
				style={[
					messageStyles.statusPillText,
					tone === "success" ? messageStyles.statusPillTextSuccess : null,
					tone === "muted" ? messageStyles.statusPillTextMuted : null,
				]}
			>
				{label}
			</Text>
		</View>
	);
}

// --- Styles ---

// Re-export StatusPill for backwards compatibility
export { messageStyles };