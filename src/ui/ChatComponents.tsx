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
import { darkColors, elevation } from "./colors.tsx";

const COLORS = darkColors;

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
				stylesBubble.messageRow,
				isUser ? stylesBubble.messageRowUser : stylesBubble.messageRowAssistant,
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
						stylesBubble.messageBubble,
						isUser ? stylesBubble.userBubble : stylesBubble.assistantBubble,
					]}
				>
					{message.attachments?.length ? (
						<View style={stylesBubble.messageAttachmentRow}>
							{message.attachments.map((attachment) => (
								<AttachmentChip key={attachment.id} attachment={attachment} />
							))}
						</View>
					) : null}
					<MessageText text={message.text} isUser={isUser} />
					{message.meta ? (
						<Text style={stylesBubble.messageMeta}>{message.meta}</Text>
					) : null}
					{!isUser && message.failed && onRetry ? (
						<Pressable
							onPress={onRetry}
							accessibilityRole="button"
							accessibilityLabel="Retry generating this reply"
							style={({ pressed }) => [
								stylesBubble.retryButton,
								pressed ? buttonPressed : null,
							]}
						>
							<Text style={stylesBubble.retryButtonText}>Retry</Text>
						</Pressable>
					) : null}
					{!isUser && copied ? (
						<Text style={stylesBubble.copyToast}>Copied</Text>
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
	onRemove?: () => void;
}) {
	return (
		<View style={stylesBubble.attachmentChip}>
			<Image
				source={{ uri: attachment.localUri }}
				style={stylesBubble.attachmentChipThumbnail}
			/>
			<View style={stylesBubble.attachmentChipTextBlock}>
				<Text style={stylesBubble.attachmentChipTitle}>{attachment.name}</Text>
				<Text style={stylesBubble.attachmentChipMeta}>
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
					style={({ pressed }) => [pressed ? buttonPressed : null]}
				>
					<Text style={stylesBubble.attachmentChipRemove}>Remove</Text>
				</Pressable>
			) : null}
		</View>
	);
}

// --- TypingBubble ---

export function TypingBubble({ label }: { label: string }) {
	return (
		<View
			style={stylesBubble.typingBubbleContainer}
			accessibilityRole="text"
			accessibilityLiveRegion="polite"
			accessibilityLabel={label}
		>
			<View style={stylesBubble.typingRow}>
				<TypingDots />
				<Text style={stylesBubble.typingText}>{label}</Text>
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
		<View style={stylesBubble.messageParagraphGroup}>
			{content.map((paragraph, index) => (
				<Text
					key={index}
					selectable={false}
					style={[
						stylesBubble.messageText,
						isUser ? stylesBubble.userMessageText : stylesBubble.assistantMessageText,
						index < content.length - 1 ? stylesBubble.messageParagraph : null,
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
		let cancelled = false;
		let loop: Animated.CompositeAnimation | null = null;

		async function startAnimation() {
			const isReduceMotionEnabled = await AccessibilityInfo.isReduceMotionEnabled();
			if (cancelled) return;

			if (isReduceMotionEnabled) return;

			loop = Animated.loop(
				Animated.stagger(
					180,
					[bounce1, bounce2, bounce3].map((bounce) =>
						Animated.sequence([
							Animated.spring(bounce, {
								toValue: 1,
								damping: 12,
								stiffness: 180,
								useNativeDriver: true,
							}),
							Animated.spring(bounce, {
								toValue: 0,
								damping: 12,
								stiffness: 180,
								useNativeDriver: true,
							}),
						]),
					),
				),
			);
			loop.start();
		}

		startAnimation();
		return () => {
			cancelled = true;
			loop?.stop();
		};
	}, [bounce1, bounce2, bounce3]);

	return (
		<View style={stylesBubble.typingDotsRow}>
			{[bounce1, bounce2, bounce3].map((bounce, index) => (
				<Animated.View
					key={index}
					style={[
						stylesBubble.typingDot,
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
				stylesBubble.statusPill,
				tone === "success" ? stylesBubble.statusPillSuccess : null,
				tone === "muted" ? stylesBubble.statusPillMuted : null,
			]}
			accessibilityRole="text"
			accessibilityLabel={`Status: ${label}`}
		>
			<Text
				style={[
					stylesBubble.statusPillText,
					tone === "success" ? stylesBubble.statusPillTextSuccess : null,
					tone === "muted" ? stylesBubble.statusPillTextMuted : null,
				]}
			>
				{label}
			</Text>
		</View>
	);
}

// --- Styles ---

const stylesBubble = StyleSheet.create({
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
});