import React from "react";
import {
	KeyboardAvoidingView,
	Platform,
	StyleSheet,
	View,
	type ViewStyle,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { spacing } from "./colors.tsx";

interface LayoutShellProps {
	children: React.ReactNode;
	style?: ViewStyle;
}

const HORIZONTAL_PADDING = spacing.xl; // 24px

export function LayoutShell({ children, style }: LayoutShellProps) {
	const insets = useSafeAreaInsets();
	const topBuffer = Platform.OS === "ios" ? 14 : 10;
	const topInsetPadding = insets.top + topBuffer;
	const bottomInsetPadding = Math.max(14, insets.bottom + 10);

	return (
		<SafeAreaView style={styles.safeArea} edges={["left", "right"]}>
			<KeyboardAvoidingView
				style={[
					styles.keyboardView,
					{
						paddingTop: topInsetPadding,
						paddingBottom: bottomInsetPadding,
						paddingHorizontal: HORIZONTAL_PADDING,
					},
				]}
				behavior={Platform.OS === "ios" ? "padding" : undefined}
			>
				<View style={styles.backgroundGlowTop} />
				<View style={styles.backgroundGlowBottom} />
				<View style={[styles.content, style]}>{children}</View>
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	safeArea: {
		flex: 1,
	},
	keyboardView: {
		flex: 1,
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
	content: {
		flex: 1,
	},
});

export { spacing };